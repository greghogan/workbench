import { readBoundedFile } from "./file-reads.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedPath } from "./paths.js";
import { InvalidInput } from "./input-errors.js";
import { publicationTarget } from "../scripts/file-publication.mjs";

export const collectionFileLimit = 1024 * 1024;
export const collectionByteLimit = 64 * 1024 * 1024;
export const collectionCharterPath = "workbench/CHARTER.md";

export function validateCollectionCharter(bytes: Buffer | undefined, context: string): asserts bytes is Buffer {
  if (!bytes?.toString("utf8").trim() || bytes.includes(0))
    throw new InvalidInput(`${context}: a nonempty human-written collection charter is required`);
}

export const bytesHash = (bytes: Buffer | undefined): string | null =>
  bytes === undefined ? null : createHash("sha256").update(bytes).digest("hex");
const equal = (a: Buffer | undefined, b: Buffer | undefined) => bytesHash(a) === bytesHash(b);
export const authoritativeFiles = (files: Map<string, Buffer>) =>
  new Map([...files].filter(([name]) => !["workbench/collection.toml", "workbench/decision-map.md"].includes(name)));
/** Canonical byte identities also cover complete working trees during concurrent-edit checks. */
export const collectionTreeHash = (files: Map<string, Buffer>): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, bytes]) => [name, bytesHash(bytes)]),
      ),
    )
    .digest("hex");
/** Editable contents include contextual charters; generated inventories and maps are derived separately. */
export const collectionFilesHash = (files: Map<string, Buffer>): string =>
  collectionTreeHash(authoritativeFiles(files));
/** The publisher's charter is provenance after adoption, never an additional policy authority. */
export const policyFilesHash = (files: Map<string, Buffer>): string =>
  collectionFilesHash(new Map([...files].filter(([name]) => name !== collectionCharterPath)));

export function collectionBytes(directory: string, name: string): Buffer {
  return ownedFileBytes(directory, name, collectionFileLimit);
}

/** Bounded regular-file reads shared by collection verification and record previews. */
export function ownedFileBytes(directory: string, name: string, limit: number): Buffer {
  return readBoundedFile(ownedPath(directory, name), limit, "collection file");
}

/** Project adaptations include additions and removals, not just the original inventory. */
export function collectionWorkingFiles(directory: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = (prefix: string): void => {
    for (const entry of readdirSync(ownedPath(directory, prefix || "."), { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (/^\..+\.sw[a-z]$/.test(entry.name)) continue;
      if (entry.isFile() && publicationTarget(entry.name) !== undefined) continue;
      const path = ownedPath(directory, name);
      if (entry.isDirectory()) walk(name);
      else {
        if (!entry.isFile()) throw new Error(`${path}: collection contents must be regular files`);
        const bytes = collectionBytes(directory, name);
        total += bytes.length;
        if (bytes.length > collectionFileLimit || total > collectionByteLimit || files.size >= 4096)
          throw new Error(`${directory}: collection exceeds acquisition bounds`);
        files.set(`workbench/${name}`, bytes);
      }
    }
  };
  walk("");
  return files;
}

export function mergeCollectionFiles(
  base: Map<string, Buffer>,
  local: Map<string, Buffer>,
  incoming: Map<string, Buffer>,
  temporary: string,
): { proposed: Map<string, Buffer>; conflicts: string[] } {
  const proposed = new Map<string, Buffer>();
  const conflicts: string[] = [];
  for (const name of [...new Set([...base.keys(), ...local.keys(), ...incoming.keys()])].sort()) {
    const before = base.get(name),
      ours = local.get(name),
      theirs = incoming.get(name);
    let output: Buffer | undefined;
    if (equal(ours, before)) output = theirs;
    else if (equal(theirs, before) || equal(ours, theirs)) output = ours;
    else if (ours && before && theirs && ![ours, before, theirs].some((bytes) => bytes.includes(0))) {
      const paths = [ours, before, theirs].map((bytes, index) => {
        const path = join(temporary, `merge-${String(index)}`);
        writeFileSync(path, bytes);
        return path;
      });
      const result = spawnSync(
        "git",
        ["merge-file", "--stdout", "-L", "project", "-L", "retained upstream", "-L", "new upstream", ...paths],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      if (result.error || result.status === null || result.status > 127)
        throw new Error(`collection merge failed: ${String(result.error ?? result.stderr)}`);
      output = result.stdout;
      if (result.status !== 0) conflicts.push(name);
    } else {
      conflicts.push(name);
      output = ours ?? theirs;
    }
    if (output !== undefined) proposed.set(name, output);
  }
  return { proposed, conflicts };
}
