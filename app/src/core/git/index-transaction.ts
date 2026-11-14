import { closeSync, copyFileSync, existsSync, fsyncSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitBytes } from "./git-snapshot.js";
import { StateConflict } from "../runtime/input-errors.js";

/** Coordinate with ordinary Git writers, preserving the real index until publication succeeds. */
export function withGitIndex<T>(root: string, action: (index: string) => T): T {
  const index = gitBytes(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).toString().trim(),
    lock = index + ".lock";
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch (cause) {
    throw new StateConflict("Git's index is busy; retry after the other Git operation finishes", { cause });
  }
  let temporary: string | undefined;
  try {
    temporary = mkdtempSync(join(dirname(index), "workbench-index-"));
    const prepared = join(temporary, "index");
    if (existsSync(index)) copyFileSync(index, prepared);
    const result = action(prepared);
    copyFileSync(prepared, lock);
    const descriptor = openSync(lock, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(lock, index);
    return result;
  } finally {
    rmSync(lock, { force: true });
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
