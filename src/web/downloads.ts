import { closeSync, constants, createReadStream, fstatSync, openSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename } from "node:path";
import { DiagnosticOperation } from "../diagnostics.js";
import { ownedPath } from "../paths.js";
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
