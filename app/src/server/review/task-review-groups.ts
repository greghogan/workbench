import { relative } from "node:path";
import { gitBytes } from "../../core/git/git-snapshot.js";
import type { TaskRecord } from "../../core/tasks/task-model.js";

export function reviewTaskPaths(root: string, revision: string, parent?: string): string[] {
  return gitBytes(root, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-z",
    "--no-renames",
    ...(parent ? [parent, revision] : ["--root", revision]),
    "--",
    ":(glob)**/workbench/tasks/**",
  ])
    .toString()
    .split("\0")
    .filter((path) => /(?:^|\/)workbench\/tasks\/(?:[0-9A-Z]{2}\/)*TSK-[0-9A-Z]+\.md$/.test(path));
}

export function reviewTasksByPath(root: string, tasks: readonly TaskRecord[]): Map<string, TaskRecord> {
  return new Map(
    tasks
      .filter((task) => !task.archived && !task.planning)
      .map((task) => [relative(root, task.path).replaceAll("\\", "/"), task]),
  );
}

/** A commit carrying several task records has no single owner for its protected files. */
export function reviewTaskOwner(
  paths: readonly string[],
  tasks: ReadonlyMap<string, TaskRecord>,
): TaskRecord | undefined {
  if (paths.length !== 1) return;
  const task = tasks.get(paths[0] ?? "");
  return task?.metadata.status === "Canceled" ? undefined : task;
}
