import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { gitBytes, readGitObjects, writeReviewBlobs, type GitEntry } from "../../git/git-snapshot.js";
import { projectPaths } from "../../projects/project-paths.js";
import { InvalidInput, StateConflict } from "../../runtime/input-errors.js";
import { TaskExecution, readTaskQueue, withTaskLock, writeTaskQueue } from "../task-queue.js";
import { planningPaths } from "./plan-model.js";
import { rewritePlanReferences } from "./plan-references.js";

export function updatePlanQueueReferences(root: string, mapping: ReadonlyMap<string, string>): void {
  const checkouts = gitBytes(root, ["worktree", "list", "--porcelain", "-z"])
    .toString()
    .split("\0")
    .filter((row) => row.startsWith("worktree "))
    .map((row) => row.slice(9));
  for (const checkout of checkouts) {
    if (!existsSync(join(checkout, projectPaths.projects))) continue;
    withTaskLock(checkout, () => {
      const queue = readTaskQueue(checkout);
      let changed = false;
      for (const entry of queue.entries) {
        const target = mapping.get(entry.reference);
        if (!target) continue;
        if (entry.state === TaskExecution.Active || entry.state === TaskExecution.Implemented)
          throw new StateConflict(
            `Preserve ${entry.state.toLowerCase()} work in ${checkout} before replacing its plan reference`,
          );
        if (queue.entries.some((other) => other !== entry && other.reference === target))
          throw new StateConflict(`Reconcile duplicate queue selections for ${target} in ${checkout}`);
        entry.reference = target;
        entry.updated = new Date().toISOString();
        changed = true;
      }
      if (changed) {
        queue.revision++;
        writeTaskQueue(checkout, queue);
      }
    });
  }
}
export function rewrittenPlanEntries(
  root: string,
  entries: ReadonlyMap<string, GitEntry>,
  mapping: ReadonlyMap<string, string>,
  transform?: (path: string, contents: string) => string,
): Map<string, GitEntry> | undefined {
  const selected = [...entries].filter(
      ([path]) =>
        path === planningPaths.document ||
        path === planningPaths.approved + planningPaths.document ||
        [".md", ".markdown", ".txt", ".json", ".toml", ".yaml", ".yml", ".patch", ".diff"].includes(
          extname(path).toLowerCase(),
        ),
    ),
    objects = readGitObjects(
      root,
      selected.map(([, entry]) => entry.oid),
      8 * 1024 * 1024,
      { retainedBytes: 16 * 1024 * 1024 },
    ),
    changes: { path: string; contents: Buffer; entry: GitEntry }[] = [];
  for (const [path, entry] of selected) {
    const bytes = objects.get(entry.oid);
    if (!bytes) throw new InvalidInput("Plan reference content is unavailable");
    const contents = bytes.toString();
    if (!Buffer.from(contents).equals(bytes) || contents.includes("\0")) continue;
    const references = rewritePlanReferences(contents, mapping);
    const rewritten = transform ? transform(path, references) : references;
    if (rewritten !== contents) changes.push({ path, contents: Buffer.from(rewritten), entry });
  }
  if (!changes.length) return undefined;
  const blobs = writeReviewBlobs(
      root,
      changes.map((change) => change.contents),
    ),
    result = new Map(entries);
  changes.forEach((change, index) => {
    const oid = blobs[index];
    if (!oid) throw new InvalidInput("Cannot retain updated plan references");
    result.set(change.path, { ...change.entry, oid });
  });
  return result;
}
