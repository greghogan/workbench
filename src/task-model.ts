import { createHash } from "node:crypto";
import { readProjects, selectProject } from "./project-configuration.js";
import { rootOf } from "./project-context.js";
import { scan, parseReference } from "./record-files.js";
import { recordTitle, recordDocument, type MetadataByKind } from "./record-document.js";
import { readBoundedFile } from "./file-reads.js";
import { InvalidInput, MissingResource } from "./input-errors.js";

import { attachTaskImplementations, type ApplicableTaskImplementation } from "./task-implementations.js";

export interface TaskRecord {
  implementation?: ApplicableTaskImplementation;
  reference: string;
  title: string;
  path: string;
  contents: string;
  metadata: MetadataByKind["TSK"];
  parent?: string;
  dependencies: string[];
  digest: string;
  planDigest: string;
}
export const taskDigest = (contents: string): string => createHash("sha256").update(contents).digest("hex");

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
  const { metadata, body } = recordDocument("TSK", contents, path);
  const plan = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "status"));
  return {
    reference,
    title: recordTitle("TSK", reference.split("TSK-")[1] ?? "", contents),
    path,
    contents,
    metadata,
    ...(metadata.parent ? { parent: taskReference(root, metadata.parent) } : {}),
    dependencies: (metadata.depends_on ?? []).map((value) => taskReference(root, value)),
    digest: taskDigest(contents),
    planDigest: taskDigest(
      JSON.stringify([
        plan,
        body.replace(
          /^(\s*- \[)[ xX](\] [a-z][a-z0-9_-]*:TSK-[0-9A-Z]+)(?: \((?:Planned|Approved|Accepted|Canceled)\))?/gim,
          "$1 $2",
        ),
      ]),
    ),
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
  const tasks = readProjects(root).flatMap((project) =>
    scan(rootOf(root, project), "TSK").map((file) => {
      const contents = readBoundedFile(file.path, 2 * 1024 * 1024, "task record").toString("utf8");
      return parseTask(root, `${project.id}:TSK-${file.number}`, file.path, contents);
    }),
  );
  const graph = new TaskGraph(tasks).validate();
  attachTaskImplementations(root, tasks);
  return graph;
}
export interface TaskNode {
  task: TaskRecord;
  children: TaskNode[];
}
