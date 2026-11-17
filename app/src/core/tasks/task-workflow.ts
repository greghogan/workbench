import type { TaskRecord } from "./task-model.js";
import { TaskExecution, taskNeedsPlanApproval, type TaskQueue } from "./task-queue.js";
import { terminalTask } from "../records/record-document.js";

export const TaskPhase = { Plans: "plans", Work: "work", Reviews: "reviews" } as const;
export type TaskPhase = (typeof TaskPhase)[keyof typeof TaskPhase];

/** The primary decision follows the task's current scope. Work can also show started tasks waiting for approval. */
export function taskPhase(task: TaskRecord, entry?: TaskQueue["entries"][number]): TaskPhase | undefined {
  if (task.archived) return;
  if (terminalTask.has(task.metadata.status)) return task.acceptanceNeedsReview ? TaskPhase.Reviews : undefined;
  if (taskNeedsPlanApproval(task)) return TaskPhase.Plans;
  if (
    (entry?.state === TaskExecution.Implemented && entry.planDigest === task.planDigest) ||
    (!entry && task.implementation)
  )
    return TaskPhase.Reviews;
  return TaskPhase.Work;
}
