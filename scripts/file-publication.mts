import { errorFrom } from "./values.mjs";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  linkSync,
  existsSync,
  fstatSync,
  readSync,
  constants,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { combineFailures } from "./diagnostic-errors.mjs";

export interface StagedFile {
  readonly temporary: string;
  readonly path: string;
  publish(beforeReplace?: () => void): void;
  discard(): void;
}
export interface PublicationOptions {
  createParent?: boolean;
}
export const publicationTemporaryGlob = ".*.????????-????-????-????-????????????.tmp";
const retryWait = new Int32Array(new SharedArrayBuffer(4));

/** Windows readers and scanners can temporarily deny replacement; never unlink the destination. */
function replaceFile(temporary: string, path: string, beforeReplace?: () => void): void {
  const attempts = process.platform === "win32" ? 8 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // A conflicting edit during a sharing violation must still prevent publication.
    beforeReplace?.();
    try {
      renameSync(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EACCES" && code !== "EPERM" && code !== "EBUSY")) throw error;
      if (attempt === attempts)
        throw new Error(`Atomic replacement failed after ${String(attempt)} attempts: ${path}`, { cause: error });
      Atomics.wait(retryWait, 0, 0, Math.min(25 * 2 ** (attempt - 1), 200));
    }
  }
}

/** Identify only the UUID candidate names owned by this publisher. */
export function publicationTarget(path: string): string | undefined {
  const match = /^\.(.+)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.exec(basename(path));
  return match?.[1] ? join(dirname(path), match[1]) : undefined;
}
/** Finish writing and closing every candidate before publishing a batch. */
export function stageFile(
  path: string,
  contents: string | Uint8Array,
  mode?: number,
  options: PublicationOptions = {},
): StagedFile {
  if (options.createParent !== false) mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined = openSync(temporary, "wx", mode);
  const staged: StagedFile = {
    path,
    temporary,
    publish(beforeReplace) {
      replaceFile(temporary, path, beforeReplace);
    },
    discard() {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
  try {
    writeFileSync(descriptor, contents);
    if (mode !== undefined) fchmodSync(descriptor, mode);
    const written = descriptor;
    descriptor = undefined; // A failed close may have released its descriptor already.
    closeSync(written);
    return staged;
  } catch (error) {
    const failures: unknown[] = [];
    if (descriptor !== undefined)
      try {
        closeSync(descriptor);
      } catch (cleanup) {
        failures.push(cleanup);
      }
    try {
      staged.discard();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    if (failures.length)
      throw combineFailures(
        error,
        new AggregateError(failures, `Temporary file cleanup failed: ${temporary}`),
        "File preparation and cleanup failed",
      );
    throw error;
  }
}
function publish(staged: StagedFile, action: () => void): void {
  let failure: unknown;
  let failed = false;
  try {
    action();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    staged.discard();
  } catch (cleanup) {
    if (failed) throw combineFailures(failure, cleanup, `File publication and cleanup failed: ${staged.temporary}`);
    throw cleanup;
  }
  if (failed) throw errorFrom(failure);
}
export function writeAtomic(
  path: string,
  contents: string | Uint8Array,
  mode?: number,
  beforeReplace?: () => void,
  options: PublicationOptions = {},
): void {
  const staged = stageFile(path, contents, mode, options);
  publish(staged, () => {
    staged.publish(beforeReplace);
  });
}
/** Publish a completely written new file without replacing an existing destination. */
export function writeNew(path: string, contents: string | Uint8Array, mode?: number): void {
  const staged = stageFile(path, contents, mode);
  publish(staged, () => {
    linkSync(staged.temporary, path);
  });
}
/** Expected bytes are checked at the final replacement boundary. */
export function publishFile(
  path: string,
  contents: string | Uint8Array,
  expected: Uint8Array | undefined,
  mode?: number,
): void {
  publishCheckedFiles([{ path, contents, expected, ...(mode === undefined ? {} : { mode }) }]);
}

export interface CheckedFile {
  path: string;
  contents: string | Uint8Array;
  expected: Uint8Array | undefined;
  mode?: number;
}
function matchesFile(path: string, expected: Uint8Array): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    );
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== expected.byteLength) return false;
    const buffer = Buffer.alloc(Math.min(64 * 1024, expected.byteLength + 1));
    let offset = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      if (
        offset + count > expected.byteLength ||
        !buffer.subarray(0, count).equals(expected.subarray(offset, offset + count))
      )
        return false;
      offset += count;
    }
    const after = fstatSync(descriptor);
    return (
      offset === expected.byteLength &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs
    );
  } finally {
    closeSync(descriptor);
  }
}
/** Preflight the full batch, then recheck each file at its final publication boundary. */
export function publishCheckedFiles(
  files: readonly CheckedFile[],
  validate?: (path: string) => void,
  published?: (path: string) => void,
): void {
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Duplicate checked output path");
  const check = (file: CheckedFile) => {
    validate?.(file.path);
    if (file.expected === undefined ? existsSync(file.path) : !matchesFile(file.path, file.expected))
      throw new Error(`${file.path}: file changed before replacement; preserve the changes and inspect a fresh plan`);
  };
  for (const file of files) check(file);
  const staged: { file: CheckedFile; stage: StagedFile }[] = [],
    completed: string[] = [],
    errors: unknown[] = [];
  try {
    for (const file of files) staged.push({ file, stage: stageFile(file.path, file.contents, file.mode) });
    for (const { file, stage } of staged) {
      if (file.expected === undefined) {
        check(file);
        linkSync(stage.temporary, file.path);
      } else
        stage.publish(() => {
          check(file);
        });
      completed.push(file.path);
      published?.(file.path);
    }
  } catch (error) {
    errors.push(error);
  }
  for (const { stage } of staged)
    try {
      stage.discard();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length === 1 && completed.length === 0) throw errorFrom(errors[0]);
  if (errors.length)
    throw new AggregateError(
      errors,
      `${errorFrom(errors[0]).message}; published files: ${completed.join(", ") || "none"}`,
      {
        cause: errors[0],
      },
    );
}
