import { required } from "./invariants.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stringify as yamlStringify, parse as yamlParse, parseDocument } from "yaml";
import {
  kinds,
  normalizedNumber,
  parseReference,
  readConfig,
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
import { reserveRecordNumber } from "./record-sequences.js";
import { formatDocument } from "./formatting.js";
import {
  parseProseRecord,
  recordDocument,
  renderProseRecord,
  terminalTask,
  taskStatuses,
  experimentStatuses,
  splitFrontmatter,
} from "./record-document.js";

const requiredProtocol = [
  "Hypothesis",
  "Candidate and baseline",
  "Independent variable",
  "Controls and correctness",
  "Workload",
  "Evaluation rule",
];
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

export async function createRecord(
  root: string,
  kind: Kind,
  projectId: string | undefined,
  contents: (number: string, project: Project) => string,
): Promise<string> {
  const project = selectProject(root, projectId);
  const number = reserveRecordNumber(rootOf(root, project), kind);
  const path = join(rootOf(root, project), "workbench", relativeRecordPath(kind, number));
  const formatted = await formatDocument(
    contents(number, project),
    path,
    required(
      required(readConfig(root).markdown, "expected readConfig(root).markdown").wrap_width,
      "expected readConfig(root).markdown!.wrap_width",
    ),
  );
  writeNew(path, formatted);
  console.log(`Created ${project.id}:${kind}-${number} at ${path}.`);
  if (kind === "ADR") console.log("A human must review its exact text before commit.");
  return path;
}

export async function addRecord(
  root: string,
  kindInput: string,
  titleInput: string | undefined,
  projectId?: string,
  parent?: string,
  dependencies: string[] = [],
  bodyInput?: string,
): Promise<string> {
  const kind = kindInput.toUpperCase() as Kind;
  if (!kinds.includes(kind)) throw new Error(`unknown record type: ${kindInput}`);
  if (kind === "EXP")
    throw new Error("use 'workbench experiment add TITLE --protocol PROTOCOL_PATH' once the protocol is ready");
  if (kind === "REL") throw new Error("use 'workbench release add SPECIFICATION_PATH' after publishing artifacts");
  if (kind !== "TSK" && (parent || dependencies.length))
    throw new Error("--parent and --depends-on apply only to TSK records");
  if (kind === "TSK")
    for (const reference of [...(parent ? [parent] : []), ...dependencies]) {
      const parsed = parseReference(root, reference);
      if (parsed.kind !== "TSK") throw new Error(`expected a task reference: ${reference}`);
      if (!existsSync(parsed.path)) throw new Error(`task not found: ${reference}`);
    }
  const recordTitle = title(titleInput);
  if (bodyInput !== undefined && /^---(?:\r?\n|$)/.test(bodyInput))
    throw new Error("task --from accepts a Markdown body without frontmatter; use options for task metadata");
  return createRecord(root, kind, projectId, (number, project) => {
    const heading = `# ${kind}-${number}: ${recordTitle}\n\n`;
    if (kind === "ADR") return renderProseRecord({ summary: "Add a one-sentence summary before review." }, heading);
    if (kind === "TSK")
      return renderProseRecord(
        { status: "Planned", parent: parent ?? null, depends_on: dependencies },
        heading + (bodyInput ?? "## Context\n\n## Plan\n\n## Findings\n\n## Outcome\n\n## Validation\n"),
      );
    if (kind === "ENV") return renderProseRecord({}, heading + "## Hardware configuration\n\n## Limits\n");
    return yamlStringify({
      references: [{ id: `${project.id}-CIT-${number}`, type: "article", title: recordTitle }],
      workbench: { sources: [] },
    });
  });
}

export async function startExperiment(
  root: string,
  recordTitle: string,
  protocolPath: string,
  projectId?: string,
): Promise<string> {
  const recordName = title(recordTitle);
  const protocol = readText(protocolPath);
  parseProseRecord(protocol, protocolPath);
  const frontmatter = parseDocument(required(splitFrontmatter(protocol), "expected splitFrontmatter(protocol)").yaml);
  frontmatter.set("status", "Running");
  const header = `---\n${frontmatter.toString()}---\n\n`;
  const { metadata, body } = recordDocument(
    "EXP",
    header + required(splitFrontmatter(protocol), "expected splitFrontmatter(protocol)").body,
    protocolPath,
  );
  if (metadata.environment && !existsSync(parseReference(root, metadata.environment).path))
    throw new Error(`environment record not found: ${metadata.environment}`);
  for (const heading of requiredProtocol) {
    if (!section(body, heading)) throw new Error(`${protocolPath}: missing or empty ## ${heading}`);
  }
  return createRecord(
    root,
    "EXP",
    projectId,
    (number) =>
      `${header}# EXP-${number}: ${recordName}\n\n${body}\n\n## Execution provenance\n\n## Evidence\n\n## Decision\n`,
  );
}

export function openRecord(root: string, reference: string, json = false): void {
  const resolved = parseReference(root, reference);
  if (!existsSync(resolved.path)) throw new Error(`record not found: ${reference}`);
  const contents = readText(resolved.path);
  if (json)
    console.log(
      JSON.stringify(
        { reference, title: recordTitle(resolved.kind, resolved.number, contents), path: resolved.path, contents },
        null,
        2,
      ),
    );
  else console.log(`${resolved.path}\n${contents}`);
}

export interface RecordQuery {
  type?: string;
  project?: string;
  status?: string;
  all?: boolean;
  json?: boolean;
  matches?: boolean;
}

export function queryRecords(root: string, options: RecordQuery, query?: string): void {
  const kind = options.type?.toUpperCase() as Kind | undefined;
  if (kind && !kinds.includes(kind)) throw new Error(`unknown record type: ${String(options.type)}`);
  if (options.status) {
    const allowed = [
      ...(!kind || kind === "TSK" ? taskStatuses : []),
      ...(!kind || kind === "EXP" ? experimentStatuses : []),
    ];
    if (
      !allowed.some(
        (status) => status.toLowerCase() === required(options.status, "expected options.status").toLowerCase(),
      )
    )
      throw new Error(
        `invalid status '${options.status}'; expected ${allowed.join(", ") || "a task or experiment query"}`,
      );
  }
  const selected = options.project ? [selectProject(root, options.project)] : readProjects(root);
  const needle = query?.toLocaleLowerCase();
  if (query !== undefined && !query.trim()) throw new Error("search query must be nonempty");
  const matches: { reference: string; title: string; status?: string; path: string; matches?: string[] }[] = [];
  for (const project of selected) {
    for (const recordKind of kind ? [kind] : kinds) {
      for (const record of scan(rootOf(root, project), recordKind)) {
        const contents = readText(record.path);
        const reference = `${project.id}:${recordKind}-${record.number}`;
        const status =
          recordKind === "TSK" || recordKind === "EXP"
            ? recordDocument(recordKind, contents, record.path).metadata.status
            : undefined;
        if (options.status && status?.toLowerCase() !== options.status.toLowerCase()) continue;
        if (!options.all && !options.status && recordKind === "TSK" && terminalTask.has(status ?? "")) continue;
        if (needle && !`${reference}\n${contents}`.toLocaleLowerCase().includes(needle)) continue;
        matches.push({
          reference,
          title: recordTitle(recordKind, record.number, contents),
          ...(status ? { status } : {}),
          path: record.path,
          ...(needle
            ? {
                matches: contents
                  .split(/\r?\n/)
                  .flatMap((line, index) =>
                    line.toLocaleLowerCase().includes(needle) ? [`${String(index + 1)}: ${line}`] : [],
                  ),
              }
            : {}),
        });
      }
    }
  }
  if (options.json) console.log(JSON.stringify(matches, null, 2));
  else if (!matches.length) console.log("No matching records.");
  else
    for (const match of matches) {
      console.log(`${match.reference}: ${match.title}${match.status ? ` (${match.status})` : ""}`);
      if (options.matches) for (const line of match.matches ?? []) console.log(`  ${line}`);
    }
}

function validateContent(kind: Kind, number: string, path: string, contents: string, errors: string[]): void {
  if (kind === "CIT") {
    parseCitation(contents, path);
    return;
  }
  if (kind === "REL") {
    parseRelease(contents, path, number);
    return;
  }
  const { metadata, body } = recordDocument(kind, contents, path);
  recordTitle(kind, number, contents);
  if (kind === "EXP") {
    for (const heading of requiredProtocol) {
      if (!section(body, heading)) errors.push(`${path}: missing or empty ## ${heading}`);
    }
    if (metadata.status !== "Running") {
      for (const heading of ["Execution provenance", "Evidence", "Decision"]) {
        if (!section(body, heading)) errors.push(`${path}: completed experiment needs ## ${heading}`);
      }
    }
  }
  if (kind === "ENV")
    for (const heading of ["Hardware configuration", "Limits"]) {
      if (!section(body, heading)) errors.push(`${path}: missing or empty ## ${heading}`);
    }
}

export function validateRecords(projectDirectory: string): string[] {
  const errors: string[] = [];
  for (const kind of kinds) {
    try {
      for (const record of scan(projectDirectory, kind)) {
        try {
          validateContent(kind, record.number, record.path, readText(record.path), errors);
        } catch (error) {
          errors.push(String(error));
        }
      }
    } catch (error) {
      errors.push(String(error));
    }
  }
  return errors;
}

function canonical(
  root: string,
  value: string | null | undefined,
  expected: Kind,
  path: string,
  name: string,
  errors: string[],
): string | undefined {
  if (value == null) return undefined;
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
  interface Task {
    path: string;
    status: string;
    parent: string | undefined;
    dependencies: string[];
  }
  const tasks = new Map<string, Task>();
  const environments = new Set<string>();
  const experiments: string[] = [];
  for (const project of readProjects(root)) {
    const projectDirectory = rootOf(root, project);
    for (const record of scan(projectDirectory, "ENV")) environments.add(`${project.id}:ENV-${record.number}`);
    for (const record of scan(projectDirectory, "TSK")) {
      const { metadata } = recordDocument("TSK", readText(record.path), record.path);
      tasks.set(`${project.id}:TSK-${record.number}`, {
        path: record.path,
        status: required(metadata.status, "expected metadata.status"),
        parent: canonical(root, metadata.parent, "TSK", record.path, "parent", errors),
        dependencies: required(metadata.depends_on, "expected metadata\n          .depends_on")
          .map((value) => canonical(root, value, "TSK", record.path, "depends_on", errors))
          .filter((value): value is string => !!value),
      });
    }
    experiments.push(...scan(projectDirectory, "EXP").map((record) => record.path));
  }
  for (const [reference, task] of tasks) {
    const dependencies = new Set<string>();
    for (const dependency of task.dependencies) {
      if (dependencies.has(dependency)) errors.push(`${task.path}: duplicate 'depends_on' reference: ${dependency}`);
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
      recordDocument("EXP", readText(path), path).metadata.environment,
      "ENV",
      path,
      "environment",
      errors,
    );
    if (environment && !environments.has(environment))
      errors.push(`${path}: environment reference not found: ${environment}`);
  }
  return errors;
}

export function recordTitle(kind: Kind, number: string, contents: string): string {
  if (kind === "CIT") {
    const parsed = yamlParse(contents) as { references?: { title?: string }[] };
    return parsed.references?.[0]?.title ?? "Untitled";
  }
  if (kind === "REL") {
    const parsed = yamlParse(contents) as { version?: string };
    return parsed.version ?? "Unknown";
  }
  const prefix = `# ${kind}-${normalizedNumber(number)}: `;
  const first = parseProseRecord(contents, `${kind}-${number}`).body.split(/\r?\n/, 1)[0] ?? "";
  if (!first.startsWith(prefix) || !first.slice(prefix.length).trim())
    throw new Error(`invalid title for ${kind}-${number}`);
  return first.slice(prefix.length);
}
