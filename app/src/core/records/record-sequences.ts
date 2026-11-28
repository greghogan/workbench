import { recordInventory } from "./archive-store.js";
import { withProjectStateLock } from "../projects/project-state.js";
import { projectPaths } from "../projects/project-paths.js";
import { required } from "../runtime/invariants.js";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { editToml } from "../configuration/toml-edit.js";
import { compareRecordNumbers, kinds, nextNumber, normalizedNumber, type Kind } from "./record-identity.js";
import { readProjects } from "../projects/project-configuration.js";
import { readToml, readText } from "../runtime/files.js";
import { rootOf } from "../projects/project-context.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { isRecord, record } from "../runtime/values.mjs";

interface Sequences {
  next: Partial<Record<Kind, string>>;
}

function readSequences(directory: string): Sequences {
  const path = join(directory, projectPaths.state);
  if (!existsSync(path)) return { next: {} };
  const document = record(readToml(path), `${path}: invalid project state`);
  const counters = document.next;
  if ("schema_version" in document || (counters !== undefined && (!isRecord(counters) || counters instanceof Date)))
    throw new Error(`${path}: invalid record sequences`);
  const next: Sequences["next"] = {};
  for (const [kind, value] of Object.entries(counters ?? {})) {
    if (!kinds.includes(kind as Kind) || typeof value !== "string" || normalizedNumber(value) !== value)
      throw new Error(`${path}: invalid next record ID for ${kind}`);
    next[kind as Kind] = value;
  }
  return { ...document, next };
}

function currentSequences(directory: string, root: string, document = readSequences(directory)): Sequences {
  for (const kind of kinds) {
    const records = recordInventory(root, relative(root, directory).replaceAll("\\", "/") || ".", kind);
    const floor = records.length ? nextNumber(required(records.at(-1), "expected records.at(-1)").number) : "0";
    if (!document.next[kind] || compareRecordNumbers(floor, document.next[kind]) > 0) document.next[kind] = floor;
  }
  return document;
}

/** Reserve before publishing a record; failed writes leave an intentional gap, never a reusable ID. */
export function reserveRecordNumber(directory: string, kind: Kind, root = directory): string {
  return withProjectStateLock(directory, () => {
    const document = currentSequences(directory, root);
    const number = required(document.next[kind], "expected document.next[kind]");
    document.next[kind] = nextNumber(number);
    const path = join(directory, projectPaths.state);
    writeAtomic(path, editToml(existsSync(path) ? readText(path) : "", document));
    return number;
  });
}

export function syncRecordSequences(root: string, checkOnly = false): string[] {
  const changed: string[] = [];
  for (const project of readProjects(root)) {
    const directory = rootOf(root, project);
    const path = join(directory, projectPaths.state);
    const synchronize = () => {
      const actual = readSequences(directory);
      const expected = currentSequences(directory, root, { ...actual, next: { ...actual.next } });
      if (kinds.every((kind) => actual.next[kind] === expected.next[kind])) return;
      if (checkOnly) throw new Error(`${path}: missing or stale record sequences; run 'workbench sync'`);
      writeAtomic(path, editToml(existsSync(path) ? readText(path) : "", expected));
      changed.push(path);
    };
    if (checkOnly) synchronize();
    else withProjectStateLock(directory, synchronize);
  }
  return changed;
}
