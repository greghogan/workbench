import type { TaskRecord } from "./task-model.js";
import { TaskExecution, taskNeedsPlanApproval, taskStarted, type TaskQueueEntry } from "./task-queue.js";

export const TaskPhase = { Plans: "plans", Work: "work", Reviews: "reviews" } as const;
export type TaskPhase = (typeof TaskPhase)[keyof typeof TaskPhase];

export const TaskLifecycle = {
  Planned: "Planned",
  AwaitingApproval: "Awaiting approval",
  AwaitingImplementation: "Awaiting implementation",
  Implementing: "Implementing",
  AwaitingAcceptance: "Awaiting acceptance",
  Accepted: "Accepted",
  Finalized: "Finalized",
  Canceled: "Canceled",
} as const;
export type TaskLifecycle = (typeof TaskLifecycle)[keyof typeof TaskLifecycle];
export const taskLifecycles = Object.values(TaskLifecycle);

export function taskHadApproval(task: TaskRecord, entry?: TaskQueueEntry): boolean {
  return (
    !!(task.previouslyApproved ?? task.approval ?? task.implementation) ||
    taskStarted(entry) ||
    task.metadata.status === "Approved" ||
    task.metadata.status === "Accepted"
  );
}

export function taskLifecycle(task: TaskRecord, entry?: TaskQueueEntry): TaskLifecycle {
  if (task.metadata.status === "Canceled") return TaskLifecycle.Canceled;
  if (task.metadata.status === "Accepted" && !task.acceptanceNeedsReview)
    return task.finalized ? TaskLifecycle.Finalized : TaskLifecycle.Accepted;
  if (taskNeedsPlanApproval(task))
    return taskHadApproval(task, entry) ? TaskLifecycle.AwaitingApproval : TaskLifecycle.Planned;
  if (entry?.state === TaskExecution.Active) return TaskLifecycle.Implementing;
  if (task.verificationStale) return TaskLifecycle.AwaitingImplementation;
  if (
    task.acceptanceNeedsReview ||
    (entry?.state === TaskExecution.Implemented && entry.planDigest === task.planDigest) ||
    (!entry && task.implementation)
  )
    return TaskLifecycle.AwaitingAcceptance;
  return TaskLifecycle.AwaitingImplementation;
}

export function taskPhase(task: TaskRecord, entry?: TaskQueueEntry): TaskPhase | undefined {
  if (task.archived) return;
  const state = taskLifecycle(task, entry);
  if (state === TaskLifecycle.Planned) return TaskPhase.Plans;
  if (state === TaskLifecycle.AwaitingApproval || state === TaskLifecycle.AwaitingAcceptance) return TaskPhase.Reviews;
  if (state === TaskLifecycle.AwaitingImplementation || state === TaskLifecycle.Implementing) return TaskPhase.Work;
  return undefined;
}
