import { projectPathComparison } from "./project-registry.js";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { BoundedState } from "./bounded-state.js";
import { userDirectory } from "./storage.js";
import {
  CacheLockState,
  inspectCacheMetadataLock,
  recoverCacheMetadataLock,
  withCacheLocksSync,
} from "./cache-lock.js";
import { gitBytes, workingReviewTree } from "./git-snapshot.js";
import { readBoundedFile } from "./file-reads.js";
import { record, records, string } from "../scripts/values.mjs";
import type { TaskRecord } from "./task-model.js";
import { InvalidInput, StateConflict } from "./input-errors.js";

export interface TaskImplementation {
  reference: string;
  planDigest: string;
  tree: string;
  checkout: string;
  verified: string;
  evidence: string;
}
export interface ApplicableTaskImplementation extends TaskImplementation {
  baseline: string;
}
const oid = (value: unknown): string => {
  const result = string(value, "Missing implementation snapshot");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) throw new InvalidInput("Invalid implementation snapshot");
  return result;
};
function repositoryDirectory(root: string): string | undefined {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error) throw result.error;
  return result.status === 0 ? realpathSync.native(resolve(root, result.stdout.trim())) : undefined;
}
function cataloguePath(repository: string): string {
  return join(
    userDirectory("state"),
    "task-implementations",
    createHash("sha256").update(projectPathComparison(repository)).digest("hex") + ".json",
  );
}
export function taskImplementationPath(root: string): string | undefined {
  const repository = repositoryDirectory(root);
  return repository ? cataloguePath(repository) : undefined;
}
/** Copy evidence only when the moved repository owns its objects; leave original provenance and recovery data intact. */
export function preserveRelocatedTaskImplementations(previous: string, root: string): void {
  const repository = repositoryDirectory(root);
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
      (key) => !["reference", "planDigest", "tree", "checkout", "verified", "evidence"].includes(key),
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
  return { reference, planDigest, checkout, evidence, verified, tree: oid(entry.tree) };
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
export function recordTaskImplementation(root: string, task: TaskRecord, evidence: string): void {
  const path = taskImplementationPath(root);
  if (!path) return;
  const entry: TaskImplementation = {
    reference: task.reference,
    planDigest: task.planDigest,
    checkout: realpathSync.native(root),
    tree: workingReviewTree(root),
    verified: new Date().toISOString(),
    evidence,
  };
  const taskPath = relative(root, task.path).replaceAll("\\", "/");
  const expected = gitBytes(root, ["hash-object", "--path", taskPath, "--stdin"], task.contents).toString().trim(),
    captured = gitBytes(root, ["rev-parse", `${entry.tree}:${taskPath}`])
      .toString()
      .trim();
  if (
    expected !== captured ||
    readBoundedFile(task.path, 2 * 1024 * 1024, "task record").toString("utf8") !== task.contents
  )
    throw new StateConflict("Task changed while recording its implementation; refresh and retry");
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
