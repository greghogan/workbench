import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { recordInventory, readInventoryRecords } from "../../core/records/archive-store.js";
import { readProjects } from "../../core/projects/project-configuration.js";
import { projectPaths } from "../../core/projects/project-paths.js";
import { taskDecisionPath } from "../../core/tasks/task-decisions.js";
import { taskImplementationPath } from "../../core/tasks/task-implementations.js";
import { readTaskQueue, taskQueuePath } from "../../core/tasks/task-queue.js";
import { taskLifecycle, TaskLifecycle } from "../../core/tasks/task-workflow.js";
import { observeTaskVerifications, treeTasks } from "../../core/tasks/task-snapshot.js";
import { gitRevision } from "../../core/git/refs.js";
import { planningInputs } from "../../core/tasks/planning/planning-inputs.js";
import { readPlanningRecords } from "../../core/tasks/planning/planning-read-model.js";
import { workGraph } from "../../core/tasks/planning/work-plans.js";
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
  for (const path of planningInputs(root)) observe(path);
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
  const records = prepared.problem ? [] : workGraph(prepared.records, readPlanningRecords(root)).tasks;
  observeTaskVerifications(root, records, [...entries.values()], observe);
  const awaiting = records.filter((task) => !task.archived);
  if (awaiting.some((task) => task.metadata.status === "Planned" && !task.previouslyApproved)) {
    const head = gitRevision(root, "HEAD");
    const retained = head ? treeTasks(root, head) : new Map<string, undefined>();
    for (const task of awaiting) {
      const status = retained.get(task.reference)?.status;
      if (status === "Approved" || status === "Accepted") task.previouslyApproved = true;
    }
  }
  const decisions = awaiting.map((task) => [task.reference, taskLifecycle(task, entries.get(task.reference))] as const);
  return {
    byPath: reviewTasksByPath(root, records),
    approvals: decisions.filter(([, state]) => state === TaskLifecycle.AwaitingApproval).length,
    outcomes: new Set(decisions.filter(([, state]) => state === TaskLifecycle.AwaitingAcceptance).map(([id]) => id)),
  };
}
