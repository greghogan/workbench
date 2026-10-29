import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, unlinkSync, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { brotliCompress, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import { parseDocument } from "yaml";
import { isDeepStrictEqual, promisify } from "node:util";
import { readBoundedFile } from "./file-reads.js";
import { withCacheLock } from "./cache-lock.js";
import { readConfig } from "./project-configuration.js";
import { formatDocument } from "./formatting.js";
import { publishFile, stageFile } from "../scripts/file-publication.mjs";
import { combineFailures, settleCleanup } from "../scripts/diagnostic-errors.mjs";
import { metadataBytes } from "../scripts/metadata-http.mjs";
import { acquisitionPath, parseAcquisition, readCitation, type CitationSource } from "./citation-record.js";
import {
  citationFormats,
  citationDocumentLimit,
  citationHtmlLimit,
  citationImageLimit,
  citationMetadataLimit,
} from "./citation-format.js";
import { verifyCitationFile, openCitationFile, closeCitationFile, citationFileStamp } from "./citation-integrity.js";
import { fetchCitationHttps } from "./citation-fetch.js";

export interface CitationPaths {
  path: string;
  originalPath: string;
}
export type CitationAcquisitionMode = { mode: "fetch" | "sync" } | { mode: "import"; input: string };
export type CitationAcquisitionOutcome = "fetched" | "verified" | "imported" | "unavailable" | "missing-url";
interface Acquisition {
  root: string;
  record: string;
  index: number;
  source: CitationSource;
  paths: CitationPaths;
  operation: CitationAcquisitionMode;
  signal: AbortSignal;
}
const encodeOriginal = promisify(brotliCompress);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const match = (expected: string | undefined, actual: string) => {
  if (expected && expected.toLowerCase() !== actual)
    throw new Error("document SHA-256 differs from its citation source");
};
/** Network and extraction run outside the record lock; only final source reconciliation and publication are serialized. */
export async function acquireCitationSource(request: Acquisition): Promise<CitationAcquisitionOutcome> {
  const { source, paths, operation, signal } = request,
    format = source.format ?? "pdf";
  const readerPresent = existsSync(paths.path),
    originalPresent = existsSync(paths.originalPath);
  if (operation.mode === "import" && (originalPresent || (format === "pdf" && readerPresent)))
    throw new Error("citation document already exists; remove it explicitly before replacing it");
  if (!readerPresent && !originalPresent && operation.mode === "sync" && source.status === "unavailable")
    return "unavailable";
  if (!originalPresent && operation.mode !== "import" && !source["download-url"]) return "missing-url";
  const prepared: { temporary: string; path: string }[] = [];
  const temporary = (path: string) => join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let sha: string,
    extracted: string | undefined,
    charset = source.charset,
    documentUrl = source["document-url"] ?? source["download-url"] ?? source["landing-url"];
  let failure: unknown;
  try {
    signal.throwIfAborted();
    if (format === "html") {
      let original: Buffer;
      if (originalPresent) {
        sha = await verifyCitationFile(paths.originalPath, { format, original: true, expected: source.sha256 }, signal);
        original = brotliDecompressSync(
          readBoundedFile(paths.originalPath, citationDocumentLimit, "original citation"),
          { maxOutputLength: citationHtmlLimit },
        );
        sha = digest(original);
        match(source.sha256, sha);
      } else {
        if (operation.mode === "import")
          original = readBoundedFile(operation.input, citationHtmlLimit, "original citation");
        else {
          const response = await fetchCitationHttps(source["download-url"] ?? "", signal);
          documentUrl = response.url || documentUrl;
          charset = /charset=["']?([^;"'\s]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
          original = await metadataBytes(response, citationHtmlLimit, "Citation webpage", signal);
        }
        sha = digest(original);
        match(source.sha256, sha);
        prepared.push(
          stageFile(
            paths.originalPath,
            await encodeOriginal(original, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } }),
          ),
        );
      }
      if (readerPresent)
        extracted = await verifyCitationFile(paths.path, { format, expected: source["extracted-sha256"] }, signal);
      else {
        const { captureCitationHtml } = await import("./citation-html.js");
        const captured = await captureCitationHtml(
          original,
          documentUrl,
          async (url) =>
            metadataBytes(await fetchCitationHttps(url, signal), citationImageLimit, "Citation image", signal),
          charset,
        );
        extracted = digest(captured);
        match(source["extracted-sha256"], extracted);
        prepared.push(stageFile(paths.path, captured));
      }
    } else if (readerPresent) sha = await verifyCitationFile(paths.path, { format, expected: source.sha256 }, signal);
    else {
      const staged = { temporary: temporary(paths.path), path: paths.path };
      const output = await open(staged.temporary, "wx");
      prepared.push(staged);
      let input: Awaited<ReturnType<typeof openCitationFile>> | undefined, inputStamp: string | undefined;
      let copyFailure: unknown;
      try {
        let body: AsyncIterable<Uint8Array>;
        if (operation.mode === "import") {
          input = await openCitationFile(operation.input);
          const stat = await input.stat();
          if (!stat.isFile() || stat.size > citationFormats.pdf.originalLimit)
            throw new Error("citation document exceeds its supported size");
          inputStamp = citationFileStamp(stat);
          body = input.createReadStream({ start: 0, autoClose: false });
        } else {
          const response = await fetchCitationHttps(source["download-url"] ?? "", signal);
          if (!response.body) throw new Error("PDF response has no body");
          body = response.body;
        }
        let bytes = 0;
        for await (const chunk of body) {
          signal.throwIfAborted();
          bytes += chunk.byteLength;
          if (bytes > citationDocumentLimit) throw new Error("citation document exceeds its supported size");
          await output.writeFile(chunk);
        }
        if (input && inputStamp !== citationFileStamp(await input.stat()))
          throw new Error("imported document changed during acquisition");
      } catch (error) {
        copyFailure = error;
        throw error;
      } finally {
        try {
          if (input) await closeCitationFile(input, copyFailure);
        } finally {
          await closeCitationFile(output, copyFailure);
        }
      }
      sha = await verifyCitationFile(staged.temporary, { format, expected: source.sha256 }, signal);
    }
    signal.throwIfAborted();
    const metadata = acquisitionPath(request.record);
    await withCacheLock(
      join(dirname(paths.path), `.${basename(request.record)}.acquisition`),
      async () => {
        signal.throwIfAborted();
        const original = readBoundedFile(metadata, citationMetadataLimit, "citation metadata").toString("utf8");
        const current = readCitation(request.record).acquisition.sources[request.index];
        if (!current || !isDeepStrictEqual(current, source))
          throw new Error(`${request.record}: citation source changed during acquisition; retry`);
        const document = parseDocument(original);
        document.setIn(["sources", request.index, "sha256"], sha);
        document.setIn(["sources", request.index, "status"], "acquired");
        if (extracted) document.setIn(["sources", request.index, "extracted-sha256"], extracted);
        if (format === "html") {
          if (charset) document.setIn(["sources", request.index, "charset"], charset);
          document.setIn(["sources", request.index, "document-url"], documentUrl);
        }
        if (source.status === "unavailable") document.deleteIn(["sources", request.index, "reason"]);
        const formatted = await formatDocument(
          document.toString(),
          metadata,
          readConfig(request.root).markdown?.wrap_width ?? 120,
        );
        if (Buffer.byteLength(formatted) > citationMetadataLimit)
          throw new Error("citation metadata exceeds its supported size");
        parseAcquisition(formatted, metadata);
        signal.throwIfAborted();
        if (readBoundedFile(metadata, citationMetadataLimit).toString() !== original)
          throw new Error(`${metadata}: changed during acquisition; retry`);
        const published: { path: string; stamp: string }[] = [];
        try {
          for (const file of prepared) {
            linkSync(file.temporary, file.path);
            published.push({ path: file.path, stamp: citationFileStamp(lstatSync(file.path)) });
          }
          if (formatted !== original) publishFile(metadata, formatted, Buffer.from(original));
        } catch (error) {
          const cleanup: unknown[] = [];
          for (const file of published.reverse()) {
            try {
              if (existsSync(file.path) && citationFileStamp(lstatSync(file.path)) === file.stamp)
                unlinkSync(file.path);
            } catch (problem) {
              cleanup.push(problem);
            }
          }
          if (cleanup.length)
            throw combineFailures(error, new AggregateError(cleanup), "citation publication and rollback failed");
          throw error;
        }
      },
      undefined,
      signal,
      { mutable: false },
    );
    return operation.mode === "import" ? "imported" : prepared.length ? "fetched" : "verified";
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await settleCleanup(
      prepared.map((file) => () => {
        if (existsSync(file.temporary)) unlinkSync(file.temporary);
      }),
      failure,
    );
  }
}
