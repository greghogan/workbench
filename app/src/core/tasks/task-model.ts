import { taskPlanDigest } from "./task-plan.js";
import { attachTaskDecisions, type TaskApprovalView } from "./task-approvals.js";
import { recordInventory, readInventoryRecords } from "../records/archive-store.js";
import { taskDigest } from "./task-snapshot.js";
import { readProjects, selectProject } from "../projects/project-configuration.js";
import { parseReference } from "../records/record-files.js";
import { recordTitle, recordDocument, type MetadataByKind } from "../records/record-document.js";
import { InvalidInput, MissingResource } from "../runtime/input-errors.js";

import { attachTaskImplementations, type ApplicableTaskImplementation } from "./task-implementations.js";

export interface TaskRecord {
  archived?: boolean;
  implementation?: ApplicableTaskImplementation;
  reference: string;
  title: string;
  path: string;
  contents: string;
  metadata: MetadataByKind["TSK"];
  parent?: string;
  dependencies: string[];
  digest: string;
  reviewDigest?: string;
  approval?: TaskApprovalView;
  acceptanceNeedsReview?: true;
  planning?: { name: string; approved: boolean; problem?: string };
  planDigest: string;
}
export { taskDigest } from "./task-snapshot.js";

export function taskReference(root: string, value: string, project?: string): string {
  const scoped = value.includes(":")
    ? value
    : `${selectProject(root, project).id}:${value.includes("-") ? value : `TSK-${value}`}`;
  const parsed = parseReference(root, scoped);
  if (parsed.kind !== "TSK") throw new InvalidInput("Expected a task reference");
  if (project && selectProject(root, project).id !== parsed.project.id)
    throw new InvalidInput(`Task ${value} conflicts with --project ${project}`);
  return `${parsed.project.id}:TSK-${parsed.number}`;
}

export function parseTask(root: string, reference: string, path: string, contents: string): TaskRecord {
  const { metadata } = recordDocument("TSK", contents, path);
  return {
    reference,
    title: recordTitle("TSK", reference.split("TSK-")[1] ?? "", contents),
    path,
    contents,
    metadata,
    ...(metadata.parent ? { parent: taskReference(root, metadata.parent) } : {}),
    dependencies: (metadata.depends_on ?? []).map((value) => taskReference(root, value)),
    digest: taskDigest(contents),
    planDigest: taskPlanDigest(contents),
  };
}

export class TaskGraph {
  readonly byReference: Map<string, TaskRecord>;
  readonly children = new Map<string, TaskRecord[]>();
  constructor(readonly tasks: TaskRecord[]) {
    this.byReference = new Map(tasks.map((task) => [task.reference, task]));
    for (const task of tasks)
      if (task.parent) {
        const siblings = this.children.get(task.parent) ?? [];
        siblings.push(task);
        this.children.set(task.parent, siblings);
      }
  }
  validate(): this {
    for (const task of this.tasks) {
      if (new Set(task.dependencies).size !== task.dependencies.length)
        throw new InvalidInput(`${task.reference}: duplicate dependency`);
      for (const id of [...task.dependencies, ...(task.parent ? [task.parent] : [])])
        if (!this.byReference.has(id)) throw new InvalidInput(`${task.reference}: task reference not found: ${id}`);
    }
    // Completion follows children and execution follows dependencies; their combined graph must be acyclic.
    const visited = new Set<string>(),
      active: string[] = [];
    const visit = (task: TaskRecord, depth: number) => {
      if (active.includes(task.reference))
        throw new InvalidInput(
          `Task relationship cycle: ${[...active.slice(active.indexOf(task.reference)), task.reference].join(" -> ")}. Parents wait for their children; tasks wait for their dependencies.`,
        );
      if (visited.has(task.reference)) return;
      if (depth > 128) throw new InvalidInput("Task relationships exceed 128 levels");
      active.push(task.reference);
      for (const id of [
        ...task.dependencies,
        ...(this.children.get(task.reference) ?? []).map((child) => child.reference),
      ]) {
        const next = this.byReference.get(id);
        if (next) visit(next, depth + 1);
      }
      active.pop();
      visited.add(task.reference);
    };
    for (const task of this.tasks) visit(task, 0);
    return this;
  }
  forest(selected = this.tasks): TaskNode[] {
    const references = new Set(selected.map((task) => task.reference));
    let count = 0;
    const node = (task: TaskRecord, depth: number): TaskNode => {
      if (depth > 128) throw new InvalidInput("Task hierarchy exceeds 128 levels");
      count++;
      return {
        task,
        children: (this.children.get(task.reference) ?? [])
          .filter((child) => references.has(child.reference))
          .map((child) => node(child, depth + 1)),
      };
    };
    const roots = selected.filter((task) => !task.parent || !references.has(task.parent)).map((task) => node(task, 0));
    if (count !== selected.length) throw new InvalidInput("Task parent cycle leaves unreachable plans");
    return roots;
  }
  require(reference: string): TaskRecord {
    const task = this.byReference.get(reference);
    if (!task) throw new MissingResource(`Task not found: ${reference}`);
    return task;
  }
}

export function readTaskGraph(root: string): TaskGraph {
  const tasks = readProjects(root).flatMap((project) => {
    const files = recordInventory(root, project.path, "TSK");
    const bodies = readInventoryRecords(root, files);
    return files.map((file) => {
      const contents = bodies.get(file.path)?.toString("utf8");
      if (contents === undefined) throw new MissingResource(`Missing task: ${file.path}`);
      return {
        ...parseTask(root, `${project.id}:TSK-${file.number}`, file.path, contents),
        ...(file.archive ? { archived: true } : {}),
      };
    });
  });
  attachTaskDecisions(root, tasks);
  const graph = new TaskGraph(tasks).validate();
  attachTaskImplementations(root, tasks);
  return graph;
}
export interface TaskNode {
  task: TaskRecord;
  children: TaskNode[];
}
