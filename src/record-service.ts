import { InvalidInput, MissingResource, StateConflict } from "./input-errors.js";
import { citationMetadata, yamlMetadata, recordPresentations } from "./record-metadata.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { detail, kinds, type Kind } from "./record-identity.js";
import { readProjects, selectProject } from "./project-configuration.js";
import { rootOf } from "./project-context.js";
import { scan, scanRecordDirectory } from "./record-files.js";
import { writeAtomic, writeNew } from "../scripts/file-publication.mjs";
import { resolveCollections, type ResolvedCollection } from "./collections.js";
import { ownedFileBytes } from "./collection-files.js";
import { ownedPath } from "./paths.js";
import { parseProseRecord } from "./record-document.js";
import { reviewGit } from "./review-service.js";
import { withCacheLockSync } from "./cache-lock.js";

export const previewLimit = 2 * 1024 * 1024;
export interface BrowserRecord {
  id: string;
  type: Kind | "CHARTER";
  scope: string;
  title: string;
  summary: string;
  status: string;
  path: string;
  directory: string;
  editable: boolean;
  local: boolean;
  collection: boolean;
  previewError?: string;
  adaptation?: "modified" | "added";
  citationPresence?: { present: number; total: number } | { error: string };
}
export const contentDigest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function recordBytes(record: Pick<BrowserRecord, "directory" | "path">): Buffer {
  return ownedFileBytes(record.directory, record.path, previewLimit);
}

interface CachedMetadata {
  stamp: string;
  title: string;
  summary: string;
  status: string;
  previewError?: string;
}
function summaryParagraph(body: string): string {
  return (
    body
      .split(/\n\s*\n/)
      .find((paragraph) => paragraph.trim() && !paragraph.trim().startsWith("#"))
      ?.replace(/\s+/g, " ")
      .trim() ?? ""
  );
}
/** A disposable metadata index; authoritative document bytes remain on disk. */
export class RecordCatalog {
  private readonly metadata = new Map<string, CachedMetadata>();
  constructor(private readonly root: string) {}
  records(collections?: ResolvedCollection[], observe?: (path: string) => void): BrowserRecord[] {
    return workspaceRecords(this.root, this.metadata, collections, observe);
  }
}

/** Browse drafts without requiring their metadata to be complete or valid. */
export function workspaceRecords(
  root: string,
  cache = new Map<string, CachedMetadata>(),
  collections = resolveCollections(root),
  observe: (path: string) => void = () => undefined,
): BrowserRecord[] {
  const seen = new Set<string>();
  const records: BrowserRecord[] = [];
  const projects = readProjects(root);
  const namespaces = new Set(projects.map((project) => project.id));
  for (const collection of collections) {
    if (namespaces.has(collection.pin.id))
      throw new Error(`project and collection namespace collision: ${collection.pin.id}`);
    namespaces.add(collection.pin.id);
  }
  const add = (
    directory: string,
    path: string,
    scope: string,
    type: BrowserRecord["type"],
    number: string,
    local: boolean,
    collection = false,
  ) => {
    const record: BrowserRecord = {
      id: `${scope}:${type}${number ? `-${number}` : ""}`,
      type,
      scope,
      title: type === "CHARTER" ? `${scope} charter` : `${type}-${number}`,
      summary: "",
      status: "",
      path: relative(directory, path).replaceAll("\\", "/"),
      directory,
      editable: !local && recordPresentations[type].editable,
      local,
      collection,
    };
    const absolute = ownedPath(directory, record.path);
    seen.add(absolute);
    observe(dirname(absolute));
    observe(absolute);
    const info = lstatSync(absolute);
    const stamp = `${String(info.ino)}:${String(info.size)}:${String(info.mtimeMs)}:${String(info.ctimeMs)}`;
    const cached = cache.get(absolute);
    if (cached?.stamp === stamp) {
      records.push({
        ...record,
        title: cached.title,
        summary: cached.summary,
        status: cached.status,
        ...(cached.previewError ? { previewError: cached.previewError } : {}),
      });
      return;
    }
    try {
      const contents = recordBytes(record).toString("utf8");
      record.title = /^#\s+(.+)$/m.exec(contents)?.[1] ?? record.title;
      if (type === "CIT") {
        const citation = citationMetadata(contents);
        record.title = citation.title || record.title;
        record.summary = citation.summary;
      } else if (type === "REL") {
        const release = yamlMetadata(contents);
        if (typeof release.version === "string") record.title = `Release ${release.version}`;
        record.summary = [release.tag, release.released, release.yanked === true ? "Yanked" : undefined]
          .filter((value) => typeof value === "string")
          .join(" · ");
      } else if (type === "CHARTER") {
        record.summary = summaryParagraph(contents);
      } else if (["ADR", "TSK", "EXP", "ENV"].includes(type)) {
        const { metadata, body } = parseProseRecord(contents, record.path);
        if (typeof metadata.summary === "string") record.summary = metadata.summary;
        else record.summary = summaryParagraph(body);
        if (typeof metadata.status === "string") record.status = metadata.status;
      }
    } catch (error) {
      record.previewError = (error instanceof Error ? error.message : String(error)).slice(0, 2048);
    }
    record.title = record.title.slice(0, 512);
    record.summary = record.summary.slice(0, 512);
    record.status = record.status.slice(0, 128);
    cache.set(absolute, {
      stamp,
      title: record.title,
      summary: record.summary,
      status: record.status,
      ...(record.previewError ? { previewError: record.previewError } : {}),
    });
    records.push(record);
  };
  for (const project of projects) {
    const directory = rootOf(root, project);
    observe(join(directory, "workbench"));
    const charter = join(directory, "workbench/CHARTER.md");
    observe(charter);
    if (existsSync(charter)) add(root, charter, project.id, "CHARTER", "", false);
    for (const kind of kinds) {
      observe(join(directory, "workbench", detail(kind).directory));
      for (const file of scan(directory, kind)) add(root, file.path, project.id, kind, file.number, false);
    }
  }
  for (const collection of collections) {
    const base = collection.local ? join(collection.directory, "workbench") : collection.directory;
    observe(base);
    observe(join(base, "decisions"));
    const charter = join(base, "CHARTER.md");
    observe(charter);
    if (existsSync(charter))
      add(
        collection.local ? collection.directory : root,
        charter,
        collection.pin.id,
        "CHARTER",
        "",
        collection.local,
        true,
      );
    for (const file of scanRecordDirectory(base, "ADR"))
      add(
        collection.local ? collection.directory : root,
        file.path,
        collection.pin.id,
        "ADR",
        file.number,
        collection.local,
        true,
      );
  }
  for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
  return records;
}

export function findRecord(root: string, id: string): BrowserRecord {
  const record = workspaceRecords(root).find((record) => record.id === id);
  if (!record) throw new MissingResource("record not found");
  return record;
}

export function supportingFiles(record: BrowserRecord): { path: string; size: number }[] {
  if (record.type === "CHARTER") return [];
  const base = record.path.slice(0, -extname(record.path).length);
  const files: { path: string; size: number }[] = [];
  const walk = (path: string) => {
    const absolute = ownedPath(record.directory, path);
    if (!existsSync(absolute)) return;
    if (files.length >= 1000) throw new Error("supporting file list exceeds 1000 entries");
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) for (const name of readdirSync(absolute)) walk(`${path}/${name}`);
    else if (stat.isFile()) files.push({ path, size: stat.size });
    else throw new Error("unsupported supporting file");
  };
  walk(base);
  return files;
}

/** Compare again after acquiring the shared writer lock; never overwrite a stale browser draft. */
export function saveRecord(root: string, id: string, expected: string, contents: string): string {
  if (Buffer.byteLength(contents) > previewLimit) throw new InvalidInput("record exceeds the 2 MiB editing limit");
  const record = findRecord(root, id);
  if (!record.editable) throw new InvalidInput("only project-owned charters and ADRs are editable");
  const path = ownedPath(record.directory, record.path);
  return withCacheLockSync(
    resolve(root, reviewGit(root, ["rev-parse", "--git-path", "workbench/web-edit"]).trim()),
    () => {
      if (contentDigest(recordBytes(record)) !== expected)
        throw new StateConflict("file changed since this editor opened; your draft was not saved");
      writeAtomic(path, contents, lstatSync(path).mode & 0o777);
      return contentDigest(contents);
    },
    0,
  );
}

/** Creation is exclusively submitted human text; an existing or concurrently created charter is never replaced. */
export function createCharter(root: string, projectId: string, contents: string): string {
  if (!contents.trim()) throw new InvalidInput("write the charter's purpose and boundaries before saving");
  if (Buffer.byteLength(contents) > previewLimit) throw new InvalidInput("charter exceeds the 2 MiB editing limit");
  const project = selectProject(root, projectId);
  const path = ownedPath(rootOf(root, project), "workbench/CHARTER.md");
  return withCacheLockSync(
    resolve(root, reviewGit(root, ["rev-parse", "--git-path", "workbench/web-edit"]).trim()),
    () => {
      if (existsSync(path))
        throw new StateConflict("this charter was created meanwhile; open its current version instead");
      writeNew(path, contents);
      return `${project.id}:CHARTER`;
    },
    0,
  );
}
