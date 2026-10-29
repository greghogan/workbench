import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { InvalidInput } from "./input-errors.js";
import { combineFailures } from "../scripts/diagnostic-errors.mjs";

function withReadDescriptor<T>(path: string, read: (descriptor: number) => T): T {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  let value: T;
  try {
    value = read(descriptor);
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
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid file byte limit");
  return withReadDescriptor(path, (descriptor) => {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > maximum) throw new InvalidInput(`${path}: invalid or oversized ${kind}`);
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new InvalidInput(`${path}: ${kind} changed during verification`);
    return buffer.subarray(0, length);
  });
}

/** Inspect a regular file's header without reading or allocating its complete contents. */
export function readFilePrefix(path: string, maximum: number): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid file byte limit");
  return withReadDescriptor(path, (descriptor) => {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new InvalidInput(`${path}: not a regular file`);
    const buffer = Buffer.alloc(Math.min(metadata.size, maximum));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    return buffer.subarray(0, length);
  });
}
