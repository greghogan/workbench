import { existsSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { parseReference, readProjects, readText, rootOf, writeAtomic, type Project } from "./core.js";

function mappedInstructions(root: string, project: Project, path: string): Array<[string, string]> {
  const instructions: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const line of readText(path).split(/\r?\n/)) {
    if (!line.startsWith("- [")) continue;
    const match = /^- \[([^\]]+)\]\(([^)]+)\)$/.exec(line);
    if (!match?.[1] || !match[2]) throw new Error(`${path}: invalid decision link`);
    const [reference, link] = [match[1], match[2]];
    if (!reference.includes(":")) continue;
    const record = parseReference(root, reference);
    if (record.project.id !== project.id || record.kind !== "ADR") {
      throw new Error(`${path}: expected a ${project.id} ADR, got ${reference}`);
    }
    const canonicalLink = relative(join(rootOf(root, project), "workbench"), record.path);
    if (link !== canonicalLink) throw new Error(`${path}: ${reference} points to a noncanonical path`);
    if (seen.has(record.path)) throw new Error(`${path}: duplicate decision ${reference}`);
    seen.add(record.path);
    const notes = readText(record.path)
      .split(/\r?\n/)
      .filter((entry) => entry.startsWith("Agent instruction:"))
      .map((entry) => entry.slice("Agent instruction:".length).trim());
    if (notes.length > 1 || notes.some((note) => !note)) {
      throw new Error(`${record.path}: expected at most one nonempty 'Agent instruction:' field`);
    }
    if (notes[0]) instructions.push([reference, notes[0]]);
  }
  return instructions;
}

export function renderAgentContext(root: string): string {
  const projects = readProjects(root);
  const charter = readText(join(root, "workbench/CHARTER.md")).replace(/\n+$/, "");
  const localMap = join(root, "workbench/decision-map.md");
  const sharedRoot = join(root, ".workbench");
  const sharedMap = join(sharedRoot, "workbench/decision-map.md");
  const notes: Array<[string, string]> = [];
  let output = `# Agent context\n\n## Charter\n\n${charter}\n\n## Decision routing\n\n`;
  if (existsSync(sharedMap)) {
    const sharedProject = readProjects(sharedRoot)[0];
    if (!sharedProject) throw new Error(`${sharedRoot}: no root project registered`);
    notes.push(...mappedInstructions(sharedRoot, sharedProject, sharedMap));
    output += "Read the repository-root shared `.workbench/workbench/decision-map.md` after this file.\n";
  }
  if (existsSync(localMap)) {
    for (const project of projects) {
      const map = join(rootOf(root, project), "workbench/decision-map.md");
      if (existsSync(map)) notes.push(...mappedInstructions(root, project, map));
    }
    output += "Read this project's `workbench/decision-map.md` after this file.\n";
  }
  output +=
    existsSync(localMap) || existsSync(sharedMap)
      ? "Open individual ADRs when relevant detail is needed; do not read every ADR by default.\n" +
        "Changed ADRs require human approval before commit.\n"
      : "Read the decision map when it exists. Changed ADRs require human approval before commit.\n";
  if (notes.length) {
    output += "\n## Standing instructions from decisions\n";
    for (const [reference, note] of notes) output += `\n- \`${reference}\`:\n  ${note}`;
    output += "\n";
  }
  return `${output}\n`;
}

function owned(contents: string): boolean {
  if (contents.startsWith("# Agent context\n\n## Charter\n\n")) return true;
  for (const [start, end] of [
    ["<!-- workbench:generated:start -->", "<!-- workbench:generated:end -->"],
    ["<!-- workbench:bootstrap:start -->", "<!-- workbench:bootstrap:end -->"],
  ] as Array<[string, string]>) {
    const before = contents.split(start, 1)[0] ?? "";
    const after = contents.split(end).slice(1).join(end);
    if (contents.includes(start) && contents.includes(end) && !before.trim() && !after.trim()) return true;
  }
  return false;
}

export function syncAgents(root: string, checkOnly = false): string[] {
  const path = join(root, "AGENTS.md");
  const expected = renderAgentContext(root);
  let actual: string | undefined;
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error(`${path}: must be a regular file`);
    actual = readText(path);
  }
  if (actual === expected) return [];
  if (checkOnly) throw new Error(`${path}: generated context is missing or stale; run 'workbench sync'`);
  if (actual && !owned(actual))
    throw new Error(`${path}: existing agent guidance is not Workbench-generated; move it first`);
  writeAtomic(path, expected);
  return [path];
}
