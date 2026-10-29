import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseDocument } from "yaml";
import { workingReviewTree } from "./git-snapshot.js";
import { InvalidInput, StateConflict } from "./input-errors.js";
import { readConfig } from "./project-configuration.js";
import { ProjectEdits } from "./project-edits.js";
import { splitFrontmatter, taskStatuses, terminalTask, type TaskStatus } from "./record-document.js";
import { taskChecklistChanges } from "./task-checklists.js";
import { readTaskGraph, taskDigest, taskReference, type TaskRecord } from "./task-model.js";
import {
  publishTaskTransition,
  readTaskQueue,
  TaskBlockerKind,
  TaskReadiness,
  withTaskLock,
  writeTaskQueue,
} from "./task-queue.js";

/** Shared capability rules keep CLI/web controls and the mutation guard in agreement. */
export function taskTransitionProblem(
  task: TaskRecord,
  readiness: TaskReadiness,
  status: TaskStatus,
): string | undefined {
  if (task.metadata.status === status && status !== "Accepted") return undefined;
  if (
    (status === "Approved" && task.metadata.status !== "Planned") ||
    (status === "Accepted" && task.metadata.status !== "Approved" && task.metadata.status !== "Accepted")
  )
    return `Cannot change ${task.metadata.status} to ${status}; return to planning before approving revised work`;
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
    const blockers = new TaskReadiness(readiness.graph, { ...readiness.queue, entries: [] })
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
): void {
  withTaskLock(root, () => {
    if (!taskStatuses.includes(status)) throw new InvalidInput("Unknown shared task state");
    const graph = readTaskGraph(root),
      task = graph.require(taskReference(root, value));
    if (expected !== undefined && expected !== task.digest)
      throw new StateConflict("Task changed; refresh and review its current contents");
    const enforce = readConfig(root).review?.task_approvals === true;
    if (enforce && ["Approved", "Accepted"].includes(status) && !humanReviewed)
      throw new InvalidInput(
        "Human confirmation is required for task approval or acceptance; use the interactive task command or the task page",
      );
    if (task.metadata.status === status && !(enforce && humanReviewed)) return;
    const queue = readTaskQueue(root),
      entry = queue.entries.find((entry) => entry.reference === task.reference);
    const problem = taskTransitionProblem(task, new TaskReadiness(graph, queue), status);
    if (problem) throw new StateConflict(problem);
    const originalQueue = structuredClone(queue);
    const parts = splitFrontmatter(task.contents);
    if (!parts) throw new InvalidInput("Task frontmatter is missing");
    const document = parseDocument(parts.yaml);
    document.set("status", status);
    const ending = task.contents.includes("\r\n") ? "\r\n" : "\n";
    const header = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(task.contents)?.[0];
    if (!header) throw new InvalidInput("Task frontmatter is incomplete");
    const contents = `---${ending}${document.toString().replaceAll("\n", ending)}---${ending}${task.contents.slice(header.length)}`;
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
    if (entry && status !== "Accepted") {
      entry.state = "Queued";
      delete entry.reason;
      delete entry.evidence;
      delete entry.planDigest;
      entry.updated = new Date().toISOString();
      queue.revision++;
    }
    if (enforce) {
      queue.decisions = (queue.decisions ?? []).filter(
        (decision) =>
          decision.reference !== task.reference || (status === "Accepted" && decision.status === "Approved"),
      );
      if (status === "Approved" || status === "Accepted")
        queue.decisions.push({
          reference: task.reference,
          status,
          digest: taskDigest(changes.find((change) => change.path === task.path)?.contents ?? contents),
          updated: new Date().toISOString(),
        });
      queue.revision++;
    }
    publishTaskTransition(root, edits, originalQueue, queue);
    if (enforce && status === "Accepted") {
      const decision = queue.decisions?.find(
        (decision) => decision.reference === task.reference && decision.status === "Accepted",
      );
      if (decision) {
        decision.tree = workingReviewTree(root);
        queue.revision++;
        writeTaskQueue(root, queue);
      }
    }
  });
}
