import { textLength } from "./invariants.js";
import { required } from "./invariants.js";
import { join, relative, sep } from "node:path";
import { parse as yamlParse } from "yaml";
import {
  detail,
  kinds,
  readConfig,
  readProjects,
  readText,
  rootOf,
  scan,
  writeAtomic,
  type Kind,
  type Project,
} from "./core.js";
import { recordTitle } from "./records.js";
import { recordDocument } from "./record-document.js";
import { readDecision } from "./decisions.js";

const descriptions: Record<Kind, string> = {
  ADR: "Read applicable decisions; entries identify their topics.",
  TSK: "Unfinished tasks in this project. Status and title come from the records.",
  EXP: "Experiments in this project. Status and title come from the records.",
  ENV: "Environment records in this project.",
  CIT: "Citations retained by this project.",
  REL: "Published releases and their verified artifacts.",
};

export function wrap(value: string, width: number, indentation = 0): string {
  let output = "";
  let length = indentation;
  for (const word of value.trim().split(/\s+/)) {
    if (output && length + 1 + textLength(word) > width) {
      output += `\n${" ".repeat(indentation)}${word}`;
      length = indentation + textLength(word);
    } else {
      if (output) {
        output += " ";
        length++;
      }
      output += word;
      length += textLength(word);
    }
  }
  return output;
}

function renderEntry(
  root: string,
  project: Project,
  kind: Kind,
  number: string,
  path: string,
  width: number,
): string | undefined {
  const contents = readText(path);
  const title = recordTitle(kind, number, contents);
  const link = `[${project.id}:${kind}-${number}](${relative(join(rootOf(root, project), "workbench"), path)
    .split(sep)
    .join("/")})`;
  if (kind === "ADR") {
    const decision = readDecision(project, number, path);
    return (
      wrap(`${link}: ${decision.title} — ${decision.summary}`, width, 2) +
      (decision.overrides.length ? `\n  Overrides: ${decision.overrides.join(", ")}.` : "")
    );
  }
  if (kind === "TSK") {
    const { status, parent } = recordDocument("TSK", contents, path).metadata;
    if (status === "Done" || status === "Canceled") return undefined;
    return wrap(`${link}: ${title} (${String(status)}${parent ? `, parent ${parent}` : ""})`, width, 2);
  }
  if (kind === "EXP")
    return wrap(`${link}: ${title} (${String(recordDocument("EXP", contents, path).metadata.status)})`, width, 2);
  if (kind === "REL") {
    const parsed = yamlParse(contents) as { yanked?: boolean };
    return wrap(`${link}: ${title}${parsed.yanked ? " (yanked)" : ""}`, width, 2);
  }
  return wrap(`${link}: ${title}`, width, 2);
}

export function renderMap(root: string, project: Project, kind: Kind): string {
  const projects = readProjects(root);
  const width = required(
    required(readConfig(root).markdown, "expected readConfig(root).markdown").wrap_width,
    "expected readConfig(root).markdown!.wrap_width",
  );
  let output = `# ${detail(kind).title} map\n\n${wrap(descriptions[kind], width)}\n`;
  if (kind === "ADR") output += "\nScope charter: [CHARTER.md](CHARTER.md).\n";
  let count = 0;
  for (const record of scan(rootOf(root, project), kind)) {
    const entry = renderEntry(root, project, kind, record.number, record.path, width);
    if (entry) {
      output += `\n- ${entry}`;
      count++;
    }
  }
  output += count ? "\n" : kind === "TSK" ? "\nNo unfinished tasks.\n" : "\nNo records.\n";
  if (project.path === "." && projects.length > 1) {
    output += `\n## Subproject ${detail(kind).directory} maps\n`;
    for (const subproject of projects.slice(1)) {
      output += `\n- [${subproject.id}](../${subproject.path}/workbench/${detail(kind).map})`;
    }
    output += "\n";
  }
  return output;
}

export function syncMaps(root: string, checkOnly = false): string[] {
  const changed: string[] = [];
  for (const project of readProjects(root)) {
    for (const kind of kinds) {
      const path = join(rootOf(root, project), "workbench", detail(kind).map);
      const expected = renderMap(root, project, kind);
      let actual: string | undefined;
      try {
        actual = readText(path);
      } catch {
        /* Report stale below. */
      }
      if (actual === expected) continue;
      if (checkOnly) throw new Error(`${path}: map is missing or stale; run 'workbench sync'`);
      writeAtomic(path, expected);
      changed.push(path);
    }
  }
  return changed;
}
