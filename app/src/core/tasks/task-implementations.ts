import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { BoundedState } from "../storage/bounded-state.js";
import { taskProjectStateFile, taskRepositoryDirectory } from "./task-project-state.js";
import {
  CacheLockState,
  inspectCacheMetadataLock,
  recoverCacheMetadataLock,
  withCacheLocksSync,
} from "../storage/cache-lock.js";
import { gitBytes, readGitTree, refreshReviewPaths, workingReviewTree, type GitEntry } from "../git/git-snapshot.js";
import { gitRevision } from "../git/refs.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { record, records, string } from "../runtime/values.mjs";
import type { TaskRecord } from "./task-model.js";
import { decodeTaskVerification, type TaskQueueEntry } from "./task-queue-state.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { projectPaths } from "../projects/project-paths.js";
import { coverageSummaryPath } from "../execution/checks/coverage-summary.mjs";

export interface TaskImplementation {
  reference: string;
  planDigest: string;
  tree: string;
  checkout: string;
  verified: string;
  evidence: string;
  paths?: string[];
}
export interface ApplicableTaskImplementation extends TaskImplementation {
  baseline: string;
}
const oid = (value: unknown): string => {
  const result = string(value, "Missing implementation snapshot");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) throw new InvalidInput("Invalid implementation snapshot");
  return result;
};
function cataloguePath(repository: string): string {
  return taskProjectStateFile(repository, "task-implementations");
}
export function taskImplementationPath(root: string): string | undefined {
  const repository = taskRepositoryDirectory(root);
  return repository ? cataloguePath(repository) : undefined;
}
/** Copy evidence only when the moved repository owns its objects; leave original provenance and recovery data intact. */
export function preserveRelocatedTaskImplementations(previous: string, root: string): void {
  const repository = taskRepositoryDirectory(root);
  if (!repository) return;
  const location = relative(root, repository);
  if (isAbsolute(location) || location === ".." || location.startsWith(".." + sep)) return;
  const source = cataloguePath(resolve(previous, location)),
    destination = cataloguePath(repository);
  if (source === destination || !existsSync(source)) return;
  withCacheLocksSync(
    [source, destination],
    () => {
      const original = store(source).read(),
        current = store(destination).read();
      const key = (entry: TaskImplementation) => JSON.stringify([entry.reference, entry.planDigest, entry.tree]);
      const entries = new Map(current.entries.map((entry) => [key(entry), entry]));
      const trees = [...new Set(original.entries.map((entry) => entry.tree))];
      if (trees.length) {
        const types = gitBytes(root, ["cat-file", "--batch-check=%(objecttype)"], trees.join("\n") + "\n")
          .toString()
          .trim()
          .split("\n");
        if (types.length !== trees.length || types.some((type) => type !== "tree"))
          throw new StateConflict(
            "The moved repository does not contain the recorded implementation; evidence was preserved at its original location",
          );
      }
      for (const entry of original.entries) {
        const existing = entries.get(key(entry));
        if (existing && JSON.stringify(existing) !== JSON.stringify(entry))
          throw new StateConflict(
            "Conflicting implementation evidence at the destination; reconcile it before relocating",
          );
        entries.set(key(entry), entry);
      }
      store(destination).write({ version: 1, entries: [...entries.values()] });
    },
    { mutable: false },
  );
}
interface ImplementationCatalogue {
  version: 1;
  entries: TaskImplementation[];
}
export function decodeTaskImplementation(input: unknown): TaskImplementation {
  const entry = record(input, "Invalid implementation evidence");
  if (
    Object.keys(entry).some(
      (key) => !["reference", "planDigest", "tree", "checkout", "verified", "evidence", "paths"].includes(key),
    )
  )
    throw new InvalidInput("Unknown implementation evidence field");
  const reference = string(entry.reference, "Missing implemented task"),
    planDigest = string(entry.planDigest, "Missing implementation plan"),
    checkout = string(entry.checkout, "Missing source checkout"),
    evidence = string(entry.evidence, "Missing verification evidence"),
    verified = string(entry.verified, "Missing verification time");
  if (
    !/^[a-z][a-z0-9_-]*:TSK-[0-9A-Z]+$/.test(reference) ||
    !/^[a-f0-9]{64}$/.test(planDigest) ||
    !isAbsolute(checkout) ||
    checkout.includes("\0") ||
    !evidence.trim() ||
    evidence.length > 16384 ||
    evidence.includes("\0") ||
    !Number.isFinite(Date.parse(verified))
  )
    throw new InvalidInput("Invalid implementation evidence");
  const tree = oid(entry.tree);
  const paths = entry.paths === undefined ? undefined : decodeTaskVerification({ tree, paths: entry.paths }).paths;
  return { reference, planDigest, checkout, evidence, verified, tree, ...(paths ? { paths } : {}) };
}
export function decodeApplicableTaskImplementation(input: unknown): ApplicableTaskImplementation {
  const { baseline, ...entry } = record(input, "Invalid applicable implementation evidence");
  return { ...decodeTaskImplementation(entry), baseline: oid(baseline) };
}
function store(path: string) {
  return new BoundedState<ImplementationCatalogue>(
    () => path,
    16 * 1024 * 1024,
    (input) => {
      const data = record(input, "Invalid implementation catalogue");
      if (Object.keys(data).some((key) => !["version", "entries"].includes(key)))
        throw new InvalidInput("Unknown implementation catalogue field");
      if (data.version !== 1) throw new InvalidInput("Unsupported implementation catalogue");
      const entries = records(data.entries, "Invalid implementation entries").map(decodeTaskImplementation);
      if (entries.length > 10000) throw new InvalidInput("Implementation evidence catalogue exceeds its limit");
      return { version: 1, entries };
    },
    () => ({ version: 1, entries: [] }),
  );
}
export function recordTaskImplementation(
  root: string,
  task: TaskRecord,
  evidence: string,
  startedFrom?: string,
  previous?: TaskQueueEntry["verification"],
): TaskQueueEntry["verification"] {
  const path = taskImplementationPath(root);
  if (!path) return undefined;
  const head = gitRevision(root, "HEAD");
  const taskPath = relative(root, task.path).replaceAll("\\", "/");
  const readPaths = (args: string[]) => gitBytes(root, args).toString().split("\0").filter(Boolean);
  const claim = startedFrom && gitRevision(root, `${startedFrom}^{commit}`);
  const delivered = head
    ? readPaths([
        "log",
        "--format=",
        "--full-history",
        "--full-diff",
        "--name-only",
        "-z",
        head,
        ...(claim ? ["^" + claim] : ["--min-parents=1"]),
        "--",
        taskPath,
        taskPath.slice(0, -3),
      ])
    : [];
  // After delivery, retained commits identify the task's files even if an earlier receipt captured unrelated edits.
  const retained = task.acceptanceNeedsReview && delivered.length > 0;
  const scope =
    head && (retained || previous)
      ? new Set([...(retained ? [] : (previous?.paths ?? [])), ...delivered, taskPath])
      : undefined;
  const tip = scope && head ? readGitTree(root, head) : undefined;
  const tree =
    scope && head && tip
      ? refreshReviewPaths(
          root,
          head,
          [...scope].filter((file) => tip.has(file) || !!lstatSync(join(root, file), { throwIfNoEntry: false })),
        )
      : workingReviewTree(root);
  const entry: TaskImplementation = {
    reference: task.reference,
    planDigest: task.planDigest,
    checkout: realpathSync.native(root),
    tree,
    verified: new Date().toISOString(),
    evidence,
  };
  const expected = gitBytes(root, ["hash-object", "--path", taskPath, "--stdin"], task.contents).toString().trim(),
    captured = gitBytes(root, ["rev-parse", `${entry.tree}:${taskPath}`])
      .toString()
      .trim();
  if (
    expected !== captured ||
    readBoundedFile(task.path, 2 * 1024 * 1024, "task record").toString("utf8") !== task.contents
  )
    throw new StateConflict("Task changed while recording its implementation; refresh and retry");
  // Rechecking a retained delivery refreshes its owned paths and commits, even while another task is in progress.
  const edited = scope
    ? [...scope]
    : head
      ? readPaths(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", head, entry.tree])
      : [...readGitTree(root, entry.tree).keys()];
  const paths = [...new Set([...edited, ...delivered])].filter(
    (path) =>
      path !== "AGENTS.md" &&
      !projectRelativePath(path, coverageSummaryPath) &&
      !/(?:^|\/)workbench\/tasks\//.test(path) &&
      !/(?:^|\/)workbench\/(?:task-map|decision-map|experiment-map|environment-map|citation-map)\.md$/.test(path),
  );
  entry.paths = paths;
  const lock = inspectCacheMetadataLock(path);
  if (lock.state === CacheLockState.Abandoned) recoverCacheMetadataLock(path, { expected: lock.digest });
  withCacheLocksSync(
    [path],
    () => {
      const state = store(path).read();
      state.entries = state.entries.filter(
        (previous) =>
          previous.reference !== entry.reference ||
          previous.planDigest !== entry.planDigest ||
          previous.tree !== entry.tree,
      );
      state.entries.push(entry);
      store(path).write(state);
    },
    { mutable: false },
  );
  return { tree: entry.tree, paths };
}

function projectRelativePath(path: string, file: string): boolean {
  return path === file || path.endsWith("/" + file);
}

function retainedProjectState(root: string, entry: GitEntry | undefined): string {
  if (!entry) return "{}";
  if (entry.mode !== "100644") throw new Error("Unexpected project state file mode");
  const state = parse(gitBytes(root, ["cat-file", "blob", entry.oid]).toString("utf8"));
  delete state.next;
  return JSON.stringify(state);
}

export function taskVerificationApplies(root: string, proof: NonNullable<TaskQueueEntry["verification"]>): boolean {
  try {
    const baseline = readGitTree(root, proof.tree);
    const paths = proof.paths.filter(
      (path) =>
        !projectRelativePath(path, coverageSummaryPath) &&
        (baseline.has(path) || !!lstatSync(join(root, path), { throwIfNoEntry: false })),
    );
    const current = refreshReviewPaths(root, proof.tree, paths);
    if (current === proof.tree) return true;
    const changes = gitBytes(root, [
      "diff-tree",
      "--no-commit-id",
      "--no-renames",
      "--name-only",
      "-r",
      "-z",
      proof.tree,
      current,
    ])
      .toString()
      .split("\0")
      .filter(Boolean);
    if (!changes.every((path) => projectRelativePath(path, projectPaths.state))) return false;
    const updated = readGitTree(root, current);
    // Allocating another record only advances the sequence. Archive metadata remains part of the delivery.
    return changes.every(
      (path) => retainedProjectState(root, baseline.get(path)) === retainedProjectState(root, updated.get(path)),
    );
  } catch {
    return false;
  }
}

export function taskVerification(task: TaskRecord, entry?: TaskQueueEntry): TaskQueueEntry["verification"] {
  if (entry) return entry.state === "Implemented" ? entry.verification : undefined;
  const implementation = task.implementation;
  return implementation?.paths ? { tree: implementation.tree, paths: implementation.paths } : undefined;
}

function implementationBaselines(root: string, head: string, trees: Set<string>): Map<string, string> {
  const directory = mkdtempSync(join(tmpdir(), "workbench-task-history-"));
  let descriptor: number | undefined;
  try {
    descriptor = openSync(join(directory, "history"), "wx+", 0o600);
    const history = spawnSync("git", ["-C", root, "log", "--format=%H %T", head], {
      stdio: ["ignore", descriptor, "pipe"],
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 1024 * 1024,
    });
    if (history.error) throw history.error;
    if (history.status !== 0)
      throw new Error(`Cannot inspect task implementation history: ${history.stderr.trim() || String(history.status)}`);
    const baselines = new Map<string, string>(),
      buffer = Buffer.alloc(64 * 1024);
    let pending = "",
      offset = 0;
    const accept = (line: string) => {
      const [commit, tree] = line.split(" "),
        snapshot = oid(tree);
      if (trees.has(snapshot) && !baselines.has(snapshot)) baselines.set(snapshot, oid(commit));
    };
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (!count) break;
      offset += count;
      const lines = (pending + buffer.toString("ascii", 0, count)).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) accept(line);
      if (baselines.size === trees.size) break;
    }
    if (pending && baselines.size < trees.size) accept(pending);
    return baselines;
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
/** Evidence establishes implementation at a named historical baseline, never current checks or human acceptance. */
export function attachTaskImplementations(root: string, tasks: TaskRecord[]): void {
  for (const task of tasks) delete task.implementation;
  const plans = new Map(
    tasks.filter((task) => task.metadata.status === "Approved").map((task) => [task.reference, task.planDigest]),
  );
  if (!plans.size) return;
  const path = taskImplementationPath(root);
  if (!path) return;
  const entries = store(path)
    .read()
    .entries.filter((entry) => plans.get(entry.reference) === entry.planDigest);
  if (!entries.length) return;
  const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) return;
  const baselines = implementationBaselines(root, oid(head.stdout.trim()), new Set(entries.map((entry) => entry.tree)));
  const applicable = new Map<string, ApplicableTaskImplementation>();
  for (const entry of entries.reverse()) {
    const baseline = baselines.get(entry.tree);
    if (baseline && !applicable.has(entry.reference)) applicable.set(entry.reference, { ...entry, baseline });
  }
  for (const task of tasks) {
    if (task.metadata.status !== "Approved") continue;
    const implementation = applicable.get(task.reference);
    if (implementation) task.implementation = implementation;
  }
}
