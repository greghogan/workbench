import { TaskExecution, decodeQueue, type TaskQueueEntry, type TaskQueue } from "./task-queue-state.js";
export { TaskExecution, decodeQueue, type TaskQueueEntry, type TaskQueue } from "./task-queue-state.js";
import { readWorkGraph, workReference } from "./planning/work-plans.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { BoundedState } from "../storage/bounded-state.js";
import {
  CacheLockState,
  inspectCacheMetadataLock,
  recoverCacheMetadataLock,
  withCacheLocksSync,
} from "../storage/cache-lock.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { syncMaps } from "../records/maps.js";
import { ownedPath } from "../runtime/paths.js";
import { ProjectEdits } from "../projects/project-edits.js";
import { projectQueueKey } from "../projects/project-registry.js";
import { userDirectory } from "../storage/storage.js";
import { taskDigest, TaskGraph, type TaskRecord } from "./task-model.js";

import { recordTaskImplementation } from "./task-implementations.js";
import {
  applyTaskDecisionChange,
  decisionChangeApplied,
  decodeTaskDecisionChange,
  taskDecisionPath,
  withTaskDecisionPath,
  type TaskDecisionChange,
} from "./task-decisions.js";

const queuePaths = new AsyncLocalStorage<Map<string, string>>();
export function taskQueuePath(root: string): string {
  return (
    queuePaths.getStore()?.get(resolve(root)) ??
    join(userDirectory("state"), "task-queues", projectQueueKey(root), "queue.json")
  );
}
export function withTaskLock<T>(root: string, action: () => T): T {
  const path = taskQueuePath(root),
    decisions = taskDecisionPath(root),
    directories = [path, decisions].sort();
  for (const directory of directories) {
    const lock = inspectCacheMetadataLock(directory);
    if (lock.state === CacheLockState.Abandoned) recoverCacheMetadataLock(directory, { expected: lock.digest });
  }
  return withCacheLocksSync(
    directories,
    () => {
      return withTaskDecisionPath(root, decisions, () =>
        queuePaths.run(new Map([...(queuePaths.getStore() ?? []), [resolve(root), path]]), () => {
          recoverTaskTransition(root, path);
          return action();
        }),
      );
    },
    { mutable: false },
  );
}
const store = (root: string) => {
  const path = taskQueuePath(root);
  return new BoundedState<TaskQueue>(
    () => path,
    4 * 1024 * 1024,
    decodeQueue,
    () => ({ version: 1, revision: 0, entries: [] }),
  );
};
export function readTaskQueue(root: string): TaskQueue {
  return store(root).read();
}
/** The caller holds withTaskLock across its read, validation, and publication. */
export function writeTaskQueue(root: string, queue: TaskQueue): void {
  store(root).write(queue);
}
export function queueDigest(queue: TaskQueue): string {
  return taskDigest(JSON.stringify(queue));
}
export const TaskBlockerKind = {
  State: "state",
  Active: "active",
  Blocked: "blocked",
  Verification: "verification",
  Dependency: "dependency",
  Child: "child",
  Missing: "missing",
} as const;
export interface TaskBlocker {
  kind: (typeof TaskBlockerKind)[keyof typeof TaskBlockerKind];
  message: string;
  reference?: string;
}
export class TaskReadiness {
  readonly entries: Map<string, TaskQueueEntry>;
  constructor(
    readonly graph: TaskGraph,
    readonly queue: TaskQueue,
    private readonly allowImplementationEvidence = true,
  ) {
    this.entries = new Map(queue.entries.map((entry) => [entry.reference, entry]));
  }
  implemented(task: TaskRecord): boolean {
    const entry = this.entries.get(task.reference);
    return (
      task.metadata.status === "Accepted" ||
      (task.metadata.status === "Approved" &&
        (!task.approval || task.approval.current) &&
        this.allowImplementationEvidence &&
        (entry
          ? entry.state === TaskExecution.Implemented && entry.planDigest === task.planDigest
          : task.implementation !== undefined))
    );
  }
  blockers(task: TaskRecord): TaskBlocker[] {
    const reasons: TaskBlocker[] = [];
    const add = (kind: TaskBlocker["kind"], message: string, reference?: string) =>
      reasons.push({ kind, message, ...(reference ? { reference } : {}) });
    if (task.planning?.problem) add(TaskBlockerKind.State, task.planning.problem);
    if ((task.planning && !task.planning.approved) || (task.approval && !task.approval.current))
      add(TaskBlockerKind.State, "Review and approve the current plan");
    if (task.metadata.status !== "Approved")
      add(TaskBlockerKind.State, `Task is ${task.metadata.status.toLowerCase()}`);
    if (task.metadata.status === "Accepted" || task.metadata.status === "Canceled") return reasons;
    const entry = this.entries.get(task.reference);
    if (!entry && this.allowImplementationEvidence && task.implementation)
      add(
        TaskBlockerKind.Verification,
        `Implemented at ${task.implementation.baseline}; awaiting developer acceptance`,
      );
    if (entry?.state === TaskExecution.Active) add(TaskBlockerKind.Active, "Already active");
    if (entry?.state === TaskExecution.Blocked) add(TaskBlockerKind.Blocked, entry.reason ?? "Blocked");
    if (entry?.state === TaskExecution.Implemented)
      add(
        TaskBlockerKind.Verification,
        entry.planDigest === task.planDigest
          ? "Awaiting developer acceptance"
          : "Task changed after verification; release and reverify",
      );
    for (const id of task.dependencies) {
      const dependency = this.graph.byReference.get(id);
      if (!dependency) {
        add(TaskBlockerKind.Missing, `Task record is missing: ${id}`, id);
        continue;
      }
      if (!this.implemented(dependency))
        add(TaskBlockerKind.Dependency, `Waiting for ${id} (${dependency.metadata.status})`, id);
    }
    for (const child of this.graph.children.get(task.reference) ?? [])
      if (child.metadata.status !== "Canceled" && !this.implemented(child))
        add(TaskBlockerKind.Child, `Waiting for child ${child.reference}`, child.reference);
    return reasons;
  }
}
export function inspectQueue(readiness: TaskReadiness) {
  const queue = readiness.queue;
  const entries = queue.entries.map((entry, index) => {
    const task = readiness.graph.byReference.get(entry.reference);
    const blockers = task
      ? readiness.blockers(task)
      : [{ kind: TaskBlockerKind.Missing, message: "Task record is missing" }];
    return {
      ...entry,
      position: index + 1,
      title: task?.title ?? entry.reference,
      status: task?.metadata.status,
      ready: blockers.length === 0,
      blockers: blockers.map((blocker) => blocker.message),
    };
  });
  const ready = entries.filter((entry) => entry.ready).map((entry) => entry.reference);
  return { ...queue, digest: queueDigest(queue), entries, ready };
}
export function inspectTaskQueue(root: string) {
  return inspectQueue(new TaskReadiness(readWorkGraph(root), readTaskQueue(root)));
}
export type QueueChange =
  | { action: "add"; references: string[] }
  | { action: "remove" | "start" | "implemented" | "block" | "release"; reference: string; detail?: string }
  | { action: "move"; reference: string; before?: string; after?: string };
export function changeTaskQueue(root: string, change: QueueChange, expected?: string): TaskQueue {
  return withTaskLock(root, () => {
    const graph = readWorkGraph(root),
      queue = readTaskQueue(root);
    if (expected !== undefined && expected !== queueDigest(queue))
      throw new StateConflict("Task queue changed; refresh and retry");
    const now = new Date().toISOString();
    if (change.action === "add") {
      for (const value of change.references) {
        const reference = workReference(root, value),
          task = graph.require(reference);
        if (task.metadata.status !== "Approved" || (task.planning && !task.planning.approved))
          throw new StateConflict(`${reference}: approve the task before queueing it`);
        if (!queue.entries.some((entry) => entry.reference === reference))
          queue.entries.push({ reference, state: TaskExecution.Queued, updated: now });
      }
    } else {
      const reference = workReference(root, change.reference),
        index = queue.entries.findIndex((entry) => entry.reference === reference),
        entry = queue.entries[index];
      if (!entry) throw new InvalidInput(`${reference}: task is not in the local queue`);
      if (change.action === "move") {
        if (!!change.before === !!change.after) throw new InvalidInput("Supply exactly one of before or after");
        const target = workReference(root, change.before ?? change.after ?? "");
        if (target === reference || !queue.entries.some((entry) => entry.reference === target))
          throw new InvalidInput("Choose a different queued task as the move target");
        queue.entries.splice(index, 1);
        const position = queue.entries.findIndex((entry) => entry.reference === target);
        queue.entries.splice(position + (change.after ? 1 : 0), 0, entry);
      } else if (change.action === "remove") {
        if (entry.state === TaskExecution.Active)
          throw new StateConflict("Release active work before removing it from the queue");
        queue.entries.splice(index, 1);
      } else {
        const task = graph.require(reference);
        if (change.action === "start") {
          if (task.planning)
            throw new StateConflict("Transfer the approved plan into an implementation task before starting it");
          const reasons = new TaskReadiness(graph, queue).blockers(task).map((blocker) => blocker.message);
          if (reasons.length) throw new StateConflict(`${reference}: ${reasons.join("; ")}`);
          entry.state = TaskExecution.Active;
          delete entry.evidence;
          delete entry.reason;
          entry.planDigest = task.planDigest;
        } else if (change.action === "implemented") {
          if (entry.state !== TaskExecution.Active && entry.state !== TaskExecution.Implemented)
            throw new StateConflict("Start the task before reporting it implemented");
          if (!change.detail?.trim()) throw new InvalidInput("Supply verification evidence for implemented work");
          if (task.metadata.status !== "Approved")
            throw new StateConflict("Task approval was revoked during implementation");
          const dependencies = new TaskReadiness(graph, {
            ...queue,
            entries: queue.entries.filter((item) => item !== entry),
          })
            .blockers(task)
            .filter((blocker) =>
              [TaskBlockerKind.Dependency, TaskBlockerKind.Child, TaskBlockerKind.Missing].some(
                (kind) => kind === blocker.kind,
              ),
            )
            .map((blocker) => blocker.message);
          if (dependencies.length) throw new StateConflict(dependencies.join("; "));
          entry.state = TaskExecution.Implemented;
          entry.evidence = change.detail.trim();
          entry.planDigest = task.planDigest;
          delete entry.reason;
          decodeQueue(queue);
          recordTaskImplementation(root, task, entry.evidence);
        } else if (change.action === "block") {
          if (!change.detail?.trim()) throw new InvalidInput("Supply the reason work is blocked");
          entry.state = TaskExecution.Blocked;
          entry.reason = change.detail.trim();
        } else {
          entry.state = TaskExecution.Queued;
          delete entry.reason;
          delete entry.evidence;
          delete entry.planDigest;
        }
        entry.updated = now;
      }
    }
    queue.revision++;
    store(root).write(queue);
    return queue;
  });
}

interface Transition {
  files: { path: string; before: string | null; after: string; mode?: number }[];
  before: TaskQueue;
  after: TaskQueue;
  decisions?: TaskDecisionChange;
}
function journal(path: string) {
  return new BoundedState<Transition | null>(
    () => path,
    16 * 1024 * 1024,
    (input) => {
      if (input === null) return null;
      if (
        !input ||
        typeof input !== "object" ||
        !("files" in input) ||
        !Array.isArray(input.files) ||
        !("before" in input) ||
        !("after" in input)
      )
        throw new InvalidInput("Invalid task transition recovery record");
      const files = input.files.map((value: unknown) => {
        if (
          !value ||
          typeof value !== "object" ||
          !("path" in value) ||
          typeof value.path !== "string" ||
          !("before" in value) ||
          (value.before !== null && typeof value.before !== "string") ||
          !("after" in value) ||
          typeof value.after !== "string"
        )
          throw new InvalidInput("Invalid task transition file");
        const mode = "mode" in value ? value.mode : undefined;
        if (mode !== undefined && (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o777))
          throw new InvalidInput("Invalid task transition mode");
        return {
          path: value.path,
          before: value.before,
          after: value.after,
          ...(typeof mode === "number" ? { mode } : {}),
        };
      });
      return {
        files,
        before: decodeQueue(input.before),
        after: decodeQueue(input.after),
        ...("decisions" in input ? { decisions: decodeTaskDecisionChange(input.decisions) } : {}),
      };
    },
    () => null,
  );
}
function current(root: string, path: string): string | null {
  const absolute = ownedPath(root, path);
  return existsSync(absolute)
    ? readBoundedFile(absolute, 16 * 1024 * 1024, "task transition file").toString("base64")
    : null;
}
/** The task lock protects recovery and publication. Unexpected user edits always win over automatic recovery. */
export function recoverTaskTransition(root: string, queuePath: string): void {
  const path = queuePath + ".transition.json",
    pending = journal(path).read();
  if (!pending) return;
  const edits = new ProjectEdits(root);
  let started = false;
  for (const file of pending.files) {
    const bytes = current(root, file.path);
    if (bytes !== file.before && bytes !== file.after)
      throw new StateConflict(
        `Task transition recovery conflicts with ${file.path}; preserve your edits and inspect ${path}`,
      );
    started ||= bytes !== file.before;
    if (bytes !== file.after) edits.write(file.path, Buffer.from(file.after, "base64"), file.mode);
  }
  const queue = readTaskQueue(root),
    digest = queueDigest(queue);
  if (digest !== queueDigest(pending.before) && digest !== queueDigest(pending.after))
    throw new StateConflict(`Task queue changed during recovery; inspect ${path}`);
  started ||= pending.decisions !== undefined && decisionChangeApplied(root, pending.decisions);
  if (started) {
    edits.apply();
    syncMaps(root);
    if (queueDigest(pending.before) !== queueDigest(pending.after)) writeTaskQueue(root, pending.after);
    if (pending.decisions) applyTaskDecisionChange(root, pending.decisions);
  }
  rmSync(path);
}
export function publishTaskTransition(
  root: string,
  edits: ProjectEdits,
  before: TaskQueue,
  after: TaskQueue,
  decisions?: TaskDecisionChange,
): void {
  const path = taskQueuePath(root) + ".transition.json";
  journal(path).write({
    before,
    after,
    ...(decisions ? { decisions } : {}),
    files: [...edits.files.values()].map((file) => ({
      path: file.path,
      before: file.previous?.toString("base64") ?? null,
      after: file.contents.toString("base64"),
      ...(file.mode === undefined ? {} : { mode: file.mode }),
    })),
  });
  // ProjectEdits rolls back synchronous publication failures. The journal survives interruption or map failure.
  edits.apply();
  syncMaps(root);
  if (queueDigest(before) !== queueDigest(after)) writeTaskQueue(root, after);
  if (decisions) applyTaskDecisionChange(root, decisions);
  rmSync(path);
}
