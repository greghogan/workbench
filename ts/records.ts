import { existsSync } from "node:fs";
import { join } from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import {
  kinds,
  nextNumber,
  normalizedNumber,
  parseReference,
  readProjects,
  readText,
  relativeRecordPath,
  rootOf,
  scan,
  selectProject,
  writeNew,
  type Kind,
  type Project,
} from "./core.js";
import { parseCitation } from "./citations.js";
import { parseRelease } from "./releases.js";

const requiredProtocol = [
  "Hypothesis",
  "Candidate and baseline",
  "Independent variable",
  "Controls and correctness",
  "Workload",
  "Evaluation rule",
];
const terminalTask = new Set(["Done", "Canceled"]);

export function field(contents: string, name: string): string | undefined {
  return contents
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${name}: `))
    ?.slice(name.length + 2);
}

export function section(contents: string, heading: string): boolean {
  const lines = contents.split(/\r?\n/);
  const index = lines.indexOf(`## ${heading}`);
  if (index < 0) return false;
  for (const line of lines.slice(index + 1)) {
    if (line.startsWith("## ")) return false;
    if (line.trim()) return true;
  }
  return false;
}

function title(value: string | undefined): string {
  if (!value?.trim() || /[\r\n]/.test(value)) throw new Error("record title must be one nonempty line");
  return value.trim();
}

export function createRecord(
  root: string,
  kind: Kind,
  projectId: string | undefined,
  contents: (number: string, project: Project) => string,
): string {
  const project = selectProject(root, projectId);
  const records = scan(rootOf(root, project), kind);
  const number = records.length ? nextNumber(records[records.length - 1]!.number) : "0";
  const path = join(rootOf(root, project), "workbench", relativeRecordPath(kind, number));
  writeNew(path, contents(number, project));
  console.log(`Created ${project.id}:${kind}-${number} at ${path}.`);
  if (kind === "ADR") console.log("A human must review its exact text before commit.");
  return path;
}

export function addRecord(
  root: string,
  kindInput: string,
  titleInput: string | undefined,
  projectId?: string,
  parent?: string,
  dependencies: string[] = [],
): string {
  const kind = kindInput.toUpperCase() as Kind;
  if (!kinds.includes(kind)) throw new Error(`unknown record type: ${kindInput}`);
  if (kind === "EXP")
    throw new Error("use 'workbench experiment start TITLE PROTOCOL_PATH' once the protocol is ready");
  if (kind === "REL") throw new Error("use 'workbench release add SPECIFICATION_PATH' after publishing artifacts");
  if (kind !== "TSK" && (parent || dependencies.length))
    throw new Error("--parent and --depends-on apply only to TSK records");
  const recordTitle = title(titleInput);
  return createRecord(root, kind, projectId, (number, project) => {
    if (kind === "ADR")
      return `# ADR-${number}: ${recordTitle}\n\nSummary: Add a one-sentence summary before review.\n`;
    if (kind === "TSK")
      return (
        `# TSK-${number}: ${recordTitle}\n\nStatus: Planned\nParent: ${parent ?? "None"}\n` +
        `Depends on: ${dependencies.join(", ") || "None"}\n\n## Context\n\n## Plan\n\n## Findings\n\n## Outcome\n\n## Validation\n`
      );
    if (kind === "ENV") return `# ENV-${number}: ${recordTitle}\n\n## Hardware configuration\n\n## Limits\n`;
    return yamlStringify({
      references: [{ id: `${project.id}-CIT-${number}`, type: "article", title: recordTitle }],
      workbench: { sources: [] },
    });
  });
}

export function startExperiment(root: string, recordTitle: string, protocolPath: string, projectId?: string): string {
  const protocol = readText(protocolPath);
  const environment = protocol.split(/\r?\n/).filter((line) => line.startsWith("Environment: "));
  if (environment.length !== 1 || !environment[0]?.slice(13).trim()) {
    throw new Error(`${protocolPath}: expected exactly one nonempty 'Environment:' field`);
  }
  for (const heading of requiredProtocol) {
    if (!section(protocol, heading)) throw new Error(`${protocolPath}: missing or empty ## ${heading}`);
  }
  return createRecord(
    root,
    "EXP",
    projectId,
    (number) =>
      `# EXP-${number}: ${title(recordTitle)}\n\nStatus: Running\n\n${protocol.trim()}\n\n` +
      "## Execution provenance\n\n## Evidence\n\n## Decision\n",
  );
}

export function openRecord(root: string, reference: string): void {
  const resolved = parseReference(root, reference);
  if (!existsSync(resolved.path)) throw new Error(`record not found: ${reference}`);
  console.log(`${resolved.path}\n${readText(resolved.path)}`);
}

function oneField(contents: string, name: string, path: string, errors: string[]): string | undefined {
  const values = contents.split(/\r?\n/).filter((line) => line.startsWith(`${name}: `));
  if (values.length > 1) errors.push(`${path}: expected at most one '${name}:' field`);
  return values[0]?.slice(name.length + 2);
}

function validateContent(kind: Kind, number: string, path: string, contents: string, errors: string[]): void {
  if (kind === "CIT") {
    try {
      parseCitation(contents, path);
    } catch (error) {
      errors.push(String(error));
    }
    return;
  }
  if (kind === "REL") {
    try {
      parseRelease(contents, path, number);
    } catch (error) {
      errors.push(String(error));
    }
    return;
  }
  const prefix = `# ${kind}-${number}: `;
  if (!contents.startsWith(prefix) || !contents.split("\n", 1)[0]?.slice(prefix.length).trim()) {
    errors.push(`${path}: expected a titled ${prefix}heading`);
  }
  if (kind === "ADR") {
    if (!oneField(contents, "Summary", path, errors)?.trim()) errors.push(`${path}: missing one-line 'Summary:' field`);
    const lines = contents.split(/\r?\n/);
    const indices = lines.flatMap((line, index) => (line.startsWith("Agent instruction:") ? [index] : []));
    if (indices.length > 1 || indices.some((index) => !lines[index]!.slice(18).trim() || lines[index + 1] !== "")) {
      errors.push(`${path}: 'Agent instruction:' must be one nonempty line`);
    }
  }
  if (kind === "TSK") {
    if (!["Planned", "Active", "Blocked", "Done", "Canceled"].includes(field(contents, "Status") ?? "")) {
      errors.push(`${path}: invalid or missing task 'Status:' field`);
    }
    for (const name of ["Parent", "Depends on"]) {
      if (!oneField(contents, name, path, errors)?.trim())
        errors.push(`${path}: missing one nonempty '${name}:' field`);
    }
  }
  if (kind === "EXP") {
    const status = field(contents, "Status");
    if (!["Running", "Accepted", "Rejected", "Inconclusive"].includes(status ?? "")) {
      errors.push(`${path}: invalid or missing experiment 'Status:' field`);
    }
    if (!oneField(contents, "Environment", path, errors)?.trim())
      errors.push(`${path}: missing one 'Environment:' field`);
    for (const heading of requiredProtocol) {
      if (!section(contents, heading)) errors.push(`${path}: missing or empty ## ${heading}`);
    }
    if (status && status !== "Running") {
      for (const heading of ["Execution provenance", "Evidence", "Decision"]) {
        if (!section(contents, heading)) errors.push(`${path}: completed experiment needs ## ${heading}`);
      }
    }
  }
  if (kind === "ENV") {
    for (const heading of ["Hardware configuration", "Limits"]) {
      if (!section(contents, heading)) errors.push(`${path}: missing or empty ## ${heading}`);
    }
  }
}

export function validateRecords(projectDirectory: string): string[] {
  const errors: string[] = [];
  for (const kind of kinds) {
    try {
      for (const record of scan(projectDirectory, kind)) {
        validateContent(kind, record.number, record.path, readText(record.path), errors);
      }
    } catch (error) {
      errors.push(String(error));
    }
  }
  return errors;
}

function canonical(
  root: string,
  value: string,
  expected: Kind,
  path: string,
  name: string,
  errors: string[],
): string | undefined {
  if (value === "None") return undefined;
  try {
    const parsed = parseReference(root, value);
    if (parsed.kind !== expected) throw new Error(`expected a ${expected} reference`);
    return `${parsed.project.id}:${expected}-${parsed.number}`;
  } catch (error) {
    errors.push(`${path}: invalid '${name}:' field: ${String(error)}`);
    return undefined;
  }
}

export function validateRelationships(root: string): string[] {
  const errors: string[] = [];
  type Task = { path: string; status: string; parent: string | undefined; dependencies: string[] };
  const tasks = new Map<string, Task>();
  const environments = new Set<string>();
  const experiments: string[] = [];
  for (const project of readProjects(root)) {
    const projectDirectory = rootOf(root, project);
    for (const record of scan(projectDirectory, "ENV")) environments.add(`${project.id}:ENV-${record.number}`);
    for (const record of scan(projectDirectory, "TSK")) {
      const contents = readText(record.path);
      const dependencies =
        field(contents, "Depends on")
          ?.split(",")
          .map((value) => value.trim()) ?? [];
      tasks.set(`${project.id}:TSK-${record.number}`, {
        path: record.path,
        status: field(contents, "Status") ?? "",
        parent: canonical(root, field(contents, "Parent") ?? "None", "TSK", record.path, "Parent", errors),
        dependencies: dependencies
          .filter((value) => value !== "None")
          .map((value) => canonical(root, value, "TSK", record.path, "Depends on", errors))
          .filter((value): value is string => !!value),
      });
    }
    experiments.push(...scan(projectDirectory, "EXP").map((record) => record.path));
  }
  for (const [reference, task] of tasks) {
    const dependencies = new Set<string>();
    for (const dependency of task.dependencies) {
      if (dependencies.has(dependency)) errors.push(`${task.path}: duplicate 'Depends on:' reference: ${dependency}`);
      dependencies.add(dependency);
    }
    for (const linked of [...(task.parent ? [task.parent] : []), ...task.dependencies]) {
      if (linked === reference) errors.push(`${task.path}: task cannot reference itself`);
      else if (!tasks.has(linked)) errors.push(`${task.path}: task reference not found: ${linked}`);
    }
    if (terminalTask.has(task.status)) {
      for (const [childRef, child] of tasks) {
        if (child.parent === reference && !terminalTask.has(child.status)) {
          errors.push(`${task.path}: completed task has unfinished child ${childRef}`);
        }
      }
    }
  }
  for (const relationship of ["parent", "dependency"] as const) {
    const state = new Map<string, number>();
    const visit = (reference: string): void => {
      if (state.get(reference) === 1) {
        errors.push(`task ${relationship} cycle includes ${reference}`);
        return;
      }
      if (state.get(reference) === 2) return;
      state.set(reference, 1);
      const task = tasks.get(reference);
      for (const linked of relationship === "parent" ? (task?.parent ? [task.parent] : []) : (task?.dependencies ?? []))
        visit(linked);
      state.set(reference, 2);
    };
    for (const reference of tasks.keys()) visit(reference);
  }
  for (const path of experiments) {
    const environment = canonical(
      root,
      field(readText(path), "Environment") ?? "None",
      "ENV",
      path,
      "Environment",
      errors,
    );
    if (environment && !environments.has(environment))
      errors.push(`${path}: environment reference not found: ${environment}`);
  }
  return errors;
}

export function recordTitle(kind: Kind, number: string, contents: string): string {
  if (kind === "CIT") {
    const parsed = yamlParse(contents) as { references?: Array<{ title?: string }> };
    return parsed.references?.[0]?.title ?? "Untitled";
  }
  if (kind === "REL") {
    const parsed = yamlParse(contents) as { version?: string };
    return parsed.version ?? "Unknown";
  }
  const prefix = `# ${kind}-${normalizedNumber(number)}: `;
  const first = contents.split(/\r?\n/, 1)[0] ?? "";
  if (!first.startsWith(prefix) || !first.slice(prefix.length).trim())
    throw new Error(`invalid title for ${kind}-${number}`);
  return first.slice(prefix.length);
}
