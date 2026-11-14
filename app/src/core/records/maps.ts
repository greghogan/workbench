import { recordInventory, readInventoryRecords } from "./archive-store.js";
import { existsSync } from "node:fs";
import { renderCollectionMap } from "../collections/collection-maps.js";
import { required } from "../runtime/invariants.js";
import { join, relative } from "node:path";
import { parse as yamlParse } from "yaml";
import { detail, kinds, type Kind } from "./record-identity.js";
import { readConfig, readProjects } from "../projects/project-configuration.js";
import { readText } from "../runtime/files.js";
import { rootOf } from "../projects/project-context.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { type Project } from "../projects/project-model.js";
import { recordTitle, recordDocument, terminalTask } from "./record-document.js";
import { decisionScopes } from "./decisions.js";
import { readDecision } from "./decision-record.js";
import { wrap } from "./formatting.js";
import { appliesWithin } from "../collections/collections.js";
import { readTaskGraph, type TaskGraph } from "../tasks/task-model.js";
import type { InventoryRecord } from "./archive-store.js";
import { markdownLabel, markdownPath, relocateMarkdownLinks } from "./markdown-links.js";

function renderEntry(
  root: string,
  project: Project,
  kind: Kind,
  number: string,
  path: string,
  width: number,
  captured?: string,
  archived = false,
): string | undefined {
  const contents = captured ?? readText(path);
  const title = recordTitle(kind, number, contents);
  const map = join(rootOf(root, project), "workbench", detail(kind).map);
  const destination = markdownPath(relative(join(rootOf(root, project), "workbench"), path));
  const link = archived ? `${project.id}:${kind}-${number}` : `[${project.id}:${kind}-${number}](${destination})`;
  if (kind === "ADR") {
    const decision = readDecision(project, number, path);
    return wrap(
      `[${markdownLabel(`${decision.reference}: ${decision.title}`)}](${destination}) — ${relocateMarkdownLinks(decision.summary, path, map)}`,
      width,
      2,
    );
  }
  if (kind === "TSK") {
    const { status, parent } = recordDocument("TSK", contents, path).metadata;
    if (status === "Accepted" || status === "Canceled") return undefined;
    return wrap(`${link}: ${title} (${status}${parent ? `, parent ${parent}` : ""})`, width, 2);
  }
  if (kind === "EXP")
    return wrap(
      `${link}: ${title} (${recordDocument("EXP", contents, path).metadata.status}${archived ? "; archived" : ""})`,
      width,
      2,
    );
  if (kind === "REL") {
    const parsed = yamlParse(contents) as { yanked?: boolean };
    return wrap(`${link}: ${title}${parsed.yanked ? " (yanked)" : ""}`, width, 2);
  }
  return wrap(`${link}: ${title}`, width, 2);
}

export interface MapRecordView {
  records: InventoryRecord[];
  contents: ReadonlyMap<string, Buffer>;
  tasks: TaskGraph;
}
export function renderMap(root: string, project: Project, kind: Kind, captured?: MapRecordView): string {
  const projects = readProjects(root);
  const width = required(
    required(readConfig(root).markdown, "expected readConfig(root).markdown").wrap_width,
    "expected readConfig(root).markdown!.wrap_width",
  );
  let output = `# ${detail(kind).title} map\n`;
  if (kind === "ADR") output += "\nScope charter: [CHARTER.md](CHARTER.md).\n";
  let count = 0;
  if (kind === "TSK") {
    const graph = captured?.tasks ?? readTaskGraph(root);
    const nodes = graph.forest(
      graph.tasks.filter(
        (task) => task.reference.startsWith(project.id + ":") && !terminalTask.has(task.metadata.status),
      ),
    );
    const append = (items: typeof nodes, depth = 0) => {
      for (const { task, children } of items) {
        const number = task.reference.split("TSK-")[1] ?? "";
        const entry = renderEntry(
          root,
          project,
          kind,
          number,
          task.path,
          Math.max(20, width - depth * 2),
          task.contents,
        );
        if (entry) {
          output += `\n${"  ".repeat(depth)}- ${entry.replaceAll("\n", "\n" + "  ".repeat(depth))}`;
          count++;
        }
        append(children, depth + 1);
      }
    };
    append(nodes);
    const archived = graph.tasks.filter((task) => task.reference.startsWith(project.id + ":") && task.archived).length;
    if (archived)
      output += `\n\n${wrap(`Archived tasks: ${String(archived)}. Read with \`workbench record show REFERENCE\` or search with \`workbench record search QUERY --project ${project.id}\`.`, width)}`;
  } else {
    const records = captured?.records ?? recordInventory(root, project.path, kind),
      bodies = captured?.contents ?? readInventoryRecords(root, records);
    for (const record of records) {
      const entry = renderEntry(
        root,
        project,
        kind,
        record.number,
        record.path,
        width,
        bodies.get(record.path)?.toString(),
        record.archive !== undefined,
      );
      if (entry) {
        output += `\n- ${entry}`;
        count++;
      }
    }
    if (records.some((record) => record.archive))
      output += "\n\nRead archived records with `workbench record show REFERENCE`.\n";
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
        const path = markdownPath(
          relative(join(rootOf(root, project), "workbench"), join(scope.recordsDirectory, "decision-map.md")),
        );
        output += `\n- ${wrap(`[${scope.project.id}](${path}): ${source.id}, revision ${source.revision} (${source.visibility}), SHA-256 ${source.sha256}.`, width, 2)}\n`;
      }
    }
  }
  if (project.path === "." && projects.length > 1) {
    output += `\n## Subproject ${detail(kind).directory} maps\n`;
    for (const subproject of projects.slice(1)) {
      output += `\n- [${subproject.id}](${markdownPath(`../${subproject.path}/workbench/${detail(kind).map}`)})`;
    }
    output += "\n";
  }
  return output;
}

export function syncMaps(root: string, checkOnly = false): string[] {
  const changed: string[] = [];
  for (const project of readProjects(root)) {
    for (const kind of kinds) {
      changed.push(...syncProjectMap(root, project, kind, checkOnly));
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

export function syncProjectMap(root: string, project: Project, kind: Kind, checkOnly = false): string[] {
  const path = join(rootOf(root, project), "workbench", detail(kind).map);
  const expected = renderMap(root, project, kind);
  if (existsSync(path) && readText(path) === expected) return [];
  if (checkOnly) throw new Error(`${path}: map is missing or stale; run 'workbench sync'`);
  writeAtomic(path, expected);
  return [path];
}

export function syncCollectionMap(root: string, id: string): string[] {
  const scope = decisionScopes(root, false).find((scope) => scope.source && scope.project.id === id);
  if (!scope) throw new Error(`Collection ${id} is unavailable; inspect the collection selection`);
  const path = join(scope.recordsDirectory, "decision-map.md");
  const expected = renderCollectionMap(scope.decisions, readConfig(root).markdown?.wrap_width ?? 120);
  if (existsSync(path) && readText(path) === expected) return [];
  writeAtomic(path, expected);
  return [path];
}
