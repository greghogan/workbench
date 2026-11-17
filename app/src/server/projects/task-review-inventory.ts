import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { recordInventory, readInventoryRecords } from "../../core/records/archive-store.js";
import { readProjects } from "../../core/projects/project-configuration.js";
import { projectPaths } from "../../core/projects/project-paths.js";
import { taskDecisionPath } from "../../core/tasks/task-decisions.js";
import { taskImplementationPath } from "../../core/tasks/task-implementations.js";
import { readTaskQueue, taskQueuePath } from "../../core/tasks/task-queue.js";
import { taskPhase, TaskPhase } from "../../core/tasks/task-workflow.js";
import { readBoundedFile } from "../../core/runtime/file-reads.js";
import { taskRecordState } from "../workspace/task-state.js";
import { reviewTasksByPath } from "../review/task-review-groups.js";

/** Observe mutable task inputs, including empty supporting directories; archived inputs remain pinned by project state. */
export function taskReviewInventory(root: string, observe: (path: string) => void) {
  const walk = (path: string) => {
    observe(path);
    if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory())
      for (const item of readdirSync(path, { withFileTypes: true })) {
        if (!item.isSymbolicLink()) walk(join(path, item.name));
        else observe(join(path, item.name));
      }
  };
  const projects = readProjects(root),
    files = projects.flatMap((project) => {
      walk(join(root, project.path, "workbench/tasks"));
      observe(join(root, project.path, projectPaths.state));
      return recordInventory(root, project.path, "TSK").map((file) => ({
        ...file,
        reference: `${project.id}:TSK-${file.number}`,
      }));
    });
  observe(taskDecisionPath(root));
  observe(taskQueuePath(root));
  const implementations = taskImplementationPath(root);
  if (implementations) observe(implementations);
  const archived = readInventoryRecords(
      root,
      files.filter((file) => file.archive),
    ),
    prepared = taskRecordState(
      root,
      files.map((file) => ({
        reference: file.reference,
        path: file.path,
        archived: !!file.archive,
        read: () => (archived.get(file.path) ?? readBoundedFile(file.path, 2 * 1024 * 1024, "task record")).toString(),
      })),
    ),
    entries = new Map(readTaskQueue(root).entries.map((entry) => [entry.reference, entry]));
  const records = prepared.problem ? [] : prepared.records;
  return {
    byPath: reviewTasksByPath(root, records),
    outcomes: new Set(
      records
        .filter((task) => taskPhase(task, entries.get(task.reference)) === TaskPhase.Reviews)
        .map((task) => task.reference),
    ),
  };
}
