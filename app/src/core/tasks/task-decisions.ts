import {
  decodeTaskDecisionChange,
  decodeState,
  decisionIdentity,
  type TaskDecision,
  type TaskDecisionState,
  type TaskDecisionChange,
} from "./task-decision-state.js";
export { decodeTaskDecisionChange, type TaskDecision, type TaskDecisionChange } from "./task-decision-state.js";
import { copyTaskPlanApprovals } from "./task-approval-store.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { record, records } from "../runtime/values.mjs";
import { BoundedState } from "../storage/bounded-state.js";
import { withCacheLocksSync } from "../storage/cache-lock.js";
import { taskProjectStateFile, taskRepositoryDirectory } from "./task-project-state.js";

const decisionPaths = new AsyncLocalStorage<Map<string, string>>();
export function taskDecisionPath(root: string): string {
  return (
    decisionPaths.getStore()?.get(resolve(root)) ??
    taskProjectStateFile(taskRepositoryDirectory(root) ?? realpathSync.native(root), "task-decisions")
  );
}

/** Freeze project identity during a mutation so locking and publication address the same store. */
export function withTaskDecisionPath<T>(root: string, path: string, action: () => T): T {
  return decisionPaths.run(new Map([...(decisionPaths.getStore() ?? []), [resolve(root), path]]), action);
}

function store(path: string) {
  return new BoundedState<{ version: 1; tasks: TaskDecisionState[] }>(
    () => path,
    4 * 1024 * 1024,
    (input) => {
      const data = record(input, "Invalid task decision store"),
        tasks = records(data.tasks, "Invalid decided tasks").map(decodeState);
      if (
        data.version !== 1 ||
        Object.keys(data).some((key) => !["version", "tasks"].includes(key)) ||
        tasks.length > 20000 ||
        tasks.reduce((count, task) => count + task.decisions.length, 0) > 20000 ||
        new Set(tasks.map((task) => task.reference)).size !== tasks.length
      )
        throw new InvalidInput("Invalid task decision store fields, version, or size");
      return { version: 1, tasks };
    },
    () => ({ version: 1, tasks: [] }),
  );
}

export function readTaskDecisions(root: string): TaskDecision[] {
  return store(taskDecisionPath(root))
    .read()
    .tasks.flatMap((task) => task.decisions);
}

/** A revision remains even after revocation, so recovery cannot restore a superseded approval. */
export function prepareTaskDecisionChange(
  root: string,
  reference: string,
  update: (decisions: TaskDecision[]) => TaskDecision[],
): TaskDecisionChange {
  const current = store(taskDecisionPath(root))
    .read()
    .tasks.find((task) => task.reference === reference);
  const before = current?.decisions ?? [];
  const selected = new Map<string, TaskDecision>();
  for (const decision of update(structuredClone(before))) {
    const identity = decisionIdentity(decision);
    selected.delete(identity);
    selected.set(identity, decision);
  }
  const after = [...selected.values()];
  return decodeTaskDecisionChange({ reference, revision: current?.revision ?? 0, before, after });
}

function applied(current: TaskDecisionState | undefined, change: TaskDecisionChange): boolean {
  return (
    current?.revision === change.revision + 1 && JSON.stringify(current.decisions) === JSON.stringify(change.after)
  );
}
export function decisionChangeApplied(root: string, change: TaskDecisionChange): boolean {
  return applied(
    store(taskDecisionPath(root))
      .read()
      .tasks.find((task) => task.reference === change.reference),
    change,
  );
}

/** The task lock protects publication; recovery merges only the affected task's decision revision. */
export function applyTaskDecisionChange(root: string, change: TaskDecisionChange): void {
  const target = store(taskDecisionPath(root)),
    data = target.read(),
    current = data.tasks.find((task) => task.reference === change.reference);
  if (applied(current, change)) return;
  if (
    (current?.revision ?? 0) !== change.revision ||
    JSON.stringify(current?.decisions ?? []) !== JSON.stringify(change.before)
  )
    throw new StateConflict(
      `${change.reference}: human decisions changed during recovery; preserve the newer decisions`,
    );
  const after = { reference: change.reference, revision: change.revision + 1, decisions: change.after };
  data.tasks = [...data.tasks.filter((task) => task.reference !== change.reference), after];
  target.write(data);
}

export function preserveRelocatedTaskDecisions(previous: string, root: string): void {
  const project = taskRepositoryDirectory(root) ?? realpathSync.native(root),
    location = relative(root, project);
  if (isAbsolute(location) || location === ".." || location.startsWith(".." + sep)) return;
  const source = taskProjectStateFile(resolve(previous, location), "task-decisions"),
    destination = taskDecisionPath(root);
  if (source === destination || !existsSync(source)) return;
  withCacheLocksSync(
    [source, destination].sort(),
    () => {
      const original = store(source).read(),
        target = store(destination),
        current = target.read(),
        indexed = new Map(current.tasks.map((task) => [task.reference, task]));
      for (const task of original.tasks) {
        const existing = indexed.get(task.reference);
        if (existing && JSON.stringify(existing) !== JSON.stringify(task))
          throw new StateConflict("Conflicting human task decisions at the destination; reconcile before relocating");
        if (!existing) {
          current.tasks.push(task);
          indexed.set(task.reference, task);
        }
      }
      copyTaskPlanApprovals(
        source,
        destination,
        original.tasks.flatMap((task) => task.decisions),
      );
      target.write(current);
    },
    { mutable: false },
  );
}
