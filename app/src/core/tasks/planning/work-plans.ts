import { taskRepositoryDirectory } from "../task-project-state.js";
import { readTaskGraph, taskDigest, TaskGraph, taskReference, type TaskRecord } from "../task-model.js";
import { taskPlanDigest } from "../task-plan.js";
import { currentProject, selectProject } from "../../projects/project-configuration.js";
import { InvalidInput } from "../../runtime/input-errors.js";
import { parsePlanReference, planPrefix, planningPaths } from "./plan-model.js";
import { readPlanningRecords, type PlanningRecord } from "./planning-read-model.js";

export function workReference(root: string, value: string, project?: string): string {
  if (!value.includes(":plan/") && !value.startsWith("plan/")) return taskReference(root, value, project);
  const identity = parsePlanReference(value.includes(":") ? value : `${project ?? currentProject(root)}:${value}`);
  if (project && identity.scope !== selectProject(root, project).id)
    throw new InvalidInput("Plan conflicts with the selected project scope");
  return identity.reference;
}
/** Personal incomplete plans cannot make the project's committed record graph invalid. */
export function workGraph(tasks: TaskRecord[], plans: PlanningRecord[]): TaskGraph {
  const known = new Set(tasks.map((task) => task.reference)),
    mapping = new Map(
      plans.flatMap((plan) =>
        plan.implementation && known.has(plan.implementation.task)
          ? [[plan.reference, plan.implementation.task] as const]
          : [],
      ),
    );
  const mapped = (reference: string) => mapping.get(reference) ?? reference;
  const planned = plans
    .filter((plan) => !mapping.has(plan.reference))
    .map((plan): TaskRecord => ({
      reference: plan.reference,
      title: plan.title,
      path: planPrefix(plan) + planningPaths.document,
      contents: plan.contents,
      metadata: {
        status: plan.status === "Approved" && !plan.approval?.current ? "Planned" : plan.status,
        ...(plan.parent ? { parent: mapped(plan.parent) } : {}),
        depends_on: plan.dependencies.map(mapped),
      },
      ...(plan.parent ? { parent: mapped(plan.parent) } : {}),
      dependencies: plan.dependencies.map(mapped),
      digest: plan.digest,
      planDigest: plan.problem ? taskDigest(plan.contents) : taskPlanDigest(plan.contents),
      planning: {
        name: plan.name,
        ...(plan.implementation
          ? { problem: `Implementation started as ${plan.implementation.task} in ${plan.implementation.checkout}` }
          : {}),
        approved: plan.approval?.current === true,
        ...(plan.problem ? { problem: plan.problem } : {}),
        ...(plan.conflict ? { problem: "Resolve concurrent planning edits before starting work" } : {}),
      },
    }));
  const graph = new TaskGraph([...tasks, ...planned]);
  for (const task of planned)
    for (const reference of [...task.dependencies, ...(task.parent ? [task.parent] : [])])
      if (!graph.byReference.has(reference) && task.planning)
        task.planning.problem = `Referenced work is unavailable: ${reference}`;
  const done = new Set<string>(),
    active: string[] = [];
  const visit = (task: TaskRecord) => {
    const cycle = active.indexOf(task.reference);
    if (cycle >= 0 || active.length > 128) {
      for (const reference of active.slice(Math.max(0, cycle))) {
        const item = graph.byReference.get(reference);
        if (item?.planning) item.planning.problem = "Plan relationships contain a cycle or exceed the supported depth";
      }
      return;
    }
    if (done.has(task.reference)) return;
    active.push(task.reference);
    for (const reference of [
      ...task.dependencies,
      ...(graph.children.get(task.reference) ?? []).map((child) => child.reference),
    ]) {
      const next = graph.byReference.get(reference);
      if (next) visit(next);
    }
    active.pop();
    done.add(task.reference);
  };
  for (const task of planned) visit(task);
  for (const task of planned) if (task.planning?.problem) delete task.parent;
  return new TaskGraph([...tasks, ...planned]);
}
export function readWorkGraph(root: string): TaskGraph {
  return workGraph(readTaskGraph(root).tasks, taskRepositoryDirectory(root) ? readPlanningRecords(root) : []);
}
