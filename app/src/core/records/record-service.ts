import { recordInventory, readInventoryRecords, readArchiveFileAt, readArchiveIndex } from "./archive-store.js";
import { projectPaths } from "../projects/project-paths.js";
import { InvalidInput, MissingResource, StateConflict } from "../runtime/input-errors.js";
import { describeRecord, recordPresentations } from "./record-metadata.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { detail, kinds, type Kind } from "./record-identity.js";
import { readProjects, selectProject } from "../projects/project-configuration.js";
import { rootOf } from "../projects/project-context.js";
import { scanRecordDirectory } from "./record-files.js";
import { writeAtomic, writeNew } from "../runtime/file-publication.mjs";
import { resolveCollections, type ResolvedCollection } from "../collections/collections.js";
import { ownedFileBytes } from "../collections/collection-files.js";
import { ownedPath } from "../runtime/paths.js";
import { reviewGit } from "../review/review-service.js";
import { withCacheLockSync } from "../storage/cache-lock.js";

export const previewLimit = 2 * 1024 * 1024;
export interface BrowserRecord {
  id: string;
  type: Kind | "CHARTER";
  scope: string;
  title: string;
  summary: string;
  status: string;
  addedAt?: string;
  path: string;
  directory: string;
  editable: boolean;
  local: boolean;
  collection: boolean;
  archive?: { repository: string; revision: string; path: string };
  previewError?: string;
  adaptation?: "modified" | "added";
  citationPresence?: { present: number; total: number } | { error: string };
}
export const contentDigest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function recordBytes(record: Pick<BrowserRecord, "directory" | "path" | "archive">): Buffer {
  if (record.archive) {
    const body = readArchiveFileAt(
      record.archive.repository,
      record.archive.revision,
      record.archive.path,
      previewLimit,
    );
    if (!body) throw new MissingResource("Archived record is unavailable");
    return body;
  }
  return ownedFileBytes(record.directory, record.path, previewLimit);
}

interface CachedMetadata {
  stamp: string;
  title: string;
  summary: string;
  status: string;
  addedAt?: string;
  previewError?: string;
}
/** A disposable metadata index; authoritative document bytes remain on disk. */
export class RecordCatalog {
  private readonly metadata = new Map<string, CachedMetadata>();
  constructor(private readonly root: string) {}
  records(
    collections?: ResolvedCollection[],
    observe?: (path: string) => void,
    committedRecords?: ReadonlySet<string>,
    readContents?: (record: BrowserRecord) => string,
  ): BrowserRecord[] {
    return workspaceRecords(this.root, this.metadata, collections, observe, committedRecords, readContents);
  }
}

/** Browse drafts without requiring their metadata to be complete or valid. */
export function workspaceRecords(
  root: string,
  cache = new Map<string, CachedMetadata>(),
  collections = resolveCollections(root),
  observe: (path: string) => void = () => undefined,
  committedRecords?: ReadonlySet<string>,
  readContents: (record: BrowserRecord) => string = (record) => recordBytes(record).toString("utf8"),
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
    archived?: BrowserRecord["archive"],
    captured?: Buffer,
  ) => {
    const record: BrowserRecord = {
      id: `${scope}:${type}${number ? `-${number}` : ""}`,
      type,
      scope,
      title:
        type === "CHARTER"
          ? `${projects.find((project) => project.id === scope)?.name ?? scope} charter`
          : `${type}-${number}`,
      summary: "",
      status: "",
      path: relative(directory, path).replaceAll("\\", "/"),
      directory,
      editable: !local && !archived && recordPresentations[type].editable,
      ...(archived ? { archive: archived } : {}),
      local,
      collection,
    };
    const absolute = ownedPath(directory, record.path);
    seen.add(absolute);
    if (!archived) {
      observe(dirname(absolute));
      observe(absolute);
    }
    const info = archived ? undefined : lstatSync(absolute);
    const stamp = archived
      ? `archive:${archived.revision}:${archived.path}`
      : `${String(info?.ino)}:${String(info?.size)}:${String(info?.mtimeMs)}:${String(info?.ctimeMs)}:${record.title}`;
    const cached = cache.get(absolute);
    if (cached?.stamp === stamp) {
      records.push({
        ...record,
        title: cached.title,
        summary: cached.summary,
        status: cached.status,
        ...(cached.addedAt ? { addedAt: cached.addedAt } : {}),
        ...(cached.previewError ? { previewError: cached.previewError } : {}),
      });
      return;
    }
    try {
      const contents = captured?.toString("utf8") ?? readContents(record);
      describeRecord(record, contents);
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
      ...(record.addedAt ? { addedAt: record.addedAt } : {}),
      ...(record.previewError ? { previewError: record.previewError } : {}),
    });
    records.push(record);
  };
  for (const project of projects) {
    const directory = rootOf(root, project);
    observe(join(directory, "workbench"));
    observe(join(directory, projectPaths.state));
    const charter = join(directory, projectPaths.charter);
    observe(charter);
    if (existsSync(charter)) add(root, charter, project.id, "CHARTER", "", false);
    for (const kind of kinds) {
      observe(join(directory, "workbench", detail(kind).directory));
      const inventory = recordInventory(root, project.path, kind, committedRecords);
      const bodies = readInventoryRecords(
        root,
        inventory.filter((file) => file.archive !== undefined),
      );
      for (const file of inventory)
        add(
          root,
          file.path,
          project.id,
          kind,
          file.number,
          false,
          false,
          file.archive
            ? {
                repository: root,
                revision: file.archive.revision,
                path: relative(root, file.path).replaceAll("\\", "/"),
              }
            : undefined,
          bodies.get(file.path),
        );
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
    for (const file of scanRecordDirectory(base, "ADR", committedRecords))
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

export function supportingFiles(
  record: Pick<BrowserRecord, "type" | "path" | "directory" | "archive">,
  observe?: (path: string) => void,
): { path: string; size: number }[] {
  if (record.type === "CHARTER") return [];
  const base = record.path.slice(0, -extname(record.path).length);
  if (record.archive) {
    const archive = readArchiveIndex(record.archive.repository, record.archive.revision);
    const prefix = record.archive.path.slice(0, -extname(record.archive.path).length) + "/";
    const files = [...archive.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => ({ path, size: archive.sizes.get(path) ?? 0 }));
    if (files.length > 1000) throw new InvalidInput("supporting file list exceeds 1000 entries");
    return files;
  }
  const files: { path: string; size: number }[] = [];
  const walk = (path: string) => {
    const absolute = ownedPath(record.directory, path);
    observe?.(absolute);
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
  const path = ownedPath(rootOf(root, project), projectPaths.charter);
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
