import { required } from "./invariants.js";
import { ownedPath, relativePath } from "./paths.js";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, join, relative } from "node:path";
import { parseDocument, stringify as yamlStringify } from "yaml";
import { parseReference, readConfig, readProjects, readText, rootOf, scan, writeAtomic, type Project } from "./core.js";
import { createRecord } from "./records.js";
import { formatDocument } from "./formatting.js";
import { sha256 } from "./releases.js";
import { formatByteCount } from "./byte-size.js";
import { terminalTable } from "./terminal-table.js";

import {
  acquisitionPath,
  parseCitation,
  parseAcquisition,
  readCitation,
  type CitationSource as Source,
} from "./citation-record.js";

const citationMetadataLimit = 1024 * 1024;
const citationDocumentLimit = 256 * 1024 * 1024;

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

async function fetchHttps(url: string, headers?: Record<string, string>): Promise<Response> {
  let current = url;
  const signal = AbortSignal.timeout(300_000);
  for (let redirect = 0; redirect < 8; redirect++) {
    if (!current.startsWith("https://") || /\s/.test(current)) throw new Error(`download URL is not HTTPS: ${current}`);
    const response = await fetch(current, { ...(headers ? { headers } : {}), redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error(`HTTP ${String(response.status)} without Location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${String(response.status)} from ${current}`);
    }
    return response;
  }
  throw new Error("too many HTTPS redirects");
}

export async function addCitation(root: string, identifier: string, projectId?: string): Promise<string> {
  const arxiv = parseArxiv(identifier);
  const doi = arxiv ? `10.48550/arXiv.${arxiv.replace(/v\d+$/, "")}` : parseDoi(identifier);
  if (!doi) throw new Error("expected an arXiv identifier or URL, or a DOI or DOI URL");
  const response = await fetchHttps(`https://doi.org/${doi}`, {
    Accept: "application/vnd.citationstyles.csl+json",
    "User-Agent": "workbench/0.1.0",
  });
  if (!response.body) throw new Error("Citation metadata response has no body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > citationMetadataLimit)
      throw new Error(`Citation metadata exceeds ${formatByteCount(citationMetadataLimit)}-byte limit`);
    chunks.push(chunk);
  }
  const original = Buffer.concat(chunks);
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

function documentPath(root: string, project: Project, recordPath: string, source: Source): string {
  return ownedPath(libraryDirectory(root, project), `${basename(recordPath, ".json")}-${source.kind}.pdf`);
}

function destination(root: string, project: Project, recordPath: string, source: Source): string {
  const path = documentPath(root, project, recordPath, source);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

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
  downloadUrl: string | null;
}

/** Presence is local; the recorded acquisition state and digest survive cloning without the ignored PDFs. */
export function citationStatus(root: string, projectId?: string): CitationStatus[] {
  return citationProjects(root, projectId).flatMap((project) =>
    scan(rootOf(root, project), "CIT").flatMap((record) => {
      const citation = readCitation(record.path);
      return citation.acquisition.sources.map((source) => {
        const path = documentPath(root, project, record.path, source);
        return {
          id: `${project.id}:CIT-${record.number}`,
          title: citation.reference.title,
          source: source.kind,
          state: source.status,
          present: existsSync(path) && lstatSync(path).isFile(),
          path,
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
        ["CITATION", "TITLE", "SOURCE", "FILE", "ACQUISITION", "PDF URL"],
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

function validatePdf(path: string): void {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`${path}: expected a regular, non-symlink PDF`);
  }
  const fd = openSync(path, "r");
  try {
    const signature = Buffer.alloc(5);
    if (readSync(fd, signature, 0, 5, 0) !== 5 || signature.toString() !== "%PDF-") {
      throw new Error(`${path}: file does not have a PDF signature`);
    }
  } finally {
    closeSync(fd);
  }
}

function verifyDigest(expected: string | undefined, actual: string, path: string): void {
  if (expected && expected.toLowerCase() !== actual) {
    throw new Error(`${path}: PDF SHA-256 differs from its citation source`);
  }
}

async function updateDigest(
  root: string,
  path: string,
  index: number,
  expected: Source,
  digest: string,
  publish?: () => void,
): Promise<void> {
  const metadataPath = acquisitionPath(path);
  const original = readText(metadataPath);
  const citation = readCitation(path);
  const source = citation.acquisition.sources[index];
  if (!source || !isDeepStrictEqual(source, expected))
    throw new Error(`${path}: citation source changed during acquisition; retry`);
  if (source.sha256 === digest && source.status === "acquired") {
    publish?.();
    return;
  }
  const document = parseDocument(original);
  document.setIn(["sources", index, "sha256"], digest);
  document.setIn(["sources", index, "status"], "acquired");
  if (source.status === "unavailable") document.deleteIn(["sources", index, "reason"]);
  const formatted = await formatDocument(
    document.toString(),
    metadataPath,
    required(
      required(readConfig(root).markdown, "expected readConfig(root).markdown").wrap_width,
      "expected readConfig(root).markdown!.wrap_width",
    ),
  );
  if (readText(metadataPath) !== original) throw new Error(`${metadataPath}: changed during acquisition; retry`);
  readCitation(path);
  publish?.();
  writeAtomic(metadataPath, formatted);
}

function publishTemp(temporary: string, destinationPath: string): void {
  try {
    linkSync(temporary, destinationPath);
  } finally {
    unlinkSync(temporary);
  }
}

async function downloadPdf(
  url: string,
  destinationPath: string,
  expected: string | undefined,
  accept: (temporary: string, digest: string) => Promise<void>,
): Promise<void> {
  if (existsSync(destinationPath))
    throw new Error(`${destinationPath} already exists; remove it explicitly before replacing it`);
  const response = await fetchHttps(url);
  if (!response.body) throw new Error("PDF response has no body");
  const temporary = join(join(destinationPath, ".."), `.${basename(destinationPath)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > citationDocumentLimit)
        throw new Error(`PDF exceeds ${formatByteCount(citationDocumentLimit)}-byte limit`);
      writeFileSync(fd, chunk);
    }
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  try {
    validatePdf(temporary);
    const digest = sha256(temporary);
    verifyDigest(expected, digest, destinationPath);
    await accept(temporary, digest);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
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

export async function fetchCitation(root: string, reference: string, sourceKind?: string): Promise<void> {
  const record = citationFor(root, reference);
  const [index, source] = selected(record.citation.acquisition.sources, sourceKind);
  const path = destination(root, record.project, record.path, source);
  if (existsSync(path)) {
    validatePdf(path);
    const digest = sha256(path);
    verifyDigest(source.sha256, digest, path);
    await updateDigest(root, record.path, index, source, digest);
    fetchSummary({ citations: 1, sources: 1, fetched: 0, verified: 1 });
    return;
  }
  if (!source["download-url"])
    throw new Error(
      `${reference} (${source.kind}) has no download-url; record a direct PDF URL or use citation import`,
    );
  await downloadPdf(source["download-url"], path, source.sha256, (temporary, digest) =>
    updateDigest(root, record.path, index, source, digest, () => {
      publishTemp(temporary, path);
    }),
  );
  console.log(`Fetched ${reference} (${source.kind}) to ${relative(root, path).replaceAll("\\", "/")}.`);
  fetchSummary({ citations: 1, sources: 1, fetched: 1, verified: 0 });
}

export async function importCitation(
  root: string,
  reference: string,
  sourcePath: string,
  sourceKind?: string,
): Promise<void> {
  const record = citationFor(root, reference);
  const [index, source] = selected(record.citation.acquisition.sources, sourceKind);
  validatePdf(sourcePath);
  const path = destination(root, record.project, record.path, source);
  if (existsSync(path)) throw new Error(`${path} already exists; remove it explicitly before replacing it`);
  const temporary = join(join(path, ".."), `.${basename(path)}.${randomUUID()}.tmp`);
  copyFileSync(sourcePath, temporary, constants.COPYFILE_EXCL);
  try {
    validatePdf(temporary);
    const digest = sha256(temporary);
    verifyDigest(source.sha256, digest, path);
    await updateDigest(root, record.path, index, source, digest, () => {
      publishTemp(temporary, path);
    });
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  console.log(
    `Imported ${record.project.id}:CIT-${record.number} (${source.kind}) to ${relative(root, path).replaceAll("\\", "/")}.`,
  );
}

export async function syncCitations(root: string, projectId?: string, sourceKind?: string): Promise<void> {
  const projects = citationProjects(root, projectId);
  const summary = { citations: 0, sources: 0, fetched: 0, verified: 0, unavailable: 0, missingUrls: 0 };
  for (const project of projects) {
    for (const record of scan(rootOf(root, project), "CIT")) {
      const citation = readCitation(record.path);
      const sources = [...citation.acquisition.sources.entries()].filter(
        ([, source]) => sourceKind === undefined || source.kind === sourceKind,
      );
      if (!sources.length) continue;
      summary.citations++;
      for (const [index, source] of sources) {
        summary.sources++;
        const path = destination(root, project, record.path, source);
        if (existsSync(path)) {
          validatePdf(path);
          const digest = sha256(path);
          verifyDigest(source.sha256, digest, path);
          await updateDigest(root, record.path, index, source, digest);
          summary.verified++;
        } else if (source.status === "unavailable") {
          summary.unavailable++;
        } else if (source["download-url"]) {
          try {
            await downloadPdf(source["download-url"], path, source.sha256, (temporary, digest) =>
              updateDigest(root, record.path, index, source, digest, () => {
                publishTemp(temporary, path);
              }),
            );
            summary.fetched++;
            console.log(
              `Fetched ${project.id}:CIT-${record.number} (${source.kind}) to ${relative(root, path).replaceAll("\\", "/")}.`,
            );
          } catch (error) {
            throw new Error(
              `${String(error)}; if access requires a browser, use 'workbench citation import ` +
                `${project.id}:CIT-${record.number} PATH --source ${source.kind}'`,
              { cause: error },
            );
          }
        } else {
          summary.missingUrls++;
        }
      }
    }
  }
  if (!summary.citations)
    console.log(sourceKind === undefined ? "No citation records to fetch." : "No citation sources match this kind.");
  else fetchSummary(summary);
  if (summary.missingUrls)
    throw new Error(
      `${String(summary.missingUrls)} source(s) have no download-url; use 'workbench citation --missing' to inspect them, then record a direct PDF URL or import the document`,
    );
}
