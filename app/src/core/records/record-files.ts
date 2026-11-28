import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { ownedPath } from "../runtime/paths.js";
import {
  compareRecordNumbers,
  detail,
  kinds,
  normalizedNumber,
  relativeRecordPath,
  type Kind,
  type RecordFile,
} from "./record-identity.js";
import { readProjects, selectProject } from "../projects/project-configuration.js";
import { rootOf } from "../projects/project-context.js";
import { publicationTarget } from "../runtime/file-publication.mjs";
import type { Project } from "../projects/project-model.js";
import { observeRecord } from "./record-observation.js";
export function scan(projectDirectory: string, kind: Kind, committedRecords?: ReadonlySet<string>): RecordFile[] {
  return scanRecordDirectory(ownedPath(projectDirectory, "workbench"), kind, committedRecords);
}

/** Collections own records directories without acquiring a project charter. */
export function scanRecordDirectory(base: string, kind: Kind, committedRecords?: ReadonlySet<string>): RecordFile[] {
  if (committedRecords) return inspectRecordDirectory(base, kind, committedRecords);
  return observeRecord(
    `records:${kind}:${base}`,
    () => inspectRecordDirectory(base, kind),
    (records) => records.reduce((size, item) => size + item.path.length * 2 + 80, 0),
  );
}

function inspectRecordDirectory(base: string, kind: Kind, committedRecords?: ReadonlySet<string>): RecordFile[] {
  const directory = join(base, detail(kind).directory);
  if (!existsSync(directory)) return [];
  const found: RecordFile[] = [];
  const numbers = new Set<string>();
  const attachmentName = new RegExp(`^${kind}-[0-9A-Za-z_]+$`);
  const recordName = new RegExp(`^${kind}-([0-9A-Za-z_]+)\\.${detail(kind).extension}$`);
  function walk(current: string): void {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${current}: record directory must be real`);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (attachmentName.test(entry.name)) {
          const owner = `${path}.${detail(kind).extension}`;
          if (lstatSync(owner, { throwIfNoEntry: false })?.isFile() || committedRecords?.has(owner)) continue;
          throw new Error(
            `${path}: supporting directory has no owning record '${owner}'. Move prepared files outside record directories, create the record, then attach its supporting files.`,
          );
        }
        walk(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`${path}: unsupported record entry`);
      const publishing = publicationTarget(entry.name);
      if (publishing !== undefined && recordName.test(publishing)) continue;
      // An open human review may leave a Vim swap beside its authoritative record.
      const swap = /^\.(.+)\.sw[a-z]$/.exec(entry.name);
      if (swap?.[1] && lstatSync(join(current, swap[1]), { throwIfNoEntry: false })?.isFile()) continue;
      const match = recordName.exec(entry.name);
      if (!match?.[1]) throw new Error(`${path}: unexpected file in record directory`);
      const number = normalizedNumber(match[1]);
      const expected = join(base, relativeRecordPath(kind, number));
      if (path !== expected) throw new Error(`${path}: expected canonical path ${expected}`);
      if (numbers.has(number)) throw new Error(`${path}: duplicate normalized identity`);
      numbers.add(number);
      found.push({ number, path });
    }
  }
  walk(directory);
  return found.sort((a, b) => compareRecordNumbers(a.number, b.number));
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
