import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitBytes } from "./git-snapshot.js";
import { gitAncestor, gitRevision } from "./refs.js";
import { checkFinalizationCheckouts, finalizationBranch, finalizationCheckouts } from "./finalization-refs.js";
import { finalizationPlan, finalizeHistory, preparedFinalization } from "./finalization.js";
import { repositoryStatePath } from "./repository-state.js";
import { distributionRoot } from "../projects/project-context.js";
import { gitEnvironment } from "../distribution/update-git.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { record, string, strings } from "../runtime/values.mjs";
import { BoundedState } from "../storage/bounded-state.js";
import {
  CacheBusy,
  CacheLockState,
  inspectCacheMetadataLock,
  recoverCacheMetadataLock,
  withCacheLockSync,
} from "../storage/cache-lock.js";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../diagnostics/diagnostics.mjs";
import { readTaskGraph } from "../tasks/task-model.js";
import { readTaskDecisions } from "../tasks/task-decisions.js";
import { acceptedTaskVersion, treeTasks } from "../tasks/task-snapshot.js";
import { checkPolicyCompatibility } from "../collections/policy-compatibility.js";
import { reviewStatus, ReviewSource } from "../review/review-service.js";

export const finalizationCommand = "finalization-run";
const requestDirectory = "finalization-requests";
interface Request {
  version: 1;
  branch: string;
  generation: string;
  tasks: string[];
  waiting?: string;
}

function requestBranch(root: string): string | undefined {
  const attached = finalizationBranch(root);
  if (attached) return attached;
  const metadata = gitBytes(root, ["rev-parse", "--absolute-git-dir"]).toString().trim();
  for (const operation of ["rebase-merge", "rebase-apply"]) {
    const path = join(metadata, operation, "head-name");
    if (!existsSync(path)) continue;
    const branch = readBoundedFile(path, 4096, "rebase branch").toString().trim();
    if (branch.startsWith("refs/heads/") && gitRevision(root, branch)) return branch;
  }
  return undefined;
}

function requestState(root: string, branch: string) {
  const key = createHash("sha256").update(branch).digest("hex"),
    path = repositoryStatePath(root, requestDirectory, `${key}.json`);
  const store = new BoundedState<Request | undefined>(
    () => path,
    16 * 1024,
    (value) => {
      if (value === undefined) return undefined;
      const data = record(value, "Invalid pending finalization"),
        generation = string(data.generation, "Missing finalization generation"),
        tasks = strings(data.tasks, "Invalid pending finalization tasks");
      if (
        data.version !== 1 ||
        data.branch !== branch ||
        !/^[a-f0-9-]{36}$/.test(generation) ||
        tasks.length > 512 ||
        tasks.some((task) => !/^[a-z][a-z0-9_-]*:TSK-[0-9A-Z]+$/.test(task)) ||
        (data.waiting !== undefined && typeof data.waiting !== "string")
      )
        throw new InvalidInput("Invalid pending finalization");
      return {
        version: 1,
        branch,
        generation,
        tasks,
        ...(data.waiting === undefined ? {} : { waiting: data.waiting }),
      };
    },
    () => undefined,
  );
  return { path, store };
}

/** Record a handoff separately from any prepared Git rewrite, so acceptance remains usable after an interruption. */
function withRequestLock<T>(path: string, action: () => T, wait: number): T {
  const lock = inspectCacheMetadataLock(path);
  if (lock.state === CacheLockState.Abandoned) recoverCacheMetadataLock(path, { expected: lock.digest });
  return withCacheLockSync(path, action, wait);
}

interface FinalizationTrigger {
  tasks?: string[];
  revision?: string;
}
export function queueFinalization(root: string, { tasks = [], revision }: FinalizationTrigger = {}) {
  const branch = requestBranch(root),
    selected = revision && gitRevision(root, `${revision}^{commit}`);
  if (revision && !selected) throw new StateConflict("The reviewed commit is unavailable locally");
  const branches =
    selected && (!branch || !gitAncestor(root, selected, branch))
      ? gitBytes(root, ["for-each-ref", "--format=%(refname)", `--contains=${selected}`, "refs/heads"])
          .toString()
          .trim()
          .split("\n")
          .filter(Boolean)
      : branch
        ? [branch]
        : [];
  return branches.filter((target) => {
    if (!gitRevision(root, target)) return false;
    const { path, store } = requestState(root, target);
    withRequestLock(
      path,
      () => {
        const previous = store.read();
        store.write({
          version: 1,
          branch: target,
          generation: randomUUID(),
          tasks: [...new Set([...(previous?.tasks ?? []), ...tasks])],
        });
      },
      250,
    );
    return true;
  });
}

export function pendingFinalizationStatus(root: string): string | undefined {
  if (!existsSync(repositoryStatePath(root, requestDirectory))) return undefined;
  const branch = requestBranch(root);
  if (!branch) return undefined;
  const request = requestState(root, branch).store.read();
  return request && (request.waiting ?? "Waiting to inspect reviewed history");
}

function deferred(root: string, error: unknown): void {
  diagnostic(
    LogLevel.Warn,
    DiagnosticOperation.Command,
    DiagnosticOutcome.Degraded,
    { command: finalizationCommand, root },
    error,
    "Automatic finalization is pending",
  );
}

function waitingForDelivery(root: string, tasks: string[], tip: string): boolean {
  if (!tasks.length) return false;
  const working = readTaskGraph(root).byReference,
    retained = treeTasks(root, tip),
    decisions = readTaskDecisions(root);
  return tasks.some((reference) => {
    const task = working.get(reference),
      source = retained.get(reference);
    if (
      task?.metadata.status !== "Accepted" ||
      (source?.status === "Accepted" && source.outcome() === task.reviewDigest)
    )
      return false;
    return decisions.some(
      (decision) =>
        decision.reference === reference &&
        decision.status === "Accepted" &&
        decision.digest === task.digest &&
        acceptedTaskVersion(root, decision) === task.reviewDigest,
    );
  });
}

/** Recompute all authority for the current branch. The handoff is a wake request, never approval evidence. */
export function resumeFinalization(root: string): void {
  const branch = finalizationBranch(root);
  if (!branch) return;
  const { path, store } = requestState(root, branch);
  if (!existsSync(path)) return;
  try {
    withRequestLock(
      `${path}.run`,
      () => {
        for (;;) {
          const request = store.read();
          if (!request || finalizationBranch(root) !== branch) return;
          let waiting: string | undefined;
          try {
            checkFinalizationCheckouts(root, new Set([branch]));
            checkPolicyCompatibility(root);
            if (preparedFinalization(root)) finalizeHistory(root, "", true, true);
            const plan = finalizationPlan(root);
            if (plan.branch !== branch) return;
            const after = plan.eligible.length ? finalizeHistory(root, plan.digest, false, true).after : plan.before;
            if (plan.units.length > plan.eligible.length)
              waiting = plan.problems[0] ?? "Earlier work is awaiting review";
            else if (
              waitingForDelivery(root, request.tasks, after) ||
              reviewStatus(root, ReviewSource.Working).changes.some((change) => change.approved)
            )
              waiting = "Waiting for reviewed work to be retained in Git";
          } catch (error) {
            waiting =
              error instanceof StateConflict || error instanceof InvalidInput || error instanceof CacheBusy
                ? error.message
                : "Cannot finalize reviewed history; inspect Workbench diagnostics";
            deferred(root, error);
          }
          const settled = withRequestLock(
            path,
            () => {
              if (store.read()?.generation !== request.generation) return false;
              if (waiting) store.write({ ...request, waiting: waiting.slice(0, 1024) });
              else rmSync(path, { force: true });
              return true;
            },
            1000,
          );
          if (settled) return;
        }
      },
      2000,
    );
  } catch (error) {
    if (!(error instanceof CacheBusy)) throw error;
  }
}

/** The launch handshake lets snapshot-based Git hooks release their executable once the child has loaded it. */
export async function wakeFinalization(root: string, track?: (closed: Promise<void>) => void): Promise<void> {
  try {
    if (!existsSync(repositoryStatePath(root, requestDirectory))) return;
    const branch = finalizationBranch(root);
    if (!branch || !existsSync(requestState(root, branch).path)) return;
    const distribution = distributionRoot(root);
    await new Promise<void>((ready, reject) => {
      const child = spawn(process.execPath, [join(distribution, "bundle/main.cjs"), finalizationCommand], {
        cwd: root,
        env: {
          ...gitEnvironment(),
          WORKBENCH_PROJECT_ROOT: root,
          WORKBENCH_DISTRIBUTION_ROOT: distribution,
          WORKBENCH_LOCAL_CONFIG_ROOT: root,
        },
        detached: !track,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      track?.(
        new Promise<void>((done) => {
          child.once("exit", () => {
            done();
          });
          child.once("error", () => {
            if (child.pid === undefined) done();
          });
        }),
      );
      const release = () => {
        clearTimeout(timer);
        if (child.connected) child.disconnect();
        if (!track) child.unref();
      };
      const timer = setTimeout(() => {
        release();
        reject(new StateConflict("The finalization process has not reported startup"));
      }, 5000);
      child.on("error", (error) => {
        release();
        reject(error);
      });
      child.once("exit", () => {
        release();
        reject(new StateConflict("The finalization process exited before startup"));
      });
      child.once("message", (message: unknown) => {
        release();
        if (message === finalizationCommand) ready();
        else reject(new StateConflict("Unexpected finalization startup reply"));
      });
    });
  } catch (error) {
    deferred(root, error);
  }
}

export function requestAutomaticFinalization(
  root: string,
  trigger?: FinalizationTrigger,
  wake: (directory: string) => Promise<void> = wakeFinalization,
): void {
  try {
    const branches = new Set(queueFinalization(root, trigger));
    if (!branches.size) return;
    if (!trigger?.revision) void wake(root);
    else
      for (const { directory, branch } of finalizationCheckouts(root))
        if (branch && branches.has(branch)) void wake(directory);
  } catch (error) {
    deferred(root, error);
  }
}
