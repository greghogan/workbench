import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { createBrotliDecompress, brotliDecompress } from "node:zlib";
import { promisify } from "node:util";
import { once } from "node:events";
import type { Readable } from "node:stream";
import type { CitationDocumentSource } from "../citations.js";
import { negotiateEncoding } from "./content-negotiation.js";
import type { RequestTimings } from "./observability.js";
import { citationHtmlLimit } from "../citation-format.js";
import {
  citationFileStamp,
  openCitationFile,
  closeCitationFile,
  inspectCitationFile,
  type CitationIntegrity,
} from "../citation-integrity.js";
import { originalCitationHtml } from "../citation-html.js";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../diagnostics.js";
import { WebError } from "./errors.js";
import { send } from "./http.js";
import { streamFailure } from "./observability.js";
import { citationOriginalPage } from "./citation-original.js";
const decodeBrotli = promisify(brotliDecompress);
function reportStreamFailure(response: ServerResponse, error: unknown): void {
  if (
    error instanceof Error &&
    (error.name === "AbortError" || ("code" in error && error.code === "ERR_STREAM_PREMATURE_CLOSE"))
  )
    return;
  streamFailure(response, DiagnosticOperation.CitationDocument, error);
}
/** Own backpressure and cancellation without pipeline's retained listeners on the HTTP response. */
async function sendCitationStream(
  input: Readable,
  response: ServerResponse,
  signal: AbortSignal,
  decode = false,
): Promise<void> {
  const body = decode ? input.pipe(createBrotliDecompress()) : input;
  const inputFailed = (error: Error) => {
    body.destroy(error);
  };
  if (body !== input) input.once("error", inputFailed);
  const cancelled = () => {
    input.destroy();
    if (body !== input) body.destroy();
  };
  signal.addEventListener("abort", cancelled, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of body) {
      signal.throwIfAborted();
      if (!response.write(chunk)) await once(response, "drain", { signal });
    }
    signal.throwIfAborted();
    response.end();
  } finally {
    signal.removeEventListener("abort", cancelled);
    input.removeListener("error", inputFailed);
    input.destroy();
    if (body !== input) body.destroy();
  }
}
export interface CitationDocumentView {
  view: "reader" | "original" | "original-content";
  download: boolean;
  images: boolean;
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

/** Verified descriptors own responses; network opt-in belongs only to the isolated original representation. */
export class CitationDocuments {
  private readonly verified = new Map<string, CitationIntegrity>();
  private readonly originals = new Map<string, { body: Buffer; etag: string; bytes: number }>();
  private originalBytes = 0;
  constructor(private readonly sources: (id: string) => CitationDocumentSource[]) {}
  async serve(
    request: IncomingMessage,
    response: ServerResponse,
    id: string,
    kind: string,
    options: CitationDocumentView,
    timings?: RequestTimings,
  ): Promise<void> {
    response.setHeader("x-dns-prefetch-control", "off");
    const source = this.sources(id).find((source) => source.kind === kind);
    if (!source) throw new WebError(404, "citation source not found");
    const original = options.view !== "reader";
    const missing = () => {
      if (options.download || original) throw new WebError(404, "citation document is missing locally");
      response.writeHead(302, { location: source.downloadUrl ?? source.landingUrl });
      response.end();
    };
    if (original && source.format !== "html")
      throw new WebError(404, "This citation has no separate original HTML view");
    if (!(original ? source.originalPresent : source.present)) {
      missing();
      return;
    }
    if (options.view === "original" && !options.download) {
      response.setHeader(
        "content-security-policy",
        "default-src 'none'; style-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      const html = citationOriginalPage(id, kind, options.images);
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("content-length", Buffer.byteLength(html));
      response.writeHead(200);
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }
    const path = original ? source.originalPath : source.path;
    let file: FileHandle;
    try {
      file = await openCitationFile(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        missing();
        return;
      }
      throw error;
    }
    let transferred = false,
      failure: unknown;
    const controller = new AbortController(),
      cancelled = () => {
        controller.abort();
      };
    response.once("close", cancelled);
    const timeout = setTimeout(cancelled, 30000);
    timeout.unref();
    try {
      const stat = await file.stat();
      const expected = original ? source.originalSha256 : source.sha256;
      const key = JSON.stringify([path, citationFileStamp(stat), expected ?? "", original]);
      const verificationStarted = performance.now();
      let integrity = this.verified.get(key);
      if (!integrity) {
        const started = performance.now();
        try {
          integrity = await inspectCitationFile(file, { format: source.format, original, expected }, controller.signal);
        } catch (cause) {
          throw new WebError(
            cause instanceof Error && cause.message.includes("supported size") ? 413 : 409,
            cause instanceof Error ? cause.message : "local citation cannot be verified",
            { cause },
          );
        }
        if (this.verified.size >= 64) {
          const oldest = this.verified.keys().next().value;
          if (oldest) this.verified.delete(oldest);
        }
        this.verified.set(key, integrity);
        diagnostic(LogLevel.Debug, DiagnosticOperation.CitationVerification, DiagnosticOutcome.Completed, {
          record: id,
          source: kind,
          bytes: stat.size,
          durationMs: performance.now() - started,
        });
      }
      timings?.record("verification", performance.now() - verificationStarted);
      if (response.destroyed) return;
      clearTimeout(timeout);
      response.setHeader("etag", `"${integrity.encodedDigest}"`);
      if (
        (options.view === "original-content" || source.format === "pdf") &&
        !negotiateEncoding(request.headers["accept-encoding"], ["identity"])
      )
        throw new WebError(406, "No acceptable document encoding; allow identity");
      if (options.view === "original-content") {
        const started = performance.now();
        const renderKey = JSON.stringify([integrity.encodedDigest, source.documentUrl, source.charset]);
        let rendered = this.originals.get(renderKey);
        if (!rendered) {
          const bytes = await decodeBrotli(await file.readFile(), { maxOutputLength: citationHtmlLimit });
          if (citationFileStamp(stat) !== citationFileStamp(await file.stat()))
            throw new WebError(409, "citation changed; reopen it");
          const body = Buffer.from(originalCitationHtml(bytes, source.documentUrl, source.charset));
          rendered = {
            body,
            bytes: body.length + 2 * renderKey.length + 256,
            etag: `"${createHash("sha256").update(body).digest("hex")}"`,
          };
          if (rendered.bytes <= 16 * 1024 * 1024) {
            while (this.originals.size >= 32 || this.originalBytes + rendered.bytes > 16 * 1024 * 1024) {
              const oldest = this.originals.entries().next().value;
              if (!oldest) break;
              this.originals.delete(oldest[0]);
              this.originalBytes -= oldest[1].bytes;
            }
            this.originals.set(renderKey, rendered);
            this.originalBytes += rendered.bytes;
          }
        }
        timings?.record("original", performance.now() - started);
        if (response.closed) return;
        response.setHeader("etag", rendered.etag);
        response.setHeader("referrer-policy", "no-referrer");
        response.setHeader(
          "content-security-policy",
          `sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src data:${options.images ? " https:" : ""}; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`,
        );
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.setHeader("content-length", rendered.body.length);
        response.writeHead(200);
        response.end(request.method === "HEAD" ? undefined : rendered.body);
        return;
      }
      if (source.format === "html") {
        const encoding = negotiateEncoding(
          request.headers["accept-encoding"],
          !original && !options.download ? ["br", "identity"] : ["identity"],
        );
        if (!encoding) throw new WebError(406, "No acceptable document encoding; allow identity or Brotli");
        const encoded = encoding === "br";
        response.setHeader("vary", "Accept-Encoding");
        response.setHeader("etag", `"${integrity.encodedDigest}-${encoded ? "br" : "identity"}"`);
        response.setHeader(
          "content-security-policy",
          "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
        );
        response.setHeader("content-type", original ? "application/octet-stream" : "text/html; charset=utf-8");
        response.setHeader(
          "content-disposition",
          `${options.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(basename(path, ".br"))}`,
        );
        if (encoded) response.setHeader("content-encoding", "br");
        response.setHeader("content-length", encoded ? stat.size : integrity.decodedLength);
        if (request.method === "HEAD") {
          response.writeHead(200);
          response.end();
          return;
        }
        const stream = file.createReadStream({ start: 0 });
        transferred = true;
        response.setTimeout(30000, () => response.destroy());
        try {
          response.writeHead(200);
          await sendCitationStream(stream, response, controller.signal, !encoded);
        } catch (error) {
          stream.destroy();
          reportStreamFailure(response, error);
        }
        return;
      }
      response.setHeader("accept-ranges", "bytes");
      const range = request.method === "HEAD" ? undefined : byteRange(request.headers.range, stat.size);
      if (range === null) {
        response.setHeader("content-range", `bytes */${String(stat.size)}`);
        send(response, 416, "text/plain; charset=utf-8", "Requested PDF range is unavailable.");
        return;
      }
      response.setHeader(
        "content-security-policy",
        "default-src 'none'; object-src 'self'; frame-ancestors 'self'; base-uri 'none'",
      );
      response.setHeader("content-type", "application/pdf");
      response.setHeader(
        "content-disposition",
        `${options.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
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
      const stream = file.createReadStream({ start, end });
      transferred = true;
      response.setTimeout(30000, () => response.destroy());
      try {
        response.writeHead(range ? 206 : 200);
        await sendCitationStream(stream, response, controller.signal);
      } catch (error) {
        stream.destroy();
        reportStreamFailure(response, error);
      }
    } catch (error) {
      if (response.destroyed) return;
      failure = error;
      throw error;
    } finally {
      clearTimeout(timeout);
      response.removeListener("close", cancelled);
      if (!transferred) await closeCitationFile(file, failure);
    }
  }
}
