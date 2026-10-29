import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { ownedPath } from "./paths.js";
import { detail, kinds, normalizedNumber, relativeRecordPath, type Kind, type RecordFile } from "./record-identity.js";
import { readProjects, selectProject } from "./project-configuration.js";
import { rootOf } from "./project-context.js";
import type { Project } from "./project-model.js";
export function scan(projectDirectory: string, kind: Kind): RecordFile[] {
  return scanRecordDirectory(ownedPath(projectDirectory, "workbench"), kind);
}

/** Collections own records directories without acquiring a project charter. */
export function scanRecordDirectory(base: string, kind: Kind): RecordFile[] {
  const directory = join(base, detail(kind).directory);
  if (!existsSync(directory)) return [];
  const found: RecordFile[] = [];
  function walk(current: string): void {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${current}: record directory must be real`);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        // A sibling record owns this directory's supporting files. They are
        // attachments, so record discovery must not interpret their contents.
        if (
          new RegExp(`^${kind}-[0-9A-Za-z_]+$`).test(entry.name) &&
          lstatSync(`${path}.${detail(kind).extension}`, { throwIfNoEntry: false })?.isFile()
        )
          continue;
        walk(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`${path}: unsupported record entry`);
      // An open human review may leave a Vim swap beside its authoritative record.
      const swap = /^\.(.+)\.sw[a-z]$/.exec(entry.name);
      if (swap?.[1] && lstatSync(join(current, swap[1]), { throwIfNoEntry: false })?.isFile()) continue;
      const match = new RegExp(`^${kind}-([0-9A-Za-z_]+)\\.${detail(kind).extension}$`).exec(entry.name);
      if (!match?.[1]) throw new Error(`${path}: unexpected file in record directory`);
      const number = normalizedNumber(match[1]);
      const expected = join(base, relativeRecordPath(kind, number));
      if (path !== expected) throw new Error(`${path}: expected canonical path ${expected}`);
      if (found.some((record) => record.number === number)) throw new Error(`${path}: duplicate normalized identity`);
      found.push({ number, path });
    }
  }
  walk(directory);
  return found.sort((a, b) => a.number.length - b.number.length || a.number.localeCompare(b.number));
}

export function parseReference(
  root: string,
  reference: string,
): { project: Project; kind: Kind; number: string; path: string } {
  const match = /^([^:]+):([A-Za-z]+)-([0-9A-Za-z_]+)$/.exec(reference);
  if (!match?.[1] || !match[2] || !match[3])
    throw new Error(
      `invalid record reference: ${reference}; expected SCOPE:TYPE-ID, for example ${readProjects(root)[0]?.id ?? "project"}:TSK-0`,
    );
  const project = selectProject(root, match[1]);
  const kind = match[2].toUpperCase() as Kind;
  if (!kinds.includes(kind)) throw new Error(`unknown record type: ${match[2]}`);
  const number = normalizedNumber(match[3]);
  return {
    project,
    kind,
    number,
    path: ownedPath(
      rootOf(root, project),
      ["workbench", relativeRecordPath(kind, number).split(sep).join("/")].join("/"),
    ),
  };
}
