import { existsSync } from "node:fs";
import { renderCollectionMap } from "./collection-maps.js";
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
import { decisionScopes } from "./decisions.js";
import { readDecision } from "./decision-record.js";
import { wrap } from "./formatting.js";
import { appliesWithin } from "./collections.js";

const descriptions: Record<Kind, string> = {
  ADR: "Read applicable decisions; entries identify their topics.",
  TSK: "Unfinished tasks in this project. Status and title come from the records.",
  EXP: "Experiments in this project. Status and title come from the records.",
  ENV: "Environment records in this project.",
  CIT: "Citations retained by this project.",
  REL: "Published releases and their verified artifacts.",
};

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
    return wrap(
      `[${decision.reference}: ${decision.title}](${relative(join(rootOf(root, project), "workbench"), path)
        .split(sep)
        .join("/")}) — ${decision.summary}`,
      width,
      2,
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
  if (kind === "ADR") {
    const sources = decisionScopes(root, false).filter(
      (scope) => scope.source && scope.appliesTo.some((path) => appliesWithin(path, project.path)),
    );
    if (sources.length) {
      output += "\n## Project-owned collection decision maps\n";
      for (const scope of sources) {
        const source = required(scope.source, "collection identity");
        const path = relative(join(rootOf(root, project), "workbench"), join(scope.recordsDirectory, "decision-map.md"))
          .split(sep)
          .join("/")
          .replaceAll(" ", "%20");
        output += `\n- ${wrap(`[${scope.project.id}](${path}): ${source.id}, revision ${source.revision} (${source.visibility}), SHA-256 ${source.sha256}.`, width, 2)}\n`;
      }
    }
  }
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
  for (const scope of decisionScopes(root, false).filter((entry) => entry.source)) {
    const path = join(scope.recordsDirectory, "decision-map.md");
    const expected = renderCollectionMap(scope.decisions, readConfig(root).markdown?.wrap_width ?? 120);
    if (existsSync(path) && readText(path) === expected) continue;
    if (checkOnly) throw new Error(`${path}: map is missing or stale; run 'workbench sync'`);
    writeAtomic(path, expected);
    changed.push(path);
  }
  return changed;
}
