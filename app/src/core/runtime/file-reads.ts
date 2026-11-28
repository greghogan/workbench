import { open, lstat, type FileHandle } from "node:fs/promises";
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, writeFileSync, type Stats } from "node:fs";
import { InvalidInput } from "./input-errors.js";
import { createHash } from "node:crypto";
import { combineFailures } from "../diagnostics/diagnostic-errors.mjs";

export class FileChanged extends InvalidInput {}

const readFlags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);

/** Bound open files and drain outstanding operations before reporting a failure. */
export async function mapFileIO<Input, Output>(
  entries: readonly Input[],
  read: (entry: Input) => Promise<Output>,
  concurrency = 16,
): Promise<Output[]> {
  const results: Output[] = [];
  for (let offset = 0; offset < entries.length; offset += concurrency) {
    for (const entry of await Promise.allSettled(entries.slice(offset, offset + concurrency).map(read))) {
      if (entry.status === "rejected") throw entry.reason;
      results.push(entry.value);
    }
  }
  return results;
}

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

/** Bind a delegated read to one stable regular file, including path-aware Git conversions. */
export function withStableFile<T>(path: string, read: (descriptor: number, metadata: Stats) => T): T {
  return withReadDescriptor(path, (descriptor, leaf) => {
    const before = fstatSync(descriptor);
    validateFile(path, before, Number.MAX_SAFE_INTEGER, "file", leaf);
    const value = read(descriptor, before);
    validateRead(path, "file", before, fstatSync(descriptor), before.size);
    return value;
  });
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

/** Hash a verified regular file without allocating its contents or following a replacement symlink. */
export function hashFile(
  path: string,
  maximum = Number.MAX_SAFE_INTEGER,
  kind = "file",
  options: { algorithm: "sha1" | "sha256"; prefix?: (size: number) => string } = { algorithm: "sha256" },
): string {
  validateLimit(maximum);
  return withReadDescriptor(path, (descriptor, leaf) => {
    const before = fstatSync(descriptor);
    validateFile(path, before, maximum, kind, leaf);
    const hash = createHash(options.algorithm),
      block = Buffer.alloc(64 * 1024);
    if (options.prefix) hash.update(options.prefix(before.size));
    let length = 0;
    for (;;) {
      const count = readSync(descriptor, block, 0, block.length, null);
      if (!count) break;
      length += count;
      if (length > maximum) throw new FileChanged(`${path}: ${kind} grew during verification`);
      hash.update(block.subarray(0, count));
    }
    validateRead(path, kind, before, fstatSync(descriptor), length);
    return hash.digest("hex");
  });
}

/** Copy a stable regular file into a caller-owned candidate without retaining the payload in memory. */
export function copyFileToDescriptor(path: string, output: number, observe?: (bytes: Uint8Array) => void): Stats {
  return withReadDescriptor(path, (descriptor, leaf) => {
    const before = fstatSync(descriptor);
    validateFile(path, before, Number.MAX_SAFE_INTEGER, "copy source", leaf);
    const block = Buffer.alloc(64 * 1024);
    let length = 0;
    for (;;) {
      const count = readSync(descriptor, block, 0, block.length, null);
      if (!count) break;
      const bytes = block.subarray(0, count);
      writeFileSync(output, bytes);
      observe?.(bytes);
      length += count;
    }
    validateRead(path, "copy source", before, fstatSync(descriptor), length);
    return before;
  });
}

/** Inspect a bounded regular-file prefix, optionally stopping at a discovered boundary. */
export function readFilePrefix(path: string, maximum: number, stopAt?: (prefix: Buffer) => number | undefined): Buffer {
  validateLimit(maximum);
  return withReadDescriptor(path, (descriptor, leaf) => {
    const metadata = fstatSync(descriptor);
    validateFile(path, metadata, Number.MAX_SAFE_INTEGER, "file", leaf);
    const buffer = Buffer.alloc(Math.min(metadata.size, maximum));
    let length = 0;
    let boundary: number | undefined;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, Math.min(64 * 1024, buffer.length - length), null);
      if (!count) break;
      length += count;
      boundary = stopAt?.(buffer.subarray(0, length));
      if (boundary !== undefined) {
        if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > length)
          throw new Error("Invalid file prefix boundary");
        break;
      }
    }
    validateRead(
      path,
      "file header",
      metadata,
      fstatSync(descriptor),
      length,
      boundary === undefined ? Math.min(metadata.size, maximum) : length,
    );
    return buffer.subarray(0, boundary ?? length);
  });
}

/** Async counterpart for cache inventories; allocation and validation use the opened regular file. */
export async function readBoundedFileAsync(path: string, maximum: number, kind = "file"): Promise<Buffer> {
  validateLimit(maximum);
  return withReadFile(path, async (file, leaf) => {
    const before = await file.stat();
    validateFile(path, before, maximum, kind, leaf);
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    validateRead(path, kind, before, await file.stat(), length);
    return buffer.subarray(0, length);
  });
}

/** Stream one verified file without following a replacement symlink. */
export function hashFileAsync(path: string): Promise<string> {
  return streamFileDigest(path).then(({ digest }) => digest);
}

/** Copy into an exclusive candidate while checking the source and hashing the copied bytes. */
export async function copyFileDigest(path: string, target: string): Promise<{ digest: string; mode: number }> {
  const output = await open(target, "wx", 0o600);
  try {
    const copied = await streamFileDigest(path, output);
    if (process.platform !== "win32") await output.chmod(copied.mode & 0o111 ? 0o755 : 0o644);
    return copied;
  } finally {
    await output.close();
  }
}

function streamFileDigest(path: string, output?: FileHandle) {
  return withReadFile(path, async (file, leaf) => {
    const before = await file.stat();
    validateFile(path, before, Number.MAX_SAFE_INTEGER, "file", leaf);
    const hash = createHash("sha256");
    const block = Buffer.alloc(64 * 1024);
    let length = 0;
    for (;;) {
      const { bytesRead } = await file.read(block, 0, block.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      const bytes = block.subarray(0, bytesRead);
      if (output) await output.writeFile(bytes);
      hash.update(bytes);
    }
    validateRead(path, "file", before, await file.stat(), length);
    return { digest: hash.digest("hex"), mode: before.mode };
  });
}

async function withReadFile<T>(
  path: string,
  read: (file: FileHandle, leaf: Stats | undefined) => Promise<T>,
): Promise<T> {
  // codeql[js/insecure-temporary-file] These numeric flags are read-only, without O_CREAT, and reject symlinks on POSIX.
  const leaf = process.platform === "win32" ? await lstat(path) : undefined;
  if (leaf?.isSymbolicLink()) throw new InvalidInput(`${path}: symlinks are not supported`);
  const file = await open(path, readFlags);
  let value: T;
  try {
    value = await read(file, leaf);
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
