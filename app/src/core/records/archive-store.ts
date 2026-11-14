import { WeightedCache } from "../storage/weighted-cache.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { join, posix, relative } from "node:path";
import { lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { gitBytes, readGitObjects, type GitEntry } from "../git/git-snapshot.js";
import { readProjectState } from "../projects/project-state.js";
import { readConfig, readProjects } from "../projects/project-configuration.js";
import { rootOf } from "../projects/project-context.js";
import { record } from "../runtime/values.mjs";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { compareRecordNumbers, normalizedNumber, relativeRecordPath, type Kind } from "./record-identity.js";
import { scan } from "./record-files.js";

export const archivedKinds = ["TSK", "EXP"] as const;
export type ArchivedKind = (typeof archivedKinds)[number];
export interface ArchivedRecord {
  scopePath: string;
  kind: ArchivedKind;
  number: string;
  path: string;
  entry: GitEntry;
}
export interface ArchiveIndex {
  revision: string;
  files: ReadonlyMap<string, GitEntry>;
  records: readonly ArchivedRecord[];
}
const indexes = new WeightedCache<ArchiveIndex>(32 * 1024 * 1024);

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
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new InvalidInput("Invalid archive revision");
  const available = spawnSync("git", ["-C", root, "cat-file", "-t", revision], { encoding: "utf8" });
  if (available.error || available.status !== 0 || available.stdout.trim() !== "commit")
    throw new InvalidInput(
      `Archive ${revision} is unavailable locally. Fetch the configured archive branch and its required history with 'workbench record archive fetch'.`,
    );
  const repository = gitBytes(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
  const key = repository + ":" + revision;
  const cached = indexes.get(key);
  if (cached) return cached;
  const files = new Map<string, GitEntry>();
  const records: ArchivedRecord[] = [];
  const identities = new Set<string>();
  for (const row of gitBytes(root, ["ls-tree", "-r", "-z", revision]).toString().split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t");
    const [mode, type, oid] = row.slice(0, tab).split(" ");
    const path = row.slice(tab + 1);
    if (
      tab < 0 ||
      !mode ||
      !oid ||
      type !== "blob" ||
      !["100644", "100755"].includes(mode) ||
      /[\0\r\n\\]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
    )
      throw new InvalidInput(`Unsafe archive entry: ${path}`);
    const match = /^(?:(.+)\/)?workbench\/(tasks|experiments)\/(.*)$/.exec(path);
    if (!match?.[2] || !match[3]) throw new InvalidInput(`Archive contains a non-record file: ${path}`);
    files.set(path, { mode, oid });
    const name = /^(?:[0-9A-Z]{2}\/)*(TSK|EXP)-([0-9A-Z]+)\.md$/.exec(match[3]);
    if (!name?.[1] || !name[2]) continue;
    const kind = name[1] as ArchivedKind;
    const number = normalizedNumber(name[2]);
    if (`${match[2]}/${match[3]}` !== relativeRecordPath(kind, number).split("\\").join("/"))
      throw new InvalidInput(`Noncanonical archived record: ${path}`);
    const scopePath = match[1] ?? ".";
    const identity = `${scopePath}:${kind}-${number}`;
    if (identities.has(identity)) throw new InvalidInput(`Duplicate archived record: ${identity}`);
    identities.add(identity);
    records.push({ scopePath, kind, number, path, entry: { mode, oid } });
  }
  const recordPaths = new Set(records.map((item) => item.path));
  const owners = new Set(records.map((item) => item.path.slice(0, -3)));
  for (const path of files.keys()) {
    if (recordPaths.has(path)) continue;
    const parts = path.split("/");
    if (!parts.some((_, i) => owners.has(parts.slice(0, i + 1).join("/"))))
      throw new InvalidInput(`Archived supporting file has no owner: ${path}`);
  }
  records.sort(
    (a, b) =>
      a.scopePath.localeCompare(b.scopePath) ||
      a.kind.localeCompare(b.kind) ||
      compareRecordNumbers(a.number, b.number),
  );
  const result = { revision, files, records };
  indexes.set(
    key,
    result,
    [...files.keys()].reduce((size, path) => size + path.length * 4 + 512, 1),
  );
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

export function readArchivedFile(root: string, path: string, maximum = 2 * 1024 * 1024): Buffer | undefined {
  const entry = projectArchive(root)?.files.get(path.split("\\").join("/"));
  return entry ? readGitObjects(root, [entry.oid], maximum).get(entry.oid) : undefined;
}

export interface InventoryRecord {
  number: string;
  path: string;
  archive?: { revision: string; entry: GitEntry };
}

export function recordInventory(root: string, scopePath: string, kind: Kind): InventoryRecord[] {
  const directory = scopePath === "." ? root : join(root, scopePath);
  const live = scan(directory, kind);
  if (!archivedKinds.includes(kind as ArchivedKind)) return live;
  const archive = projectArchive(root);
  if (!archive) return live;
  const result: InventoryRecord[] = [...live];
  const byNumber = new Map(live.map((item) => [item.number, item]));
  const archived = archive.records.filter((item) => item.scopePath === scopePath && item.kind === kind);
  const duplicates = archived.filter((item) => byNumber.has(item.number));
  const bytes = readGitObjects(
    root,
    duplicates.map((item) => item.entry.oid),
  );
  for (const item of archived) {
    const existing = byNumber.get(item.number);
    if (existing) {
      const stat = lstatSync(existing.path);
      const mode = process.platform === "win32" ? item.entry.mode : stat.mode & 0o111 ? "100755" : "100644";
      if (
        mode !== item.entry.mode ||
        !readBoundedFile(existing.path, 2 * 1024 * 1024, "record").equals(bytes.get(item.entry.oid) ?? Buffer.alloc(0))
      )
        throw new StateConflict(
          `Live and archived contents differ: ${item.path}. Restore or reconcile the record explicitly.`,
        );
    } else
      result.push({
        number: item.number,
        path: join(root, item.path),
        archive: { revision: archive.revision, entry: item.entry },
      });
  }
  return result.sort((a, b) => compareRecordNumbers(a.number, b.number));
}

export function readInventoryRecords(root: string, items: readonly InventoryRecord[]): Map<string, Buffer> {
  const objects = readGitObjects(
    root,
    items.flatMap((item) => (item.archive ? [item.archive.entry.oid] : [])),
  );
  return new Map(
    items.map((item) => {
      const body = item.archive
        ? objects.get(item.archive.entry.oid)
        : readBoundedFile(item.path, 2 * 1024 * 1024, "record");
      if (!body) throw new InvalidInput(`Missing record: ${relative(root, item.path)}`);
      if (body.length > 2 * 1024 * 1024) throw new InvalidInput(`Record exceeds 2 MiB: ${item.path}`);
      return [item.path, body];
    }),
  );
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
