import { relative } from "node:path";
import { gitBytes } from "../../core/git/git-snapshot.js";
import type { TaskRecord } from "../../core/tasks/task-model.js";

export function reviewTaskPaths(root: string, revision: string, parents: readonly string[]): string[] {
  const paths = (parent?: string) =>
    new Set(
      gitBytes(root, [
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
        .flatMap((path) => {
          const task = /^((?:.*\/)?workbench\/tasks\/(?:[0-9A-Z]{2}\/)*TSK-[0-9A-Z]+)(?:\.md$|\/)/.exec(path)?.[1];
          return task ? [task + ".md"] : [];
        }),
    );
  const [first, ...rest] = parents;
  const candidates = paths(first);
  for (const parent of rest) {
    const common = paths(parent);
    for (const candidate of candidates) if (!common.has(candidate)) candidates.delete(candidate);
  }
  return [...candidates];
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
