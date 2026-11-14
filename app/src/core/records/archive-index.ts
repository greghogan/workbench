import { WeightedCache } from "../storage/weighted-cache.js";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gitBytes, type GitEntry } from "../git/git-snapshot.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { compareRecordNumbers, normalizedNumber, relativeRecordPath } from "./record-identity.js";
export class ArchiveUnavailable extends StateConflict {}

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
  repository: string;
  revision: string;
  files: ReadonlyMap<string, GitEntry>;
  sizes: ReadonlyMap<string, number>;
  records: readonly ArchivedRecord[];
}
const indexes = new WeightedCache<ArchiveIndex>(32 * 1024 * 1024);
export function readArchiveTree(root: string, revision: string): ArchiveIndex {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new InvalidInput("Invalid archive revision");
  const key = resolve(root) + ":" + revision;
  const cached = indexes.get(key);
  if (cached) return cached;
  const offline = spawnSync("git", ["-C", root, "--no-lazy-fetch", "rev-parse", "--git-dir"], { encoding: "utf8" });
  if (offline.error || offline.status !== 0)
    throw new InvalidInput("Record archives require Git 2.45 or newer for offline object access");
  const available = spawnSync("git", ["-C", root, "cat-file", "-t", revision], {
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
  if (available.error || available.status !== 0 || available.stdout.trim() !== "commit")
    throw new ArchiveUnavailable(
      `Archive ${revision} is unavailable locally. Fetch the configured archive branch and its required history with 'workbench record archive fetch'.`,
    );
  const files = new Map<string, GitEntry>();
  const sizes = new Map<string, number>();
  const records: ArchivedRecord[] = [];
  const identities = new Set<string>();
  for (const row of gitBytes(root, ["ls-tree", "-r", "-l", "-z", revision]).toString().split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t");
    const [mode, type, oid, sizeText] = row.slice(0, tab).trim().split(/\s+/);
    const size = Number(sizeText);
    const path = row.slice(tab + 1);
    if (type === "blob" && !Number.isSafeInteger(size))
      throw new ArchiveUnavailable(
        `Archive objects are unavailable locally: ${path}. Run 'workbench record archive fetch'.`,
      );
    if (
      tab < 0 ||
      !mode ||
      !oid ||
      type !== "blob" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !["100644", "100755"].includes(mode) ||
      /[\0\r\n\\]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
    )
      throw new InvalidInput(`Unsafe archive entry: ${path}`);
    const match = /^(?:(.+)\/)?workbench\/(tasks|experiments)\/(.*)$/.exec(path);
    if (!match?.[2] || !match[3]) throw new InvalidInput(`Archive contains a non-record file: ${path}`);
    files.set(path, { mode, oid });
    sizes.set(path, size);
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
  const result = { repository: root, revision, files, sizes, records };
  indexes.set(
    key,
    result,
    [...files.keys()].reduce((size, path) => size + path.length * 4 + 512, 1),
  );
  return result;
}
