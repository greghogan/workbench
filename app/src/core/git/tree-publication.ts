import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { hashFile, withStableFile } from "../runtime/file-reads.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { ownedPath } from "../runtime/paths.js";
import { StateConflict } from "../runtime/input-errors.js";
import { gitBytes, GitSnapshot, readGitTree, type GitEntry } from "./git-snapshot.js";
import { withGitIndex } from "./index-transaction.js";

export interface TreeUpdate {
  path: string;
  before?: GitEntry | undefined;
  after?: GitEntry | undefined;
}
export const sameGitEntry = (a: GitEntry | undefined, b: GitEntry | undefined): boolean =>
  a?.oid === b?.oid && a?.mode === b?.mode;
export function workingGitEntry(root: string, path: string, oidLength: number): GitEntry | undefined {
  const absolute = ownedPath(root, path),
    info = lstatSync(absolute, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) throw new StateConflict(`Expected a regular working file: ${path}`);
  return {
    mode: process.platform === "win32" ? "100644" : info.mode & 0o111 ? "100755" : "100644",
    oid: hashFile(absolute, Number.MAX_SAFE_INTEGER, "working file", {
      algorithm: oidLength === 64 ? "sha256" : "sha1",
      prefix: (size) => `blob ${String(size)}\0`,
    }),
  };
}

/** Read the blob Git would store for a working file with checkout conversions. */
export function convertedWorkingGitOid(
  root: string,
  path: string,
  oidLength: number,
  maximum = Number.MAX_SAFE_INTEGER,
): string {
  return withStableFile(ownedPath(root, path), (descriptor, metadata) => {
    if (metadata.size > maximum) throw new StateConflict(`Working file exceeds its byte limit: ${path}`);
    const result = spawnSync("git", ["-C", root, "hash-object", `--path=${path}`, "--stdin"], {
      stdio: [descriptor, "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    });
    const oid = result.status === 0 ? result.stdout.trim() : "";
    if (oid.length !== oidLength || !/^[a-f0-9]+$/.test(oid))
      throw new StateConflict(`Cannot verify the working file: ${path}`, {
        cause: result.error ?? new Error(result.stderr.trim()),
      });
    return oid;
  });
}

/** A retry accepts either side of a prepared transition and preserves unrelated index/worktree edits. */
export function publishGitTree(
  root: string,
  branch: string,
  before: string,
  after: string,
  updates: readonly TreeUpdate[],
  options: { stageOnly?: boolean } = {},
): void {
  const expectedBefore = readGitTree(root, before),
    expectedAfter = readGitTree(root, after),
    selected = new Set<string>();
  for (const update of updates) {
    ownedPath(root, update.path);
    if (
      selected.has(update.path) ||
      !sameGitEntry(expectedBefore.get(update.path), update.before) ||
      !sameGitEntry(expectedAfter.get(update.path), update.after)
    )
      throw new StateConflict(`Prepared transition does not match its Git trees: ${update.path}`);
    selected.add(update.path);
  }
  for (const path of new Set([...expectedBefore.keys(), ...expectedAfter.keys()]))
    if (!sameGitEntry(expectedBefore.get(path), expectedAfter.get(path)) && !selected.has(path))
      throw new StateConflict(`Prepared transition omits changed path: ${path}`);
  const ref = `refs/heads/${branch}`,
    actual = gitBytes(root, ["rev-parse", "HEAD"]).toString().trim();
  if (
    gitBytes(root, ["symbolic-ref", "--short", "HEAD"]).toString().trim() !== branch ||
    ![before, after].includes(actual)
  )
    throw new StateConflict("The checked-out branch changed during the prepared transition");
  if (actual === after) return;
  const compatible = (a: GitEntry | undefined, b: GitEntry | undefined) =>
    sameGitEntry(a, b) || (process.platform === "win32" && a?.oid === b?.oid);
  const checkWorking = (file: TreeUpdate) => {
    const entry = workingGitEntry(root, file.path, after.length);
    if (compatible(entry, file.before) || compatible(entry, file.after)) return;
    // A clean checkout can differ from its blob because Git applies EOL or encoding conversions.
    if (entry) {
      const converted = { ...entry, oid: convertedWorkingGitOid(root, file.path, after.length) };
      if (compatible(converted, file.before) || compatible(converted, file.after)) return;
    }
    throw new StateConflict(`File changed; preserving it for recovery: ${file.path}`);
  };
  withGitIndex(root, (index) => {
    const snapshot = new GitSnapshot(root);
    for (const file of updates) {
      checkWorking(file);
      const staged = snapshot.staged.get(file.path);
      if (!sameGitEntry(staged, file.before) && !sameGitEntry(staged, file.after))
        throw new StateConflict(`Staged file changed; preserving it for recovery: ${file.path}`);
    }
    gitBytes(
      root,
      ["update-index", "-z", "--index-info"],
      updates
        .map((file) => `${file.after?.mode ?? "0"} ${file.after?.oid ?? "0".repeat(after.length)}\t${file.path}\0`)
        .join(""),
      { GIT_INDEX_FILE: index },
    );
    for (const file of updates) {
      const path = ownedPath(root, file.path);
      if (!file.after) {
        checkWorking(file);
        rmSync(path, { force: true });
        continue;
      }
      const entry = file.after,
        mode = entry.mode === "100755" ? 0o755 : 0o644;
      mkdirSync(dirname(path), { recursive: true });
      writeAtomic(
        path,
        (descriptor) => {
          const result = spawnSync("git", ["-C", root, "cat-file", "--filters", `--path=${file.path}`, entry.oid], {
            stdio: ["ignore", descriptor, "pipe"],
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
            env: { ...process.env, GIT_INDEX_FILE: index, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
          });
          if (result.error || result.status !== 0)
            throw new Error(`Cannot restore ${file.path}: ${result.stderr}`, { cause: result.error });
        },
        mode,
        () => {
          checkWorking(file);
        },
      );
      if (process.platform !== "win32") chmodSync(path, mode);
    }
  });
  if (!options.stageOnly) gitBytes(root, ["update-ref", ref, after, before]);
  else if (gitBytes(root, ["rev-parse", "HEAD"]).toString().trim() !== before)
    throw new StateConflict("The branch changed while staging the inverse; preserve the prepared work before recovery");
}
