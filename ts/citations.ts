import { randomUUID } from "node:crypto";
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
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { parseReference, readConfig, readProjects, readText, rootOf, scan, writeAtomic, type Project } from "./core.js";
import { createRecord } from "./records.js";
import { sha256 } from "./releases.js";

const zeroDigest = "0".repeat(64);
type Source = { kind: string; "landing-url": string; "download-url"?: string; sha256?: string };
type Citation = {
  references: Array<Record<string, unknown> & { id: string; title: string; URL?: string }>;
  workbench: { sources: Source[] };
};

function https(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("https://") && !/\s/.test(value);
}

export function parseCitation(contents: string, path: string): Citation {
  let citation: Citation;
  try {
    citation = yamlParse(contents) as Citation;
  } catch (error) {
    throw new Error(`${path}: invalid citation YAML: ${String(error)}`, { cause: error });
  }
  if (!Array.isArray(citation?.references) || citation.references.length !== 1) {
    throw new Error(`${path}: citation record must contain exactly one CSL reference`);
  }
  const reference = citation.references[0]!;
  for (const key of ["id", "type", "title"] as const) {
    if (typeof reference[key] !== "string" || !reference[key].trim())
      throw new Error(`${path}: '${key}' must be nonempty text`);
  }
  const authors = reference.author as Array<{ family?: string; literal?: string }> | undefined;
  if (
    !Array.isArray(authors) ||
    !authors.length ||
    authors.some((author) => !author.family?.trim() && !author.literal?.trim())
  ) {
    throw new Error(`${path}: 'author' must contain family or literal names`);
  }
  const issued = reference.issued as { "date-parts"?: unknown[][] } | undefined;
  if (!Array.isArray(issued?.["date-parts"]) || !issued["date-parts"][0]?.length) {
    throw new Error(`${path}: 'issued.date-parts' must be nonempty`);
  }
  if (!https(reference.URL)) throw new Error(`${path}: 'URL' must use HTTPS`);
  const sources = citation.workbench?.sources;
  if (!Array.isArray(sources) || !sources.length) throw new Error(`${path}: 'workbench.sources' must be nonempty`);
  const kinds = new Set<string>();
  for (const source of sources) {
    if (!/^[a-z0-9-]+$/.test(source.kind) || kinds.has(source.kind)) {
      throw new Error(`${path}: source kinds must be unique filename-safe names`);
    }
    kinds.add(source.kind);
    if (!https(source["landing-url"]) || (source["download-url"] !== undefined && !https(source["download-url"]))) {
      throw new Error(`${path}: citation source URLs must use HTTPS`);
    }
    if (source.sha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(source.sha256)) {
      throw new Error(`${path}: source sha256 must be 64 hexadecimal characters`);
    }
  }
  if (!sources.some((source) => source["landing-url"] === reference.URL)) {
    throw new Error(`${path}: CSL URL must match a source landing URL`);
  }
  return citation;
}

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
  for (let redirect = 0; redirect < 8; redirect++) {
    if (!current.startsWith("https://") || /\s/.test(current)) throw new Error(`download URL is not HTTPS: ${current}`);
    const response = await fetch(current, { ...(headers ? { headers } : {}), redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`HTTP ${response.status} without Location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${current}`);
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
  const csl = (await response.json()) as Record<string, unknown>;
  const landing = arxiv ? `https://arxiv.org/abs/${arxiv}` : `https://doi.org/${doi}`;
  const source: Source = arxiv
    ? { kind: "arxiv", "landing-url": landing, "download-url": `https://arxiv.org/pdf/${arxiv}.pdf` }
    : { kind: "published", "landing-url": landing };
  const typeMap: Record<string, string> = {
    "journal-article": "article-journal",
    "proceedings-article": "paper-conference",
    "book-chapter": "chapter",
    "book-section": "chapter",
    dissertation: "thesis",
    "posted-content": "article",
  };
  return createRecord(root, "CIT", projectId, (number, project) => {
    const reference: Record<string, unknown> = {
      id: `${project.id}-CIT-${number}`,
      type:
        typeMap[typeof csl.type === "string" ? csl.type : "article"] ??
        (typeof csl.type === "string" ? csl.type : "article"),
      title: typeof csl.title === "string" ? csl.title : "Untitled source",
      author: Array.isArray(csl.author) ? csl.author : [],
      issued: csl.issued ?? { "date-parts": [] },
      URL: landing,
    };
    for (const key of ["container-title", "volume", "issue", "page", "publisher", "DOI"]) {
      if (typeof csl[key] === "string") reference[key] = csl[key];
    }
    if (arxiv) {
      reference.archive = "arXiv";
      reference.archive_location = arxiv;
    }
    return yamlStringify({ references: [reference], workbench: { sources: [source] } });
  });
}

function citationFor(
  root: string,
  reference: string,
): { path: string; project: Project; number: string; citation: Citation } {
  const parsed = parseReference(root, reference);
  if (parsed.kind !== "CIT") throw new Error("citation command requires a CIT reference");
  const citation = parseCitation(readText(parsed.path), parsed.path);
  return { path: parsed.path, project: parsed.project, number: parsed.number, citation };
}

function libraryDirectory(root: string, project: Project): string {
  const relative = citationLibrarySetting(root);
  let directory = rootOf(root, project);
  for (const component of relative.split("/")) {
    directory = join(directory, component);
    if (existsSync(directory)) {
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
        throw new Error(`${directory}: expected a real directory`);
      }
    } else mkdirSync(directory);
  }
  return directory;
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
  return relative;
}

function destination(root: string, project: Project, recordPath: string, source: Source): string {
  return join(libraryDirectory(root, project), `${basename(recordPath, ".yaml")}-${source.kind}.pdf`);
}

function selected(sources: Source[], kind: string | undefined, directOnly: boolean): [number, Source] {
  const choices = sources
    .map((source, index): [number, Source] => [index, source])
    .filter(([, source]) => (!kind || source.kind === kind) && (!directOnly || !!source["download-url"]));
  if (choices.length === 1) return choices[0]!;
  if (!choices.length)
    throw new Error(
      directOnly
        ? "no matching source has a direct download URL; use citation import"
        : "no citation source matches that kind",
    );
  throw new Error("multiple sources match; specify --source KIND (or SOURCE for fetch)");
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
  if (expected && expected !== zeroDigest && expected.toLowerCase() !== actual) {
    throw new Error(`${path}: PDF SHA-256 differs from its citation source`);
  }
}

function updateDigest(path: string, index: number, digest: string): void {
  const citation = parseCitation(readText(path), path);
  const source = citation.workbench.sources[index];
  if (!source) throw new Error(`${path}: citation source disappeared`);
  if (source.sha256 === digest) return;
  source.sha256 = digest;
  writeAtomic(path, yamlStringify(citation));
}

function publishTemp(temporary: string, destinationPath: string): void {
  try {
    linkSync(temporary, destinationPath);
  } finally {
    unlinkSync(temporary);
  }
}

async function downloadPdf(url: string, destinationPath: string, expected?: string): Promise<string> {
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
      if (bytes > 268435456) throw new Error("PDF exceeds 256 MiB limit");
      writeSync(fd, chunk);
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
    publishTemp(temporary, destinationPath);
    return digest;
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export async function fetchCitation(root: string, reference: string, sourceKind?: string): Promise<void> {
  const record = citationFor(root, reference);
  const [index, source] = selected(record.citation.workbench.sources, sourceKind, true);
  const path = destination(root, record.project, record.path, source);
  const digest = await downloadPdf(source["download-url"]!, path, source.sha256);
  updateDigest(record.path, index, digest);
  console.log(`Fetched ${record.citation.references[0]!.id} (${source.kind}) to ${path}.`);
}

export function importCitation(root: string, reference: string, sourcePath: string, sourceKind?: string): void {
  const record = citationFor(root, reference);
  const [index, source] = selected(record.citation.workbench.sources, sourceKind, false);
  validatePdf(sourcePath);
  const path = destination(root, record.project, record.path, source);
  if (existsSync(path)) throw new Error(`${path} already exists; remove it explicitly before replacing it`);
  const temporary = join(join(path, ".."), `.${basename(path)}.${randomUUID()}.tmp`);
  copyFileSync(sourcePath, temporary, constants.COPYFILE_EXCL);
  try {
    validatePdf(temporary);
    const digest = sha256(temporary);
    verifyDigest(source.sha256, digest, path);
    publishTemp(temporary, path);
    updateDigest(record.path, index, digest);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  console.log(`Imported ${record.citation.references[0]!.id} (${source.kind}) to ${path}.`);
}

export async function syncCitations(root: string, projectId?: string): Promise<void> {
  const projects = readProjects(root).filter(
    (project) => !projectId || project.id.toLowerCase() === projectId.toLowerCase(),
  );
  if (!projects.length) throw new Error(`unknown project: ${projectId}`);
  const manual: string[] = [];
  let count = 0;
  for (const project of projects) {
    for (const record of scan(rootOf(root, project), "CIT")) {
      count++;
      const citation = parseCitation(readText(record.path), record.path);
      for (const [index, source] of citation.workbench.sources.entries()) {
        const path = destination(root, project, record.path, source);
        if (existsSync(path)) {
          validatePdf(path);
          const digest = sha256(path);
          verifyDigest(source.sha256, digest, path);
          if (!source.sha256 || source.sha256 === zeroDigest) updateDigest(record.path, index, digest);
          console.log(`Present ${citation.references[0]!.id} (${source.kind}) at ${path}.`);
        } else if (source.sha256 === zeroDigest) {
          console.log(`Unavailable ${citation.references[0]!.id} (${source.kind}).`);
        } else if (source["download-url"]) {
          try {
            const digest = await downloadPdf(source["download-url"], path, source.sha256);
            updateDigest(record.path, index, digest);
            console.log(`Fetched ${citation.references[0]!.id} (${source.kind}) to ${path}.`);
          } catch (error) {
            throw new Error(
              `${String(error)}; if access requires a browser, use 'workbench citation import ` +
                `${project.id}:CIT-${record.number} PATH --source ${source.kind}'`,
              { cause: error },
            );
          }
        } else {
          manual.push(
            `${citation.references[0]!.id} (${source.kind}, ${source["landing-url"]}); use ` +
              `'workbench citation import ${project.id}:CIT-${record.number} PATH --source ${source.kind}'`,
          );
        }
      }
    }
  }
  if (!count) console.log("No citation records to synchronize.");
  if (manual.length)
    throw new Error(`${manual.length} source(s) require manual acquisition:\n- ${manual.join("\n- ")}`);
}
