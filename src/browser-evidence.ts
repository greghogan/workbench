import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, lstatSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { userDirectory } from "./storage.js";
import { logRetention, type LogRetention } from "./log-storage.js";
import { selectLogRetention } from "./log-retention.js";
import { publish } from "./log-run.js";
import { userConfigValues } from "./user-config.js";
import { acquireProcessLock, inspectProcessLock, type ProcessLock } from "./process-lock.js";
import { keptCacheAssets } from "./project-registry.js";
import { readBoundedFile } from "./file-reads.js";
import { ownedPath } from "./paths.js";
import { withCacheLock } from "./cache-lock.js";
import { diagnosticError, writeDiagnosticText } from "./diagnostics.js";
import { pruneItem, type CachePruneObserver } from "./cache-prune-progress.js";

export const browserEvidenceMarker = ".workbench-browser-run.json";
interface BrowserRun {
  version: 1;
  kind: "browser-evidence";
  project: string;
  state: "active" | "completed";
  outcome?: "passed" | "failed" | "interrupted";
  started: string;
  completed?: string;
  errors: ReturnType<typeof diagnosticError>[];
}
export interface BrowserEvidenceEntry {
  directory: string;
  project: string;
  started: string;
  completed?: string;
  bytes: number;
  selected: boolean;
  blockedBy?: string;
  interrupted?: true;
  removed?: true;
}
export interface BrowserEvidencePlan {
  schema_version: 2;
  kind: "browser-evidence";
  checkout: string | null;
  entries: BrowserEvidenceEntry[];
  issues: string[];
}
function evidenceRoot() {
  const directory = join(userDirectory("cache"), "browser-evidence");
  return existsSync(directory) ? realpathSync.native(directory) : directory;
}
const canonical = (root: string) => (existsSync(root) ? realpathSync.native(root) : resolve(root));
function namespace(root: string) {
  return join(evidenceRoot(), createHash("sha256").update(canonical(root)).digest("hex").slice(0, 24));
}
function readRun(directory: string): BrowserRun {
  const value: unknown = JSON.parse(
    readBoundedFile(ownedPath(directory, browserEvidenceMarker), 256 * 1024, "browser evidence").toString(),
  );
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("kind" in value) ||
    value.kind !== "browser-evidence" ||
    !("project" in value) ||
    typeof value.project !== "string" ||
    !("state" in value) ||
    !["active", "completed"].includes(String(value.state)) ||
    !("started" in value) ||
    !Number.isFinite(Date.parse(String(value.started))) ||
    !("errors" in value) ||
    !Array.isArray(value.errors) ||
    value.errors.length > 32 ||
    !value.errors.every(
      (error: unknown) =>
        error &&
        typeof error === "object" &&
        "name" in error &&
        typeof error.name === "string" &&
        "message" in error &&
        typeof error.message === "string",
    )
  )
    throw new Error("Invalid browser evidence; preserving it");
  const run = value as BrowserRun;
  if (
    dirname(directory) !== namespace(run.project) ||
    (run.state === "completed" &&
      (!run.completed ||
        !Number.isFinite(Date.parse(run.completed)) ||
        !["passed", "failed", "interrupted"].includes(String(run.outcome))))
  )
    throw new Error("Invalid browser evidence ownership");
  return run;
}
/** The producer owns this handle; no helper process can claim its lifetime. */
export class BrowserEvidenceRun {
  readonly directory: string;
  readonly owner: ProcessLock;
  constructor(readonly project: string) {
    this.directory = join(namespace(project), randomUUID());
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync.native(this.directory);
    const owner = acquireProcessLock(join(this.directory, "owner"), true);
    if (!owner) throw new Error("Cannot own browser evidence");
    this.owner = owner;
    publish(join(this.directory, browserEvidenceMarker), {
      version: 1,
      kind: "browser-evidence",
      project: canonical(project),
      state: "active",
      started: new Date().toISOString(),
      errors: [],
    } satisfies BrowserRun);
  }
  async finish(errors: readonly unknown[] = []): Promise<void> {
    this.owner.assertIdle();
    const run = readRun(this.directory);
    if (run.state !== "active") throw new Error("Browser evidence already completed");
    publish(join(this.directory, browserEvidenceMarker), {
      ...run,
      state: "completed",
      outcome: errors.length ? "failed" : "passed",
      completed: new Date().toISOString(),
      errors: errors.map((error) => diagnosticError(error)).slice(0, 32),
    });
    this.owner.release();
    if (userConfigValues()["cache.auto_prune"] !== false) {
      try {
        await pruneBrowserEvidence(this.project);
      } catch (error) {
        writeDiagnosticText(`Browser evidence retained: ${diagnosticError(error).message}`);
      }
    }
  }
}
function storedBytes(directory: string): number {
  let bytes = 0,
    count = 0;
  const scan = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (++count > 10000) throw new Error("Browser evidence inventory exceeds its limit");
      if (path === directory && entry.name === "owner") continue;
      const file = ownedPath(path, entry.name),
        stat = lstatSync(file);
      if (stat.isFile()) bytes += stat.size;
      else if (stat.isDirectory() && path === directory && /^session-\d+$/.test(entry.name)) scan(file);
      else throw new Error("Unknown browser evidence entry; preserving run");
    }
  };
  scan(directory);
  return bytes;
}
export function inspectBrowserEvidence(root?: string, now = Date.now(), maintenance?: string): BrowserEvidencePlan {
  const base = evidenceRoot();
  const namespaces = root
    ? [namespace(root)]
    : existsSync(base)
      ? readdirSync(base, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name))
          .map((entry) => join(base, entry.name))
      : [];
  const plan: BrowserEvidencePlan = {
    schema_version: 2,
    kind: "browser-evidence",
    checkout: root ? canonical(root) : null,
    entries: [],
    issues: [],
  };
  const kept = keptCacheAssets();
  for (const folder of namespaces) {
    if (!existsSync(folder)) continue;
    const entries: BrowserEvidenceEntry[] = [];
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const directory = ownedPath(folder, entry.name);
      try {
        const run = readRun(directory),
          ownerPath = join(directory, "owner"),
          owner = inspectProcessLock(ownerPath);
        const blockedBy = !existsSync(run.project)
          ? "project unavailable; retention policy unknown"
          : kept.has(directory)
            ? "explicitly retained"
            : existsSync(`${directory}.lock`) && directory !== maintenance
              ? "maintenance active"
              : existsSync(ownerPath) && !owner.abandoned
                ? "producer active or ownership uncertain"
                : run.state === "active" && !owner.abandoned
                  ? "interrupted ownership unknown"
                  : undefined;
        entries.push({
          directory,
          project: run.project,
          started: run.started,
          ...(run.completed ? { completed: run.completed } : {}),
          bytes: storedBytes(directory),
          selected: false,
          ...(run.state === "active" && owner.abandoned && !blockedBy ? { interrupted: true as const } : {}),
          ...(blockedBy ? { blockedBy } : {}),
        });
      } catch (error) {
        plan.issues.push(`${directory}: ${error instanceof Error ? error.message : "inspection failed"}`);
      }
    }
    const project = entries[0]?.project;
    if (project && existsSync(project)) {
      let policy: LogRetention;
      try {
        policy = logRetention(project, true);
      } catch (error) {
        plan.issues.push(`${project}: retention policy unavailable: ${diagnosticError(error).message}`);
        for (const entry of entries) {
          entry.blockedBy = "retention policy unavailable";
          delete entry.interrupted;
        }
        plan.entries.push(...entries);
        continue;
      }
      const selected = new Set(
        selectLogRetention(
          entries.map((entry) => ({
            directory: entry.directory,
            completed: Date.parse(entry.completed ?? entry.started),
            eligible: !entry.blockedBy,
            bytes: entry.bytes,
          })),
          policy,
          now,
        ).remove,
      );
      for (const entry of entries) entry.selected = selected.has(entry.directory);
    }
    plan.entries.push(...entries);
  }
  return plan;
}
export async function applyBrowserEvidencePlan(
  plan: BrowserEvidencePlan,
  options: { signal?: AbortSignal; progress?: CachePruneObserver } = {},
): Promise<BrowserEvidencePlan> {
  const selected = plan.entries.filter((entry) => entry.selected);
  options.progress?.begin(selected.length);
  const removed = new Set<string>();
  for (const entry of plan.entries.filter((entry) => entry.selected || entry.interrupted)) {
    options.signal?.throwIfAborted();
    await withCacheLock(entry.directory, async () => {
      const fresh = inspectBrowserEvidence(plan.checkout ?? undefined, Date.now(), entry.directory);
      // Our own maintenance lock is expected; revalidate ownership and policy independently below.
      const current = fresh.entries.find((candidate) => candidate.directory === entry.directory);
      if (
        current?.project !== entry.project ||
        current.bytes !== entry.bytes ||
        current.blockedBy ||
        (entry.selected && !current.selected) ||
        keptCacheAssets().has(entry.directory)
      )
        throw new Error("Browser evidence changed; inspect the deletion plan again");
      const ownerPath = join(entry.directory, "owner");
      if (existsSync(ownerPath) && !inspectProcessLock(ownerPath).abandoned)
        throw new Error("Browser evidence became active");
      options.signal?.throwIfAborted();
      if (!entry.selected) {
        const run = readRun(entry.directory);
        if (run.state !== "active" || !inspectProcessLock(ownerPath).abandoned)
          throw new Error("Browser evidence ownership changed; preserving run");
        publish(join(entry.directory, browserEvidenceMarker), {
          ...run,
          state: "completed",
          outcome: "interrupted",
          completed: new Date().toISOString(),
        });
        await rm(ownerPath, { recursive: true });
        return;
      }
      await pruneItem(
        entry.directory,
        async () => {
          await rm(entry.directory, { recursive: true });
        },
        options.progress,
      );
      removed.add(entry.directory);
    });
  }
  return {
    ...plan,
    entries: plan.entries.map((entry) => ({
      ...entry,
      ...(removed.has(entry.directory) ? { removed: true as const } : {}),
    })),
  };
}
export async function pruneBrowserEvidence(root?: string): Promise<string[]> {
  const plan = inspectBrowserEvidence(root);
  await applyBrowserEvidencePlan(plan);
  return plan.entries.filter((entry) => entry.selected).map((entry) => entry.directory);
}
