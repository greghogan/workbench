import { projectedRecordMaps } from "./record-projection.js";
import { parse } from "smol-toml";
import { isDeepStrictEqual } from "node:util";
import { projectPaths } from "../projects/project-paths.js";
import { gitBytes, readGitObjects, readGitTree, type GitEntry } from "../git/git-snapshot.js";
import { InvalidInput } from "../runtime/input-errors.js";
import { record } from "../runtime/values.mjs";
import { readArchiveIndex } from "./archive-store.js";

const equal = (a: GitEntry | undefined, b: GitEntry | undefined) => a?.oid === b?.oid && a?.mode === b?.mode;
function document(root: string, entries: ReadonlyMap<string, GitEntry>, path: string): Record<string, unknown> {
  const entry = entries.get(path);
  if (!entry) return parse("");
  const body = readGitObjects(root, [entry.oid]).get(entry.oid);
  if (!body) throw new InvalidInput(`Missing transfer metadata: ${path}`);
  return parse(body.toString());
}

/** Verify a storage-only integration commit without trusting a private journal or commit message. */
export function verifyArchiveTransfer(root: string, before: string, after: string): Set<string> {
  const previous = readGitTree(root, before),
    current = readGitTree(root, after);
  const oldState = document(root, previous, projectPaths.state),
    newState = document(root, current, projectPaths.state);
  const oldArchive = record(oldState.archive ?? {}, "Invalid archive state"),
    newArchive = record(newState.archive ?? {}, "Invalid archive state");
  const oldRevision = oldArchive.revision,
    newRevision = newArchive.revision;
  if (oldRevision === newRevision) return new Set();
  if (
    (oldRevision !== undefined && typeof oldRevision !== "string") ||
    (newRevision !== undefined && typeof newRevision !== "string")
  )
    throw new InvalidInput("Invalid transfer archive revision");
  const restoring = newRevision === undefined;
  const oldFiles =
    typeof oldRevision === "string" ? readArchiveIndex(root, oldRevision).files : new Map<string, GitEntry>();
  const newFiles =
    typeof newRevision === "string" ? readArchiveIndex(root, newRevision).files : new Map<string, GitEntry>();
  Reflect.deleteProperty(oldArchive, "revision");
  Reflect.deleteProperty(newArchive, "revision");
  if (!Object.keys(oldArchive).length) Reflect.deleteProperty(oldState, "archive");
  if (!Object.keys(newArchive).length) Reflect.deleteProperty(newState, "archive");
  if (!isDeepStrictEqual(oldState, newState))
    throw new InvalidInput("Archive transfer changed unrelated project state");
  const transferred = new Set<string>();
  const maps = projectedRecordMaps(root, after);
  for (const path of new Set([...previous.keys(), ...current.keys()])) {
    if (equal(previous.get(path), current.get(path)) || path === projectPaths.state) continue;
    if (maps.has(path)) {
      const entry = current.get(path),
        expected = maps.get(path),
        actual = entry ? readGitObjects(root, [entry.oid]).get(entry.oid) : undefined;
      if (entry?.mode !== "100644" || !expected || !actual?.equals(expected))
        throw new InvalidInput(`Unverified generated map change: ${path}`);
      continue;
    }
    if (restoring && path === projectPaths.config) {
      const old = document(root, previous, path),
        next = document(root, current, path);
      const records = record(old.records ?? {}, "Invalid record configuration");
      Reflect.deleteProperty(records, "archive_branch");
      old.records = records;
      if (!isDeepStrictEqual(old, next)) throw new InvalidInput("Archive restoration changed unrelated configuration");
      continue;
    }
    if (
      restoring
        ? previous.has(path) || !equal(current.get(path), oldFiles.get(path))
        : current.has(path) || !equal(previous.get(path), newFiles.get(path))
    )
      throw new InvalidInput(`Unverified record transfer: ${path}`);
    transferred.add(path);
  }

  for (const [path, entry] of oldFiles)
    if (!restoring && !equal(newFiles.get(path), entry))
      throw new InvalidInput(`Archive replacement lost retained contents: ${path}`);
  if (restoring) {
    for (const [path, entry] of oldFiles) {
      if (!equal(current.get(path), entry)) throw new InvalidInput(`Archive restoration lost contents: ${path}`);
      transferred.add(path);
    }
  } else {
    for (const [path, entry] of newFiles)
      if (!equal(oldFiles.get(path), entry) && !equal(previous.get(path), entry))
        throw new InvalidInput(`Archive added unverified contents: ${path}`);
  }
  if (!transferred.size) throw new InvalidInput("Archive transfer contains no record movement");
  return transferred;
}

/** A deletion is safe only when its exact committed bytes and mode remain in the selected archive. */
const contexts = new Map<string, boolean>();
/** Unchanged storage commits retain the reviewed project context without rewriting acknowledgments. */
export function storageReviewContext(root: string, sourceTree: string, targetCommit: string): boolean {
  const key = `${root}:${sourceTree}:${targetCommit}`,
    cached = contexts.get(key);
  if (cached !== undefined) return cached;
  let result = false;
  try {
    let current = targetCommit;
    while (current) {
      const [commit, tree, ...parents] = gitBytes(root, ["log", "-1", "--format=%H %T %P", current])
        .toString()
        .trim()
        .split(" ");
      if (tree === sourceTree) {
        result = true;
        break;
      }
      const parent = parents[0];
      if (!commit || !parent || parents.length !== 1 || !verifyArchiveTransfer(root, parent, commit).size) break;
      current = parent;
    }
  } catch {
    result = false;
  }
  if (contexts.size >= 128) contexts.delete(contexts.keys().next().value ?? "");
  contexts.set(key, result);
  return result;
}
