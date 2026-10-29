import { combineFailures } from "../../scripts/diagnostic-errors.mjs";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { citationDocumentLimit, citationDocumentSources } from "../citations.js";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../diagnostics.js";
import { WebError } from "./errors.js";
import { send } from "./http.js";
import { streamFailure } from "./observability.js";

const stamp = (stat: Stats): string =>
  `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}`;
async function closeFile(file: FileHandle, failure: unknown): Promise<void> {
  try {
    await file.close();
  } catch (cleanup) {
    if (failure !== undefined)
      throw combineFailures(failure, cleanup, "citation PDF operation and descriptor cleanup failed");
    throw cleanup;
  }
}
function byteRange(value: string | undefined, size: number): { start: number; end: number } | undefined | null {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : undefined,
    last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last)))
    return null;
  const start = first ?? Math.max(0, size - (last ?? 0)),
    end = first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);
  return start < 0 || start >= size || end < start ? null : { start, end };
}

/** Only registered citation sources can select files; verified descriptors own every streamed response. */
export class CitationDocuments {
  private readonly verified = new Map<string, string>();
  constructor(private readonly root: string) {}
  async serve(
    request: IncomingMessage,
    response: ServerResponse,
    id: string,
    kind: string,
    download: boolean,
  ): Promise<void> {
    const source = citationDocumentSources(this.root, id).find((source) => source.kind === kind);
    if (!source?.present) throw new WebError(404, "citation PDF is missing locally");
    const file = await open(
      source.path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new WebError(404, "citation PDF is missing locally", { cause: error });
      throw error;
    });
    let transferred = false;
    let failure: unknown;
    const controller = new AbortController();
    const cancelled = () => {
      controller.abort();
    };
    response.once("close", cancelled);
    const timeout = setTimeout(cancelled, 30000);
    timeout.unref();
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > citationDocumentLimit)
        throw new WebError(413, "citation PDF exceeds its supported size");
      const key = JSON.stringify([source.path, stamp(stat), source.sha256 ?? ""]);
      let digest = this.verified.get(key);
      if (!digest) {
        const started = performance.now();
        const signature = Buffer.alloc(5);
        if ((await file.read(signature, 0, 5, 0)).bytesRead !== 5 || signature.toString() !== "%PDF-")
          throw new WebError(409, "local citation file is not a PDF");
        const hash = createHash("sha256");
        let bytes = 0;
        const block = Buffer.alloc(64 * 1024);
        while (bytes < stat.size) {
          controller.signal.throwIfAborted();
          const { bytesRead } = await file.read(block, 0, Math.min(block.length, stat.size - bytes), bytes);
          if (!bytesRead) break;
          hash.update(block.subarray(0, bytesRead));
          bytes += bytesRead;
        }
        digest = hash.digest("hex");
        if (bytes !== stat.size || stamp(await file.stat()) !== stamp(stat))
          throw new WebError(409, "citation PDF changed during verification; reopen it");
        if (source.sha256 && digest !== source.sha256.toLowerCase())
          throw new WebError(
            409,
            "local PDF SHA-256 differs from its citation source; inspect or reacquire it explicitly",
          );
        if (this.verified.size >= 64) {
          const oldest = this.verified.keys().next().value;
          if (oldest) this.verified.delete(oldest);
        }
        this.verified.set(key, digest);
        diagnostic(LogLevel.Debug, DiagnosticOperation.CitationVerification, DiagnosticOutcome.Completed, {
          record: id,
          source: kind,
          bytes: stat.size,
          durationMs: performance.now() - started,
        });
      }
      if (response.destroyed) return;
      clearTimeout(timeout);
      response.removeListener("close", cancelled);
      response.setHeader("accept-ranges", "bytes");
      response.setHeader("etag", `"${digest}"`);
      const range = request.method === "HEAD" ? undefined : byteRange(request.headers.range, stat.size);
      if (range === null) {
        response.setHeader("content-range", `bytes */${String(stat.size)}`);
        send(response, 416, "text/plain; charset=utf-8", "Requested PDF range is unavailable.");
        return;
      }
      // The application pages keep their strict policy. This PDF-only response enables the browser's native viewer.
      response.setHeader(
        "content-security-policy",
        "default-src 'none'; object-src 'self'; frame-ancestors 'self'; base-uri 'none'",
      );
      response.setHeader("content-type", "application/pdf");
      response.setHeader(
        "content-disposition",
        `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(basename(source.path))}`,
      );
      const start = range?.start ?? 0,
        end = range?.end ?? stat.size - 1;
      response.setHeader("content-length", end - start + 1);
      if (range) response.setHeader("content-range", `bytes ${String(start)}-${String(end)}/${String(stat.size)}`);
      if (request.method === "HEAD") {
        response.writeHead(200);
        response.end();
        return;
      }
      const stream = file.createReadStream({ start, end, autoClose: true });
      transferred = true;
      stream.on("error", (error) => {
        streamFailure(response, DiagnosticOperation.CitationDocument, error);
      });
      response.once("close", () => stream.destroy());
      response.setTimeout(30000, () => response.destroy());
      try {
        response.writeHead(range ? 206 : 200);
        stream.pipe(response);
      } catch (error) {
        stream.destroy();
        throw error;
      }
    } catch (error) {
      if (response.destroyed) return;
      failure = error;
      throw error;
    } finally {
      clearTimeout(timeout);
      response.removeListener("close", cancelled);
      if (!transferred) await closeFile(file, failure);
    }
  }
}
