import { spawn } from "node:child_process";
import { readArchiveIndex } from "../../core/records/archive-store.js";
import { closeSync, constants, createReadStream, fstatSync, openSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename } from "node:path";
import { DiagnosticOperation } from "../../core/diagnostics/diagnostics.mjs";
import { ownedPath } from "../../core/runtime/paths.js";
import { WebError } from "./errors.js";
import { streamFailure } from "./observability.js";

/** The descriptor has one owner throughout header construction, streaming, and client cancellation. */
export function sendDownload(response: ServerResponse, directory: string, path: string): void {
  if (response.destroyed) return;
  const absolute = ownedPath(directory, path);
  const descriptor = openSync(absolute, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  let transferred = false;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new WebError(404, "supporting file is not a regular file");
    response.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`);
    const stream = createReadStream(absolute, { fd: descriptor, autoClose: true });
    transferred = true;
    stream.on("error", (error) => {
      streamFailure(response, DiagnosticOperation.SupportingFile, error);
    });
    response.once("close", () => stream.destroy());
    try {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": stat.size });
      stream.pipe(response);
    } catch (error) {
      stream.destroy();
      throw error;
    }
  } finally {
    if (!transferred) closeSync(descriptor);
  }
}

/** Immutable Git blobs stream directly, including large evidence files; no working copy is created. */
export function sendArchivedDownload(
  response: ServerResponse,
  source: { repository: string; revision: string },
  path: string,
): void {
  if (response.destroyed) return;
  const archive = readArchiveIndex(source.repository, source.revision),
    entry = archive.files.get(path);
  if (!entry) throw new WebError(404, "archived supporting file not found");
  const child = spawn("git", ["-C", archive.repository, "cat-file", "blob", entry.oid], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
  let errorText = "";
  child.stderr.on("data", (bytes: Buffer) => {
    errorText = (errorText + bytes.toString()).slice(0, 4096);
  });
  child.once("error", (error) => {
    streamFailure(response, DiagnosticOperation.SupportingFile, error);
  });
  child.stdout.once("error", (error) => {
    streamFailure(response, DiagnosticOperation.SupportingFile, error);
  });
  response.once("close", () => {
    child.stdout.destroy();
    child.kill();
  });
  child.once("close", (code) => {
    if (response.destroyed) return;
    if (code === 0) response.end();
    else
      streamFailure(response, DiagnosticOperation.SupportingFile, new Error(`Git blob download failed: ${errorText}`));
  });
  response.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`);
  response.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.sizes.get(path) });
  child.stdout.pipe(response, { end: false });
}
