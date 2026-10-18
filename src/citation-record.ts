import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { ownedPath, relativePath } from "./paths.js";

export interface CitationSource {
  kind: string;
  "landing-url": string;
  "download-url"?: string;
  status: "pending" | "acquired" | "unavailable";
  sha256?: string;
  reason?: string;
}
export type CitationReference = Record<string, unknown> & { id: string; title: string; URL: string };
export interface CitationAcquisition {
  sources: CitationSource[];
  upstream?: { file: string; url?: string; sha256: string };
  extensions?: Record<string, unknown>;
}

export function https(value: unknown): value is string {
  return typeof value === "string" && URL.canParse(value) && value.startsWith("https://") && !/\s/.test(value);
}

export function citationSupportingPath(path: string, file: string): string {
  return ownedPath(dirname(path), `${basename(path, extname(path))}/${file}`);
}

export function acquisitionPath(path: string): string {
  return citationSupportingPath(path, "acquisition.yaml");
}

function readRegular(path: string): Buffer {
  if (!lstatSync(path).isFile()) throw new Error(`${path}: expected a regular file`);
  return readFileSync(path);
}

/** A standalone, one-item CSL-JSON bibliography; acquisition state lives beside it. */
export function parseCitation(contents: string, path: string): CitationReference {
  let bibliography: unknown;
  try {
    bibliography = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`${path}: invalid citation JSON: ${String(error)}`, { cause: error });
  }
  if (!Array.isArray(bibliography) || bibliography.length !== 1)
    throw new Error(`${path}: citation record must contain exactly one CSL reference`);
  const reference: unknown = bibliography[0];
  if (!reference || typeof reference !== "object" || Array.isArray(reference))
    throw new Error(`${path}: CSL reference must be an object`);
  const item = reference as Record<string, unknown>;
  for (const key of ["id", "type", "title"])
    if (typeof item[key] !== "string" || !item[key].trim()) throw new Error(`${path}: '${key}' must be nonempty text`);
  const authors = item.author;
  if (
    !Array.isArray(authors) ||
    !authors.length ||
    authors.some((author: unknown) => {
      if (!author || typeof author !== "object" || Array.isArray(author)) return true;
      const name = author as Record<string, unknown>;
      return ![name.family, name.literal].some((value) => typeof value === "string" && !!value.trim());
    })
  )
    throw new Error(`${path}: 'author' must contain family or literal names`);
  const issued = item.issued as { "date-parts"?: unknown[][] } | undefined;
  if (
    !Array.isArray(issued?.["date-parts"]) ||
    !Array.isArray(issued["date-parts"][0]) ||
    !issued["date-parts"][0].length
  )
    throw new Error(`${path}: 'issued.date-parts' must be nonempty`);
  if (!https(item.URL)) throw new Error(`${path}: 'URL' must use HTTPS`);
  if (Object.hasOwn(item, "workbench"))
    throw new Error(`${path}: Workbench acquisition metadata belongs in acquisition.yaml`);
  return item as CitationReference;
}

export function parseAcquisition(contents: string, path: string): CitationAcquisition {
  const document = parseDocument(contents);
  if (document.errors.length)
    throw new Error(`${path}: invalid acquisition YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  const value: unknown = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path}: expected an acquisition mapping`);
  const acquisition = value as Record<string, unknown>;
  if (!Array.isArray(acquisition.sources) || !acquisition.sources.length)
    throw new Error(`${path}: 'sources' must be nonempty`);
  const kinds = new Set<string>();
  for (const entry of acquisition.sources as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`${path}: source kinds must be unique filename-safe names`);
    const source = entry as Record<string, unknown>;
    if (typeof source.kind !== "string" || !/^[a-z0-9-]+$/.test(source.kind) || kinds.has(source.kind))
      throw new Error(`${path}: source kinds must be unique filename-safe names`);
    kinds.add(source.kind);
    if (!https(source["landing-url"]) || (source["download-url"] !== undefined && !https(source["download-url"])))
      throw new Error(`${path}: citation source URLs must use HTTPS`);
    if (source.sha256 !== undefined && (typeof source.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(source.sha256)))
      throw new Error(`${path}: source sha256 must be 64 hexadecimal characters`);
    if (source.sha256 === "0".repeat(64))
      throw new Error(`${path}: use status: unavailable instead of an all-zero digest`);
    if (typeof source.status !== "string" || !["pending", "acquired", "unavailable"].includes(source.status))
      throw new Error(`${path}: source status must be pending, acquired, or unavailable`);
    if (
      (source.status === "acquired" && !source.sha256) ||
      (source.status !== "acquired" && source.sha256 !== undefined)
    )
      throw new Error(`${path}: only an acquired source may have a sha256, and acquisition requires one`);
    if (source.reason !== undefined && (typeof source.reason !== "string" || !source.reason.trim()))
      throw new Error(`${path}: source reason must be nonempty text`);
  }
  if (acquisition.upstream !== undefined) {
    const entry = acquisition.upstream;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`${path}: upstream must identify its original metadata file`);
    const upstream = entry as Record<string, unknown>;
    if (typeof upstream.file !== "string")
      throw new Error(`${path}: upstream must identify its original metadata file`);
    relativePath(upstream.file, `${path}: upstream.file`);
    if (upstream.file === "acquisition.yaml") throw new Error(`${path}: upstream.file cannot name acquisition.yaml`);
    if (upstream.url !== undefined && !https(upstream.url)) throw new Error(`${path}: upstream URL must use HTTPS`);
    if (typeof upstream.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(upstream.sha256))
      throw new Error(`${path}: upstream sha256 must be lowercase hexadecimal`);
  }
  return value as CitationAcquisition;
}

export function readCitation(path: string) {
  const reference = parseCitation(readRegular(path).toString("utf8"), path);
  const metadataPath = acquisitionPath(path);
  const acquisition = parseAcquisition(readRegular(metadataPath).toString("utf8"), metadataPath);
  if (!acquisition.sources.some((source) => source["landing-url"] === reference.URL))
    throw new Error(`${path}: CSL URL must match a source landing URL`);
  if (acquisition.upstream) {
    const sourcePath = citationSupportingPath(path, acquisition.upstream.file);
    if (!existsSync(sourcePath)) throw new Error(`${metadataPath}: missing upstream metadata file ${sourcePath}`);
    const digest = createHash("sha256").update(readRegular(sourcePath)).digest("hex");
    if (digest !== acquisition.upstream.sha256) throw new Error(`${sourcePath}: upstream metadata SHA-256 differs`);
  }
  return { reference, acquisition, metadataPath };
}
