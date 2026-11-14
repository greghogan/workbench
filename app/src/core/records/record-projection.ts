import { join } from "node:path";
import { parse } from "smol-toml";
import { readGitObjects, readGitTree, type GitEntry } from "../git/git-snapshot.js";
import { projectsFromData } from "../projects/project-configuration.js";
import { projectPaths } from "../projects/project-paths.js";
import { InvalidInput } from "../runtime/input-errors.js";
import { record } from "../runtime/values.mjs";
import { TaskGraph, parseTask } from "../tasks/task-model.js";
import { readArchiveIndex, type InventoryRecord } from "./archive-store.js";
import { classifyRecordPath } from "./staged-records.js";
import { normalizedNumber, compareRecordNumbers } from "./record-identity.js";
import { proseRecordErrors } from "./record-content.js";
import { renderMap } from "./maps.js";

/** Render generated record maps from a proposed Git tree, without changing the user's files or index. */
export function projectedRecordMaps(root: string, tree: string): Map<string, Buffer> {
  const live = readGitTree(root, tree),
    files = new Map(live);
  const text = (path: string) => {
    const entry = live.get(path);
    return entry ? readGitObjects(root, [entry.oid]).get(entry.oid)?.toString() : undefined;
  };
  const registry = text(projectPaths.projects);
  if (!registry) throw new InvalidInput("Record projection requires a committed project registry");
  const projects = projectsFromData(parse(registry), projectPaths.projects);
  const state = parse(text(projectPaths.state) ?? ""),
    revision = record(state.archive ?? {}, "Invalid archive state").revision;
  const archive = typeof revision === "string" ? readArchiveIndex(root, revision) : undefined;
  for (const [path, entry] of archive?.files ?? []) {
    const existing = files.get(path);
    if (existing && (entry.mode !== existing.mode || entry.oid !== existing.oid))
      throw new InvalidInput(`Conflicting archived record: ${path}`);
    files.set(path, entry);
  }
  const scopes = projects.map((project) => project.path);
  const records: { scope: string; kind: "TSK" | "EXP"; file: InventoryRecord; entry: GitEntry }[] = [];
  for (const [path, entry] of files) {
    const kind = classifyRecordPath(path, scopes, []).primary;
    if (kind !== "TSK" && kind !== "EXP") continue;
    const project = projects.find((item) =>
      path.startsWith(
        `${item.path === "." ? "" : item.path + "/"}workbench/${kind === "TSK" ? "tasks" : "experiments"}/`,
      ),
    );
    const digits = /(?:TSK|EXP)-([0-9A-Z]+)\.md$/.exec(path)?.[1];
    if (!project || !digits) throw new InvalidInput(`Record projection cannot identify ${path}`);
    records.push({
      scope: project.path,
      kind,
      entry,
      file: {
        number: normalizedNumber(digits),
        path: join(root, path),
        ...(archive?.files.has(path) ? { archive: { revision: archive.revision, entry } } : {}),
      },
    });
  }
  const contents = new Map<string, Buffer>();
  for (let offset = 0; offset < records.length; offset += 16) {
    const chunk = records.slice(offset, offset + 16),
      bodies = readGitObjects(
        root,
        chunk.map((item) => item.entry.oid),
      );
    for (const item of chunk) {
      const body = bodies.get(item.entry.oid);
      if (!body) throw new InvalidInput(`Missing projected record: ${item.file.path}`);
      const errors = proseRecordErrors(item.kind, item.file.number, item.file.path, body.toString());
      if (errors.length) throw new InvalidInput(errors.join("\n"));
      contents.set(item.file.path, body);
    }
  }
  records.sort(
    (a, b) =>
      scopes.indexOf(a.scope) - scopes.indexOf(b.scope) ||
      a.kind.localeCompare(b.kind) ||
      compareRecordNumbers(a.file.number, b.file.number),
  );
  const tasks = new TaskGraph(
    records
      .filter((item) => item.kind === "TSK")
      .map((item) => {
        const project = projects.find((project) => project.path === item.scope),
          body = contents.get(item.file.path);
        if (!project || !body) throw new InvalidInput("Missing projected task scope or contents");
        return parseTask(root, `${project.id}:TSK-${item.file.number}`, item.file.path, body.toString());
      }),
  ).validate();
  const maps = new Map<string, Buffer>();
  for (const project of projects)
    for (const kind of ["TSK", "EXP"] as const) {
      const selected = records
        .filter((item) => item.scope === project.path && item.kind === kind)
        .map((item) => item.file);
      const path = `${project.path === "." ? "" : project.path + "/"}workbench/${kind === "TSK" ? "task" : "experiment"}-map.md`;
      maps.set(path, Buffer.from(renderMap(root, project, kind, { records: selected, contents, tasks })));
    }
  return maps;
}
