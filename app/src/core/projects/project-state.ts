import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectPaths } from "./project-paths.js";
import { readText, readToml } from "../runtime/files.js";
import { record } from "../runtime/values.mjs";
import { editToml } from "../configuration/toml-edit.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { acquireProcessLock } from "../storage/process-lock.js";
import { releaseAfterFailure, withCacheLockSync } from "../storage/cache-lock.js";

export function readProjectState(directory: string): Record<string, unknown> {
  const path = join(directory, projectPaths.state);
  return existsSync(path) ? record(readToml(path), `${path}: invalid project state`) : {};
}

/** Allocation and archive metadata share this lock and preserve each other's fields. */
export function withProjectStateLock<T>(directory: string, action: () => T): T {
  const path = join(directory, "workbench/.record-allocation.lock");
  const owner = withCacheLockSync(`${path}.admission`, () => acquireProcessLock(path, true), 0);
  if (!owner)
    throw new Error(
      `${path}: another record allocation or state update may be running; confirm no writer is active before recovering an uncertain lock`,
    );
  let result: T;
  try {
    result = action();
  } catch (failure) {
    releaseAfterFailure(
      () => {
        owner.release();
      },
      failure,
      "Project state update and lock release failed",
    );
  }
  owner.release();
  return result;
}

export function updateProjectState(directory: string, update: (state: Record<string, unknown>) => void): void {
  withProjectStateLock(directory, () => {
    const state = readProjectState(directory);
    update(state);
    const path = join(directory, projectPaths.state);
    writeAtomic(path, editToml(existsSync(path) ? readText(path) : "", state));
  });
}
