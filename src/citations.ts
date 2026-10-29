import { ChecksCancelled } from "./check-cancellation.js";
import { metadataBytes } from "../scripts/metadata-http.mjs";
import { processCancellation } from "../scripts/owned-child.mjs";
import { required } from "./invariants.js";
import { ownedPath, relativePath } from "./paths.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { parseReference, scan } from "./record-files.js";
import { readConfig, readProjects } from "./project-configuration.js";
import { rootOf } from "./project-context.js";
import { type Project } from "./project-model.js";
import { createRecord } from "./record-creation.js";
import { formatDocument } from "./formatting.js";
import { terminalTable } from "./terminal-table.js";
import { ownedFileBytes } from "./collection-files.js";
import {
  acquisitionPath,
  parseCitation,
  parseAcquisition,
  readCitation,
  type CitationSource as Source,
} from "./citation-record.js";
import { citationFormats, citationMetadataLimit } from "./citation-format.js";
import { fetchCitationHttps } from "./citation-fetch.js";
import { acquireCitationSource, type CitationPaths, type CitationAcquisitionMode } from "./citation-acquisition.js";
export { citationDocumentLimit } from "./citation-format.js";

function parseArxiv(value: string): string | undefined {
  const candidate = value
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//, "")
    .replace(/^arXiv:/, "")
    .split(/[?#]/, 1)[0]
    ?.replace(/\.pdf$/, "");
  if (!candidate) return undefined;
  const base = candidate.replace(/v\d+$/, "");
  return /^(?:\d{4}\.\d{4,5}|[A-Za-z0-9.-]+\/\d{7})$/.test(base) ? candidate : undefined;
}
function parseDoi(value: string): string | undefined {
  const candidate = value
    .trim()
    .replace(/^https?:\/\/(?:www\.|dx\.)?doi\.org\//, "")
    .replace(/^doi:/i, "");
  return candidate.startsWith("10.") && candidate.includes("/") && !/\s/.test(candidate) ? candidate : undefined;
}

async function addCitationMetadata(
  root: string,
  identifier: string,
  projectId: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const arxiv = parseArxiv(identifier);
  const doi = arxiv ? `10.48550/arXiv.${arxiv.replace(/v\d+$/, "")}` : parseDoi(identifier);
  if (!doi) throw new Error("expected an arXiv identifier or URL, or a DOI or DOI URL");
  const response = await fetchCitationHttps(`https://doi.org/${doi}`, signal, {
    Accept: "application/vnd.citationstyles.csl+json",
    "User-Agent": "workbench/0.1.0",
  });
  const original = await metadataBytes(response, citationMetadataLimit, "Citation metadata", signal);
  const csl = JSON.parse(original.toString("utf8")) as Record<string, unknown> | null;
  if (!csl || typeof csl !== "object" || Array.isArray(csl)) throw new Error("Citation metadata must be an object");
  if (typeof csl.title !== "string" || !csl.title.trim())
    throw new Error("Citation metadata has no title; use 'record add citation TITLE' for manual entry");
  const landing = arxiv ? `https://arxiv.org/abs/${arxiv}` : `https://doi.org/${doi}`;
  const source: Source = arxiv
    ? { kind: "arxiv", "landing-url": landing, "download-url": `https://arxiv.org/pdf/${arxiv}.pdf`, status: "pending" }
    : { kind: "published", "landing-url": landing, status: "pending" };
  const typeMap: Record<string, string> = {
    "journal-article": "article-journal",
    "proceedings-article": "paper-conference",
    "book-chapter": "chapter",
    "book-section": "chapter",
    dissertation: "thesis",
    "posted-content": "article",
  };
  const reference: Record<string, unknown> = {
    ...csl,
    id: "metadata-preview",
    type: typeMap[typeof csl.type === "string" ? csl.type : "article"] ?? csl.type ?? "article",
    URL: landing,
  };
  if (arxiv) {
    reference.archive = "arXiv";
    reference.archive_location = arxiv;
  }
  parseCitation(JSON.stringify([reference]), identifier);
  const metadata = yamlStringify({
    sources: [source],
    upstream: {
      file: "upstream.json",
      url: response.url || `https://doi.org/${doi}`,
      sha256: createHash("sha256").update(original).digest("hex"),
    },
  });
  parseAcquisition(metadata, identifier);
  const formattedMetadata = await formatDocument(
    metadata,
    "acquisition.yaml",
    readConfig(root).markdown?.wrap_width ?? 120,
  );
  return createRecord(root, "CIT", projectId, (number, project) => ({
    record: JSON.stringify([{ ...reference, id: `${project.id}-CIT-${number}` }]),
    supporting: { "acquisition.yaml": formattedMetadata, "upstream.json": original },
  }));
}

function citationFor(
  root: string,
  reference: string,
): { path: string; project: Project; number: string; citation: ReturnType<typeof readCitation> } {
  const parsed = parseReference(root, reference);
  if (parsed.kind !== "CIT") throw new Error("citation command requires a CIT reference");
  const citation = readCitation(parsed.path);
  return { path: parsed.path, project: parsed.project, number: parsed.number, citation };
}

function libraryDirectory(root: string, project: Project): string {
  return ownedPath(rootOf(root, project), citationLibrarySetting(root));
}

export function citationLibrarySetting(root: string): string {
  const config = readConfig(root) as { citations?: { library_dir?: string } };
  const relative = config.citations?.library_dir;
  if (
    !relative ||
    relative.split("/").some((component) => !component || component.startsWith(".") || component === "..")
  ) {
    throw new Error("'citations.library_dir' must be a safe relative path");
  }
  relativePath(relative, "citations.library_dir");
  return relative;
}

function documentPaths(root: string, project: Project, recordPath: string, source: Source): CitationPaths {
  const base = `${basename(recordPath, ".json")}-${source.kind}`;
  const format = citationFormats[source.format ?? "pdf"];
  const directory = libraryDirectory(root, project);
  return {
    path: ownedPath(directory, `${base}.${format.extension}`),
    originalPath: ownedPath(directory, `${base}.${format.originalExtension}`),
  };
}
const present = (path: string) => existsSync(path) && lstatSync(path).isFile();

function citationProjects(root: string, projectId?: string): Project[] {
  const projects = readProjects(root).filter(
    (project) => projectId === undefined || project.id.toLowerCase() === projectId.toLowerCase(),
  );
  if (!projects.length) throw new Error(`unknown project: ${String(projectId)}`);
  return projects;
}

export interface CitationStatus {
  id: string;
  title: string;
  source: string;
  state: Source["status"];
  present: boolean;
  path: string;
  readerPath?: string;
  downloadUrl: string | null;
}

export interface CitationDocumentSource {
  kind: string;
  format: "pdf" | "html";
  state: Source["status"];
  present: boolean;
  path: string;
  landingUrl: string;
  downloadUrl: string | undefined;
  sha256: string | undefined;
  reason: string | undefined;
  originalPath: string;
  originalPresent: boolean;
  originalSha256: string | undefined;
  charset: string | undefined;
  documentUrl: string;
}

/** Read local presence independently of recorded acquisition, including incomplete bibliographic drafts. */
export function citationDocumentSources(root: string, reference: string): CitationDocumentSource[] {
  const parsed = parseReference(root, reference);
  if (parsed.kind !== "CIT") throw new Error("citation documents require a CIT reference");
  const metadata = acquisitionPath(parsed.path);
  const acquisition = parseAcquisition(
    ownedFileBytes(dirname(metadata), basename(metadata), citationMetadataLimit).toString("utf8"),
    metadata,
  );
  return acquisition.sources.map((source) => {
    const { path, originalPath } = documentPaths(root, parsed.project, parsed.path, source);
    return {
      kind: source.kind,
      format: source.format,
      state: source.status,
      present: present(path),
      path,
      landingUrl: source["landing-url"],
      downloadUrl: source["download-url"],
      sha256: source.format === "html" ? source["extracted-sha256"] : source.sha256,
      reason: source.reason,
      originalPath,
      originalPresent: present(originalPath),
      originalSha256: source.sha256,
      charset: source.charset,
      documentUrl: source["document-url"] ?? source["download-url"] ?? source["landing-url"],
    };
  });
}

/** Presence is local; the recorded acquisition state and digest survive cloning without the ignored PDFs. */
export function citationStatus(root: string, projectId?: string): CitationStatus[] {
  return citationProjects(root, projectId).flatMap((project) =>
    scan(rootOf(root, project), "CIT").flatMap((record) => {
      const citation = readCitation(record.path);
      return citation.acquisition.sources.map((source) => {
        const { path, originalPath } = documentPaths(root, project, record.path, source);
        return {
          id: `${project.id}:CIT-${record.number}`,
          title: citation.reference.title,
          source: source.kind,
          state: source.status,
          present: present(path) && present(originalPath),
          path: originalPath,
          ...(source.format === "html" ? { readerPath: path } : {}),
          downloadUrl: source["download-url"] ?? null,
        };
      });
    }),
  );
}

export function listCitationStatus(
  root: string,
  options: { project?: string; source?: string; missing?: boolean; json?: boolean },
): void {
  const entries = citationStatus(root, options.project).filter(
    (entry) =>
      (options.source === undefined || entry.source === options.source) && (!options.missing || !entry.present),
  );
  if (options.json) console.log(JSON.stringify(entries, null, 2));
  else if (!entries.length)
    console.log(options.missing ? "No missing citation documents." : "No citation sources found.");
  else {
    console.log(
      terminalTable(
        ["CITATION", "TITLE", "SOURCE", "FILE", "ACQUISITION", "DOCUMENT URL"],
        entries.map((entry) => [
          entry.id,
          entry.title,
          entry.source,
          entry.present ? "present" : "missing",
          entry.state,
          entry.downloadUrl ? "set" : "missing",
        ]),
      ),
    );
    const present = entries.filter((entry) => entry.present).length;
    console.log(
      `Citations: ${String(new Set(entries.map((entry) => entry.id)).size)}; sources: ${String(entries.length)}; present: ${String(present)}; missing: ${String(entries.length - present)}.`,
    );
  }
}

function selected(sources: Source[], kind: string | undefined): [number, Source] {
  const choices = sources
    .map((source, index): [number, Source] => [index, source])
    .filter(([, source]) => kind === undefined || source.kind === kind);
  if (choices.length === 1) return required(choices[0], "expected choices[0]");
  if (!choices.length) throw new Error("no citation source matches that kind");
  throw new Error("multiple sources match; specify --source KIND");
}

function fetchSummary(summary: {
  citations: number;
  sources: number;
  fetched: number;
  verified: number;
  unavailable?: number;
  missingUrls?: number;
}): void {
  console.log(
    `Citations: ${String(summary.citations)}; sources: ${String(summary.sources)}; fetched: ${String(summary.fetched)}; verified: ${String(summary.verified)}` +
      (summary.unavailable ? `; unavailable: ${String(summary.unavailable)}` : "") +
      (summary.missingUrls ? `; missing download URLs: ${String(summary.missingUrls)}` : "") +
      ".",
  );
}

async function citationOperation<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const cancellation = processCancellation();
  try {
    return await action(cancellation.signal);
  } catch (error) {
    if (cancellation.signal.aborted) {
      const cancelled = new ChecksCancelled("Citation acquisition");
      cancelled.cause = error;
      throw cancelled;
    }
    throw error;
  } finally {
    cancellation.close();
  }
}
export const addCitation = (root: string, identifier: string, projectId?: string): Promise<string> =>
  citationOperation((signal) => addCitationMetadata(root, identifier, projectId, signal));

async function acquire(
  root: string,
  recordPath: string,
  project: Project,
  index: number,
  source: Source,
  operation: CitationAcquisitionMode,
  signal: AbortSignal,
) {
  const paths = documentPaths(root, project, recordPath, source);
  mkdirSync(dirname(paths.path), { recursive: true });
  const outcome = await acquireCitationSource({ root, record: recordPath, index, source, paths, operation, signal });
  if (outcome === "missing-url" && operation.mode !== "sync")
    throw new Error(
      `${project.id}:CIT-${basename(recordPath, ".json").slice(4)} (${source.kind}) has no download-url; record a direct document URL or use citation import`,
    );
  return { outcome, path: paths.originalPath };
}
export async function fetchCitation(root: string, reference: string, sourceKind?: string): Promise<void> {
  return citationOperation(async (signal) => {
    const record = citationFor(root, reference),
      [index, source] = selected(record.citation.acquisition.sources, sourceKind);
    const result = await acquire(root, record.path, record.project, index, source, { mode: "fetch" }, signal);
    if (result.outcome === "fetched")
      console.log(`Fetched ${reference} (${source.kind}) to ${relative(root, result.path).replaceAll("\\", "/")}.`);
    fetchSummary({
      citations: 1,
      sources: 1,
      fetched: Number(result.outcome === "fetched"),
      verified: Number(result.outcome === "verified"),
    });
  });
}
export async function importCitation(
  root: string,
  reference: string,
  sourcePath: string,
  sourceKind?: string,
): Promise<void> {
  return citationOperation(async (signal) => {
    const record = citationFor(root, reference),
      [index, source] = selected(record.citation.acquisition.sources, sourceKind);
    const result = await acquire(
      root,
      record.path,
      record.project,
      index,
      source,
      { mode: "import", input: sourcePath },
      signal,
    );
    console.log(
      `Imported ${record.project.id}:CIT-${record.number} (${source.kind}) to ${relative(root, result.path).replaceAll("\\", "/")}.`,
    );
  });
}
export async function syncCitations(root: string, projectId?: string, sourceKind?: string): Promise<void> {
  return citationOperation(async (signal) => {
    const summary = { citations: 0, sources: 0, fetched: 0, verified: 0, unavailable: 0, missingUrls: 0 };
    for (const project of citationProjects(root, projectId))
      for (const record of scan(rootOf(root, project), "CIT")) {
        const citation = readCitation(record.path);
        const sources = [...citation.acquisition.sources.entries()].filter(
          ([, source]) => sourceKind === undefined || source.kind === sourceKind,
        );
        if (!sources.length) continue;
        summary.citations++;
        for (const [index, source] of sources) {
          signal.throwIfAborted();
          summary.sources++;
          try {
            const result = await acquire(root, record.path, project, index, source, { mode: "sync" }, signal);
            if (result.outcome === "missing-url") summary.missingUrls++;
            else if (result.outcome !== "imported") summary[result.outcome]++;
            if (result.outcome === "fetched")
              console.log(
                `Fetched ${project.id}:CIT-${record.number} (${source.kind}) to ${relative(root, result.path).replaceAll("\\", "/")}.`,
              );
          } catch (error) {
            if (signal.aborted) throw error;
            throw new Error(
              `${String(error)}; if access requires a browser, use 'workbench citation import ${project.id}:CIT-${record.number} PATH --source ${source.kind}'`,
              { cause: error },
            );
          }
        }
      }
    if (!summary.citations)
      console.log(sourceKind === undefined ? "No citation records to fetch." : "No citation sources match this kind.");
    else fetchSummary(summary);
    if (summary.missingUrls)
      throw new Error(
        `${String(summary.missingUrls)} source(s) have no download-url; use 'workbench citation --missing' to inspect them, then record a direct document URL or import the document`,
      );
  });
}
