import { createHash } from "node:crypto";
import { createBrotliDecompress } from "node:zlib";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { citationDocumentLimit, citationFormats, type CitationFormat } from "./citation-format.js";
import { combineFailures } from "../scripts/diagnostic-errors.mjs";

export const citationFileStamp = (stat: Stats): string =>
  `${String(stat.dev)}:${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}`;
export interface CitationFileSpec {
  format: CitationFormat;
  original?: boolean;
  expected?: string | undefined;
}
export interface CitationIntegrity {
  digest: string;
  encodedDigest: string;
  decodedLength: number;
}
export async function openCitationFile(path: string): Promise<FileHandle> {
  return open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
}
export async function closeCitationFile(file: FileHandle, failure?: unknown): Promise<void> {
  try {
    await file.close();
  } catch (cleanup) {
    if (failure !== undefined)
      throw combineFailures(failure, cleanup, "citation operation and descriptor cleanup failed");
    throw cleanup;
  }
}
/** Verify the same descriptor later used for serving; compressed source identity covers the decoded original bytes. */
export async function inspectCitationFile(
  file: FileHandle,
  spec: CitationFileSpec,
  signal?: AbortSignal,
): Promise<CitationIntegrity> {
  const before = await file.stat();
  if (!before.isFile() || before.size > citationDocumentLimit)
    throw new Error("citation document exceeds its supported size");
  const encoded = createHash("sha256"),
    decoded = createHash("sha256");
  let length = 0,
    prefix = Buffer.alloc(0);
  const bound = spec.original ? citationFormats[spec.format].originalLimit : citationDocumentLimit;
  const input = file.createReadStream({ start: 0, autoClose: false });
  const hash = new Transform({
    transform(chunk: Buffer, _encoding, next) {
      encoded.update(chunk);
      next(null, chunk);
    },
  });
  const output = new Writable({
    write(chunk: Buffer, _encoding, next) {
      length += chunk.length;
      if (length > bound) {
        next(new Error("decoded citation exceeds its supported size"));
        return;
      }
      if (prefix.length < 5) prefix = Buffer.concat([prefix, chunk.subarray(0, 5 - prefix.length)]);
      decoded.update(chunk);
      next();
    },
  });
  if (spec.format === "html")
    await pipeline(input, hash, createBrotliDecompress(), output, { ...(signal ? { signal } : {}) });
  else await pipeline(input, hash, output, { ...(signal ? { signal } : {}) });
  if (spec.format === "pdf" && prefix.toString() !== "%PDF-")
    throw new Error("citation file does not have a PDF signature");
  if (citationFileStamp(before) !== citationFileStamp(await file.stat()))
    throw new Error("citation document changed during verification; reopen it");
  const encodedDigest = encoded.digest("hex"),
    decodedDigest = decoded.digest("hex");
  const digest = spec.original && spec.format === "html" ? decodedDigest : encodedDigest;
  if (spec.expected && spec.expected.toLowerCase() !== digest)
    throw new Error("document SHA-256 differs from its citation source");
  return { digest, encodedDigest, decodedLength: length };
}
export async function verifyCitationFile(path: string, spec: CitationFileSpec, signal?: AbortSignal): Promise<string> {
  const file = await openCitationFile(path);
  let failure: unknown;
  try {
    return (await inspectCitationFile(file, spec, signal)).digest;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await closeCitationFile(file, failure);
  }
}
