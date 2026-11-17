import { canceledContents } from "./planning/plan-disposition.js";
import { readWorkGraph } from "./planning/work-plans.js";
import { retainTaskPlanApproval, readTaskPlanApproval, taskPlanFiles, taskReviewVersion } from "./task-approvals.js";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { taskOutcomeDigest } from "./task-snapshot.js";
import { gitRevision } from "../git/refs.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { readConfig } from "../projects/project-configuration.js";
import { ProjectEdits } from "../projects/project-edits.js";
import { replaceRecordStatus, taskStatuses, terminalTask, type TaskStatus } from "../records/record-document.js";
import { taskChecklistChanges } from "./task-checklists.js";
import { taskDigest, taskReference, type TaskRecord } from "./task-model.js";
import {
  publishTaskTransition,
  readTaskQueue,
  TaskBlockerKind,
  TaskExecution,
  TaskReadiness,
  withTaskLock,
} from "./task-queue.js";
import { readTaskDecisions, prepareTaskDecisionChange, type TaskDecisionChange } from "./task-decisions.js";

/** Shared capability rules keep CLI/web controls and the mutation guard in agreement. */
export function taskTransitionProblem(
  task: TaskRecord,
  readiness: TaskReadiness,
  status: TaskStatus,
): string | undefined {
  if (task.metadata.status === status && status !== "Accepted") return undefined;
  if (status === "Canceled" && task.metadata.status === "Accepted")
    return "Accepted work cannot be canceled; reopen the task or explicitly revert its implementation";
  if (
    (status === "Approved" && !["Planned", "Approved"].includes(task.metadata.status)) ||
    (status === "Accepted" && task.metadata.status !== "Approved" && task.metadata.status !== "Accepted")
  )
    return `Cannot change ${task.metadata.status} to ${status}; review the current plan before continuing`;
  const tasks = readiness.graph.tasks,
    entry = readiness.entries.get(task.reference);
  if (status !== "Accepted") {
    const accepted = tasks.filter(
      (dependent) => dependent.metadata.status === "Accepted" && dependent.dependencies.includes(task.reference),
    );
    if (accepted.length)
      return `Reopen accepted dependent tasks first: ${accepted.map((dependent) => dependent.reference).join(", ")}`;
  }
  if ((status === "Planned" || status === "Canceled") && entry?.state === "Active")
    return "Block or release active work before changing its shared state";
  if (terminalTask.has(status)) {
    const children = (readiness.graph.children.get(task.reference) ?? []).filter(
      (child) => !terminalTask.has(child.metadata.status),
    );
    if (children.length)
      return `Accept or cancel child tasks first: ${children.map((child) => child.reference).join(", ")}`;
  } else {
    let parent = task.parent;
    while (parent) {
      const ancestor = readiness.graph.require(parent);
      if (terminalTask.has(ancestor.metadata.status)) return `Reopen parent ${parent} before changing this task`;
      parent = ancestor.parent;
    }
  }
  if (status === "Accepted") {
    if (task.approval && !task.approval.current)
      return "Review and approve the current plan before accepting its outcome";
    const blockers = new TaskReadiness(readiness.graph, { ...readiness.queue, entries: [] }, false)
      .blockers(task)
      .filter((blocker) => blocker.kind === TaskBlockerKind.Dependency || blocker.kind === TaskBlockerKind.Child);
    if (blockers.length) return blockers.map((blocker) => blocker.message).join("; ");
    if (entry && (entry.state !== "Implemented" || entry.planDigest !== task.planDigest))
      return "Verify the current queued implementation before accepting it";
  }
  return undefined;
}

export function changeTaskStatus(
  root: string,
  value: string,
  status: TaskStatus,
  expected?: string,
  humanReviewed = false,
  cancellationReason?: string,
): void {
  transitionTask(root, value, status, expected, humanReviewed, cancellationReason);
}

export function authorizeProjectReview(root: string, reference: string, expected: string): void {
  transitionTask(root, reference, "Approved", expected, false, undefined, "developer-requested-review");
}

function transitionTask(
  root: string,
  value: string,
  status: TaskStatus,
  expected: string | undefined,
  humanReviewed: boolean,
  cancellationReason: string | undefined,
  source?: "developer-requested-review",
): void {
  withTaskLock(root, () => {
    if (!taskStatuses.includes(status)) throw new InvalidInput("Unknown shared task state");
    const graph = readWorkGraph(root),
      task = graph.require(taskReference(root, value));
    if (task.archived) throw new InvalidInput("Restore archived records before changing their workflow state");
    if (expected !== undefined && expected !== (task.reviewDigest ?? task.digest))
      throw new StateConflict("Task changed; refresh and review its current contents");
    const enforce = readConfig(root).review?.task_approvals === true;
    if (enforce && ["Approved", "Accepted"].includes(status) && !humanReviewed && !source)
      throw new InvalidInput(
        "Human confirmation is required for task approval or acceptance; use the interactive task command or the task page",
      );
    const priorApproval = readTaskDecisions(root).find(
        (decision) => decision.reference === task.reference && decision.status === "Approved",
      ),
      priorPlan = priorApproval ? readTaskPlanApproval(root, priorApproval) : undefined;
    if (
      source &&
      (task.metadata.status !== "Planned" ||
        priorApproval ||
        gitRevision(root, `HEAD:${relative(root, task.path).replaceAll("\\", "/")}`))
    )
      throw new StateConflict("Developer requests authorize only the initial scope of a project review");
    if (task.metadata.status === status && !humanReviewed) return;
    if (
      status === "Approved" &&
      task.metadata.status === status &&
      priorPlan?.contents === task.contents &&
      JSON.stringify(priorPlan.files) === JSON.stringify(taskPlanFiles(root, task))
    )
      return;
    const queue = readTaskQueue(root),
      entry = queue.entries.find((entry) => entry.reference === task.reference);
    const problem = taskTransitionProblem(task, new TaskReadiness(graph, queue), status);
    if (problem) throw new StateConflict(problem);
    const originalQueue = structuredClone(queue);
    const contents =
      status === "Canceled"
        ? canceledContents(task.contents, cancellationReason ?? "")
        : replaceRecordStatus(task.contents, status);
    const changes = taskChecklistChanges(root, new Map([[task.path, contents]]));
    const edits = new ProjectEdits(root);
    for (const change of changes) {
      const path = relative(root, change.path).replaceAll("\\", "/");
      edits.write(path, change.contents);
      if (edits.files.get(path)?.previous?.toString("utf8") !== change.original)
        throw new StateConflict("A related task changed during its state transition; refresh and retry");
    }
    if (readFileSync(task.path, "utf8") !== task.contents)
      throw new StateConflict("Task changed during its state transition");
    if (entry && status !== "Accepted" && status !== "Approved") {
      queue.entries = queue.entries.filter((item) => item !== entry);
      queue.revision++;
    }
    if (!entry && status === "Approved") {
      queue.entries.push({ reference: task.reference, state: "Queued", updated: new Date().toISOString() });
      queue.revision++;
    }
    if (
      task.approval?.current === false &&
      status === "Approved" &&
      (entry?.state === TaskExecution.Active || entry?.state === TaskExecution.Implemented)
    ) {
      entry.started = true;
      entry.state = TaskExecution.Queued;
      entry.updated = new Date().toISOString();
      delete entry.planDigest;
      delete entry.evidence;
      queue.revision++;
    }
    let decisions: TaskDecisionChange | undefined;
    if (enforce || humanReviewed || priorApproval || source) {
      decisions = prepareTaskDecisionChange(root, task.reference, (before) => {
        const after = before.filter(
          (decision) =>
            (decision.status === "Accepted" && (decision.outcome !== undefined || decision.tree !== undefined)) ||
            (status === "Accepted" && decision.status === "Approved"),
        );
        if ((enforce || humanReviewed || source) && (status === "Approved" || status === "Accepted")) {
          const updated = new Date().toISOString(),
            reviewed = changes.find((change) => change.path === task.path)?.contents ?? contents,
            files = taskPlanFiles(root, task);
          if (taskOutcomeDigest(task.contents, files) !== (task.reviewDigest ?? task.digest))
            throw new StateConflict("Task supporting files changed during approval; refresh and review again");
          const snapshot =
            status === "Approved"
              ? retainTaskPlanApproval(root, {
                  reference: task.reference,
                  at: updated,
                  contents: reviewed,
                  files,
                })
              : undefined;
          after.push({
            reference: task.reference,
            status,
            digest: taskDigest(reviewed),
            updated,
            ...(snapshot ? { snapshot } : {}),
            ...(status === "Accepted" ? { outcome: taskOutcomeDigest(reviewed, files) } : {}),
            ...(source ? { source } : {}),
          });
        }
        return after;
      });
    }
    if (taskReviewVersion(root, task) !== (task.reviewDigest ?? task.digest))
      throw new StateConflict("Task supporting files changed during approval; refresh and review again");
    publishTaskTransition(root, edits, originalQueue, queue, decisions);
  });
}
