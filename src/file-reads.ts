import { open, lstat } from "node:fs/promises";
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, type Stats } from "node:fs";
import { InvalidInput } from "./input-errors.js";
import { combineFailures } from "../scripts/diagnostic-errors.mjs";

export class FileChanged extends InvalidInput {}

const readFlags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);

function validateLimit(maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid file byte limit");
}
function validateFile(path: string, metadata: Stats, maximum: number, kind: string, leaf?: Stats): void {
  if (leaf && (leaf.isSymbolicLink() || leaf.dev !== metadata.dev || leaf.ino !== metadata.ino))
    throw new FileChanged(`${path}: file identity changed during opening`);
  if (!metadata.isFile() || metadata.size > maximum)
    throw new InvalidInput(`${path}: invalid or oversized ${kind}; expected a regular file within its size limit`);
}
function validateRead(
  path: string,
  kind: string,
  before: Stats,
  after: Stats,
  length: number,
  expected = before.size,
): void {
  if (
    length !== expected ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new FileChanged(`${path}: ${kind} changed during verification`);
}
function withReadDescriptor<T>(path: string, read: (descriptor: number, leaf: Stats | undefined) => T): T {
  const leaf = process.platform === "win32" ? lstatSync(path) : undefined;
  if (leaf?.isSymbolicLink()) throw new InvalidInput(`${path}: symlinks are not supported`);
  // codeql[js/insecure-temporary-file] These numeric flags are read-only, without O_CREAT, and reject symlinks on POSIX.
  const descriptor = openSync(path, readFlags);
  let value: T;
  try {
    value = read(descriptor, leaf);
  } catch (failure) {
    try {
      closeSync(descriptor);
    } catch (cleanup) {
      throw combineFailures(failure, cleanup, "File verification and descriptor cleanup failed");
    }
    throw failure;
  }
  closeSync(descriptor);
  return value;
}

/** The descriptor binds validation and bounded allocation to the same regular file. */
export function readBoundedFile(path: string, maximum: number, kind = "file"): Buffer {
  validateLimit(maximum);
  return withReadDescriptor(path, (descriptor, leaf) => {
    const before = fstatSync(descriptor);
    validateFile(path, before, maximum, kind, leaf);
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    validateRead(path, kind, before, after, length);
    return buffer.subarray(0, length);
  });
}

/** Inspect a regular file's header without reading or allocating its complete contents. */
export function readFilePrefix(path: string, maximum: number): Buffer {
  validateLimit(maximum);
  return withReadDescriptor(path, (descriptor, leaf) => {
    const metadata = fstatSync(descriptor);
    validateFile(path, metadata, Number.MAX_SAFE_INTEGER, "file", leaf);
    const buffer = Buffer.alloc(Math.min(metadata.size, maximum));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    validateRead(path, "file header", metadata, fstatSync(descriptor), length, Math.min(metadata.size, maximum));
    return buffer.subarray(0, length);
  });
}

/** Async counterpart for cache inventories; allocation and validation use the opened regular file. */
export async function readBoundedFileAsync(path: string, maximum: number, kind = "file"): Promise<Buffer> {
  validateLimit(maximum);
  // codeql[js/insecure-temporary-file] These numeric flags are read-only, without O_CREAT, and reject symlinks on POSIX.
  const leaf = process.platform === "win32" ? await lstat(path) : undefined;
  if (leaf?.isSymbolicLink()) throw new InvalidInput(`${path}: symlinks are not supported`);
  const file = await open(path, readFlags);
  let value: Buffer;
  try {
    const before = await file.stat();
    validateFile(path, before, maximum, kind, leaf);
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    validateRead(path, kind, before, after, length);
    value = buffer.subarray(0, length);
  } catch (failure) {
    try {
      await file.close();
    } catch (cleanup) {
      throw combineFailures(failure, cleanup, "File verification and descriptor cleanup failed");
    }
    throw failure;
  }
  await file.close();
  return value;
}
