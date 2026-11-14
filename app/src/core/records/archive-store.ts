import { WeightedCache } from "../storage/weighted-cache.js";
import {
  ArchiveUnavailable,
  archivedKinds,
  readArchiveTree,
  type ArchiveIndex,
  type ArchivedKind,
  type ArchivedRecord,
} from "./archive-index.js";
import { proseRecordErrors } from "./record-content.js";
import { recordDocument } from "./record-document.js";
import { readBoundedFile, hashFile } from "../runtime/file-reads.js";
import { join, posix, relative, resolve } from "node:path";
import { lstatSync } from "node:fs";
import { gitBytes, readGitObjects, type GitEntry } from "../git/git-snapshot.js";
import { readProjectState } from "../projects/project-state.js";
import { parse } from "smol-toml";
import { projectPaths } from "../projects/project-paths.js";
import { readConfig, readProjects } from "../projects/project-configuration.js";
import { rootOf } from "../projects/project-context.js";
import { record } from "../runtime/values.mjs";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { compareRecordNumbers, type Kind } from "./record-identity.js";
import { scan } from "./record-files.js";

const validatedIndexes = new WeakSet<ArchiveIndex>();
const validatedDocuments = new WeightedCache<boolean>(32 * 1024 * 1024);
const blobCache = new Map<string, Buffer>();
let cachedBytes = 0;
const blobCacheLimit = 32 * 1024 * 1024;
const recordBatchSize = 16;

function archiveRepository(root: string): string {
  return process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1" &&
    process.env.WORKBENCH_PROJECT_ROOT &&
    resolve(root) === resolve(process.env.WORKBENCH_PROJECT_ROOT) &&
    process.env.WORKBENCH_LOCAL_CONFIG_ROOT
    ? process.env.WORKBENCH_LOCAL_CONFIG_ROOT
    : root;
}

function prefetchBlobs(repository: string, ids: readonly string[]): void {
  const missing = [...new Set(ids)].filter((oid) => !blobCache.has(`${repository}:${oid}`));
  for (let offset = 0; offset < missing.length; offset += recordBatchSize) {
    for (const [oid, body] of readGitObjects(repository, missing.slice(offset, offset + recordBatchSize))) {
      if (!body)
        throw new ArchiveUnavailable(
          `Archive object ${oid} is unavailable locally; run 'workbench record archive fetch'.`,
        );
      const key = `${repository}:${oid}`;
      blobCache.set(key, body);
      cachedBytes += body.length;
      while (cachedBytes > blobCacheLimit) {
        const oldest = blobCache.entries().next().value;
        if (!oldest) break;
        cachedBytes -= oldest[1].length;
        blobCache.delete(oldest[0]);
      }
    }
  }
}

export function readArchiveFileAt(
  root: string,
  revision: string,
  path: string,
  maximum = 2 * 1024 * 1024,
): Buffer | undefined {
  const archive = readArchiveIndex(root, revision),
    entry = archive.files.get(path);
  if (!entry) return undefined;
  if ((archive.sizes.get(path) ?? Infinity) > maximum)
    throw new InvalidInput(`Archived file exceeds its byte limit: ${path}`);
  if (maximum <= 2 * 1024 * 1024) {
    prefetchBlobs(archive.repository, [entry.oid]);
    const key = `${archive.repository}:${entry.oid}`,
      cached = blobCache.get(key);
    if (cached) {
      blobCache.delete(key);
      blobCache.set(key, cached);
      return Buffer.from(cached);
    }
  }
  return readGitObjects(archive.repository, [entry.oid], maximum).get(entry.oid);
}

export function archiveRevision(root: string): string | undefined {
  const state = readProjectState(root);
  if (state.archive === undefined) return undefined;
  const archive = record(state.archive, "Invalid archive state");
  const revision = archive.revision;
  if (revision === undefined) return undefined;
  if (typeof revision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
    throw new InvalidInput("Invalid archive.revision in workbench/state.toml");
  return revision;
}

export function readArchiveIndex(root: string, revision: string): ArchiveIndex {
  root = archiveRepository(root);
  const result = readArchiveTree(root, revision);
  if (validatedIndexes.has(result)) return result;
  const validationKey = (item: ArchivedRecord) => `${resolve(root)}:${item.path}:${item.entry.oid}`;
  const records = result.records.filter((item) => !validatedDocuments.get(validationKey(item)));
  for (let offset = 0; offset < records.length; offset += recordBatchSize) {
    const chunk = records.slice(offset, offset + recordBatchSize),
      bodies = readGitObjects(
        root,
        chunk.map((item) => item.entry.oid),
      );
    for (const item of chunk) {
      const body = bodies.get(item.entry.oid);
      if (!body)
        throw new ArchiveUnavailable(
          `Missing archived record: ${item.path}. Run 'workbench record archive fetch' to acquire its objects.`,
        );
      const contents = body.toString(),
        issues = proseRecordErrors(item.kind, item.number, item.path, contents);
      const status = recordDocument(item.kind, contents, item.path).metadata.status;
      if (!(item.kind === "TSK" ? ["Accepted", "Canceled"] : ["Accepted", "Rejected", "Inconclusive"]).includes(status))
        issues.push(`${item.path}: only completed records may be archived`);
      if (issues.length) throw new InvalidInput(`Invalid archive record: ${issues.join("\n")}`);
      const key = validationKey(item);
      validatedDocuments.set(key, true, key.length * 2 + 128);
    }
  }
  validatedIndexes.add(result);
  return result;
}

export function projectArchive(root: string): ArchiveIndex | undefined {
  const revision = archiveRevision(root);
  if (!revision) return undefined;
  if (!readConfig(root).records?.archive_branch)
    throw new InvalidInput(
      "Archived records are still referenced. Use 'workbench record archive disable' to restore them before clearing archive configuration.",
    );
  return readArchiveIndex(root, revision);
}

/** Adoption validates the independent history once; ordinary reads inspect only the pinned tree. */
export function verifyArchiveHistory(root: string, tip: string): void {
  for (const revision of gitBytes(root, ["rev-list", tip]).toString().trim().split("\n"))
    readArchiveIndex(root, revision);
}

/** A Git snapshot retains the same record identities whether bytes are live or pinned in its archive. */
export function logicalRecordEntries(root: string, live: ReadonlyMap<string, GitEntry>): Map<string, GitEntry> {
  const result = new Map(live),
    state = live.get(projectPaths.state);
  if (!state) return result;
  const bytes = readGitObjects(root, [state.oid]).get(state.oid);
  if (!bytes) throw new InvalidInput("Missing committed project state");
  const revision = record(parse(bytes.toString()).archive ?? {}, "Invalid archive state").revision;
  if (revision === undefined) return result;
  if (typeof revision !== "string") throw new InvalidInput("Invalid archive revision");
  for (const [path, entry] of readArchiveIndex(root, revision).files) {
    const existing = result.get(path);
    if (existing && (existing.oid !== entry.oid || existing.mode !== entry.mode))
      throw new StateConflict(`Live and archived contents differ: ${path}`);
    result.set(path, entry);
  }
  return result;
}

export function readArchivedFile(root: string, path: string, maximum = 2 * 1024 * 1024): Buffer | undefined {
  const archive = projectArchive(root);
  return archive ? readArchiveFileAt(root, archive.revision, path.split("\\").join("/"), maximum) : undefined;
}

export interface InventoryRecord {
  number: string;
  path: string;
  archive?: { revision: string; entry: GitEntry };
}

function verifyLiveCopy(path: string, entry: GitEntry, maximum: number): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  const oid = hashFile(path, maximum, "record copy", {
    algorithm: entry.oid.length === 64 ? "sha256" : "sha1",
    prefix: (size) => `blob ${String(size)}\0`,
  });
  const mode = process.platform === "win32" ? entry.mode : stat.mode & 0o111 ? "100755" : "100644";
  if (oid !== entry.oid || mode !== entry.mode)
    throw new StateConflict(`Live and archived contents differ: ${path}. Restore or reconcile the record explicitly.`);
}

export function readProjectRecordFile(root: string, path: string, maximum = 2 * 1024 * 1024): Buffer {
  const key = relative(root, path).split("\\").join("/"),
    archive = projectArchive(root),
    entry = archive?.files.get(key);
  if (entry && archive) {
    verifyLiveCopy(path, entry, maximum);
    const body = readArchiveFileAt(root, archive.revision, key, maximum);
    if (body) return body;
  }
  return readBoundedFile(path, maximum, "record file");
}

export function projectRecordFileExists(root: string, path: string): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return (
    info?.isFile() === true || projectArchive(root)?.files.has(relative(root, path).split("\\").join("/")) === true
  );
}

export function recordInventory(
  root: string,
  scopePath: string,
  kind: Kind,
  committedRecords?: ReadonlySet<string>,
): InventoryRecord[] {
  const directory = scopePath === "." ? root : join(root, scopePath);
  const live = scan(directory, kind, committedRecords);
  if (!archivedKinds.includes(kind as ArchivedKind)) return live;
  const archive = projectArchive(root);
  if (!archive) return live;
  const byNumber = new Map(live.map((item) => [item.number, item]));
  const archived = archive.records.filter((item) => item.scopePath === scopePath && item.kind === kind);
  const archivedNumbers = new Set(archived.map((item) => item.number));
  const result: InventoryRecord[] = live.filter((item) => !archivedNumbers.has(item.number));
  for (const item of archived) {
    const existing = byNumber.get(item.number);
    if (existing) {
      verifyLiveCopy(existing.path, item.entry, 2 * 1024 * 1024);
      for (const [path, entry] of archive.files)
        if (path.startsWith(item.path.slice(0, -3) + "/"))
          verifyLiveCopy(join(root, path), entry, Number.MAX_SAFE_INTEGER);
    }
    result.push({
      number: item.number,
      path: join(root, item.path),
      archive: { revision: archive.revision, entry: item.entry },
    });
  }
  return result.sort((a, b) => compareRecordNumbers(a.number, b.number));
}

export function readInventoryRecords(root: string, items: readonly InventoryRecord[]): Map<string, Buffer> {
  const repository = archiveRepository(root);
  const result = new Map<string, Buffer>();
  for (let offset = 0; offset < items.length; offset += recordBatchSize) {
    const chunk = items.slice(offset, offset + recordBatchSize);
    prefetchBlobs(
      repository,
      chunk.flatMap((item) => (item.archive ? [item.archive.entry.oid] : [])),
    );
    for (const item of chunk) {
      const body = item.archive
        ? readArchiveFileAt(root, item.archive.revision, relative(root, item.path).split("\\").join("/"))
        : readBoundedFile(item.path, 2 * 1024 * 1024, "record");
      if (!body) throw new InvalidInput(`Missing record: ${relative(root, item.path)}`);
      result.set(item.path, body);
    }
  }
  return result;
}

export function archivedScopeRecords(root: string): ArchivedRecord[] {
  const archive = projectArchive(root);
  if (!archive) return [];
  const scopes = new Set(
    readProjects(root).map((project) => posix.normalize(relative(root, rootOf(root, project)).split("\\").join("/"))),
  );
  for (const item of archive.records)
    if (!scopes.has(item.scopePath)) throw new InvalidInput(`Archived scope is not registered: ${item.scopePath}`);
  return [...archive.records];
}
