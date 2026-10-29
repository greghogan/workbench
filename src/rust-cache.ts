import { readBoundedFileAsync } from "./file-reads.js";
import { createHash } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, posix } from "node:path";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { isRecord } from "../scripts/values.mjs";
import { ownedPath } from "./paths.js";
import { assertBuildUnused, readBuildGeneration, withBuildLock } from "./builds.js";
import { CacheBusy, withCacheLocksSync } from "./cache-lock.js";
import { withCacheSizeChanges } from "./cache-size.js";
import { keptCacheAssets } from "./project-registry.js";
import type { ResultToolReference } from "./tool-references.js";
import { settleCleanup } from "./diagnostics.js";

const usageFile = ".workbench-rust-usage.json";
const entryLimit = 500_000;
const metadataLimit = 16 * 1024 * 1024;
export const RustArtifactKind = { Build: "build", Incremental: "incremental" } as const;
type ArtifactKind = (typeof RustArtifactKind)[keyof typeof RustArtifactKind];
export interface RustCachePolicy {
  maxBytes: number;
  maxAgeDays: number;
}
interface Usage {
  stamp: string;
  lastUsed: number;
}
interface TreeEntry {
  path: string;
  stat: Stats;
  children: TreeEntry[];
  bytes: number;
  activity: number;
  stamp: string;
  safe: boolean;
}
export interface RustArtifactGroup {
  id: string;
  kind: ArtifactKind;
  paths: string[];
  bytes: number;
  lastUsed: number;
  protected: boolean;
}
export interface RustCachePlan {
  directory: string;
  digest: string;
  bytes: number;
  groups: RustArtifactGroup[];
  selected: RustArtifactGroup[];
  remainingBytes: number;
}
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const identity = (stat: Stats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Inspect metadata once. Unknown/symlinked outputs contribute size but never become deletion candidates. */
async function scan(
  directory: string,
  signal?: AbortSignal,
): Promise<{ root: TreeEntry; entries: Map<string, TreeEntry> }> {
  const entries = new Map<string, TreeEntry>();
  let visited = 0;
  const visit = async (path: string, depth: number): Promise<TreeEntry> => {
    signal?.throwIfAborted();
    if (++visited > entryLimit || depth > 64) throw new Error("Rust cache exceeds safe inspection bounds");
    const stat = await lstat(join(directory, path));
    const children: TreeEntry[] = [];
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of (await readdir(join(directory, path))).sort())
        if (path || name !== usageFile) children.push(await visit(path ? path + "/" + name : name, depth + 1));
    }
    const safe =
      (stat.isFile() || stat.isDirectory()) && !stat.isSymbolicLink() && children.every((child) => child.safe);
    const bytes = stat.isDirectory() ? children.reduce((total, child) => total + child.bytes, 0) : stat.size;
    const activity = stat.isFile()
      ? Math.max(stat.atimeMs, stat.mtimeMs)
      : children.reduce((latest, child) => Math.max(latest, child.activity), 0);
    const entry = {
      path,
      stat,
      children,
      bytes,
      activity,
      stamp: hash(identity(stat) + children.map((child) => "\n" + child.path + ":" + child.stamp).join("")),
      safe,
    };
    entries.set(path, entry);
    return entry;
  };
  const root = await visit("", 0);
  if (!root.stat.isDirectory() || root.stat.isSymbolicLink())
    throw new Error("Rust output must be a real owned directory");
  return { root, entries };
}

async function readUsage(directory: string): Promise<Map<string, Usage>> {
  const path = ownedPath(directory, usageFile);
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (missing(error)) return new Map();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > metadataLimit)
    throw new Error("Invalid Rust cache usage metadata");
  const value: unknown = JSON.parse(
    (await readBoundedFileAsync(path, metadataLimit, "Rust cache usage metadata")).toString("utf8"),
  );
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.groups))
    throw new Error("Invalid Rust cache usage metadata");
  const groups = new Map<string, Usage>();
  for (const [id, entry] of Object.entries(value.groups)) {
    if (
      !isRecord(entry) ||
      typeof entry.stamp !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.stamp) ||
      typeof entry.lastUsed !== "number" ||
      !Number.isFinite(entry.lastUsed) ||
      entry.lastUsed < 0
    )
      throw new Error("Invalid Rust cache usage metadata");
    groups.set(id, { stamp: entry.stamp, lastUsed: entry.lastUsed });
  }
  return groups;
}

/** Select whole fingerprint groups and completed incremental sessions, preserving unrecognized Cargo layouts. */
async function inspect(directory: string, policy: RustCachePolicy, now: number, signal?: AbortSignal) {
  for (const value of [policy.maxBytes, policy.maxAgeDays])
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Rust cache limits must be nonnegative integers");
  if (!Number.isFinite(now) || now < 0) throw new Error("Invalid Rust cache observation time");
  const previous = await readUsage(directory);
  const { root, entries } = await scan(directory, signal);
  const groups: RustArtifactGroup[] = [];
  const usage = new Map<string, Usage>();
  const nodes = new Map<string, TreeEntry[]>();
  const add = (id: string, kind: ArtifactKind, items: TreeEntry[]): RustArtifactGroup => {
    const stamp = hash(items.map((entry) => entry.path + ":" + entry.stamp).join("\n"));
    const old = previous.get(id);
    const activity = items.reduce((latest, entry) => Math.max(latest, entry.activity), 0);
    const lastUsed = Math.max(activity, old?.lastUsed ?? 0, old && old.stamp !== stamp ? now : 0);
    usage.set(id, { stamp, lastUsed });
    const group = {
      id,
      kind,
      paths: items.map((entry) => entry.path),
      bytes: items.reduce((sum, entry) => sum + entry.bytes, 0),
      lastUsed,
      protected: !items.every((entry) => entry.safe) || lastUsed > now,
    };
    groups.push(group);
    nodes.set(id, items);
    return group;
  };
  const expired = (group: RustArtifactGroup) =>
    policy.maxAgeDays > 0 && now - group.lastUsed >= policy.maxAgeDays * 86_400_000;
  for (const fingerprint of entries.values()) {
    if (
      posix.basename(fingerprint.path) !== ".fingerprint" ||
      !fingerprint.stat.isDirectory() ||
      ![2, 3].includes(fingerprint.path.split("/").length)
    )
      continue;
    const profile = posix.dirname(fingerprint.path);
    const byHash = new Map<string, TreeEntry[]>();
    for (const entry of fingerprint.children) {
      const match = /-([a-f0-9]{16})$/.exec(posix.basename(entry.path));
      const key = match?.[1];
      if (key && entry.stat.isDirectory()) byHash.set(key, [...(byHash.get(key) ?? []), entry]);
    }
    for (const parent of [profile, profile + "/deps", profile + "/build", profile + "/native"])
      for (const entry of entries.get(parent)?.children ?? []) {
        const key = /-([a-f0-9]{16})(?:\..*)?$/.exec(posix.basename(entry.path))?.[1];
        if (key && byHash.has(key)) byHash.get(key)?.push(entry);
      }
    for (const [key, items] of byHash) {
      if (items.filter((entry) => posix.dirname(entry.path) === fingerprint.path).length !== 1) continue;
      items.sort(
        (a, b) =>
          Number(posix.dirname(a.path) === fingerprint.path) - Number(posix.dirname(b.path) === fingerprint.path),
      );
      add(profile + "/" + key, RustArtifactKind.Build, items);
    }
    for (const unit of entries.get(profile + "/incremental")?.children ?? []) {
      if (!unit.stat.isDirectory() || unit.stat.isSymbolicLink()) continue;
      if (unit.children.some((entry) => posix.basename(entry.path).endsWith("-working"))) continue;
      const sessions: RustArtifactGroup[] = [];
      const claims = new Map<string, number>();
      for (const entry of unit.children) {
        const name = posix.basename(entry.path);
        if (!entry.stat.isDirectory() || !/^s-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/.test(name) || name.endsWith("-working"))
          continue;
        const lock = entries.get(unit.path + "/" + name.split("-").slice(0, 3).join("-") + ".lock");
        const items = [entry, ...(lock ? [lock] : [])];
        const group = add(entry.path, RustArtifactKind.Incremental, items);
        if (lock && (!lock.stat.isFile() || lock.stat.size !== 0)) group.protected = true;
        sessions.push(group);
        for (const item of items) claims.set(item.path, (claims.get(item.path) ?? 0) + 1);
      }
      for (const group of sessions) if (group.paths.some((path) => (claims.get(path) ?? 0) > 1)) group.protected = true;
      sessions.sort((a, b) => b.lastUsed - a.lastUsed || b.id.localeCompare(a.id));
      const newest = sessions[0];
      if (newest && !expired(newest)) newest.protected = true;
    }
  }
  const oldest = groups
    .filter((group) => !group.protected)
    .sort((a, b) => a.lastUsed - b.lastUsed || a.id.localeCompare(b.id));
  const selected = oldest.filter(expired);
  let remainingBytes = root.bytes - selected.reduce((sum, group) => sum + group.bytes, 0);
  const chosen = new Set(selected.map((group) => group.id));
  if (policy.maxBytes > 0)
    for (const group of oldest) {
      if (remainingBytes <= policy.maxBytes) break;
      if (!chosen.has(group.id)) {
        selected.push(group);
        chosen.add(group.id);
        remainingBytes -= group.bytes;
      }
    }
  return {
    plan: {
      directory,
      digest: hash(
        root.stamp +
          JSON.stringify(policy) +
          JSON.stringify([...previous]) +
          JSON.stringify(selected.map((group) => group.id)),
      ),
      bytes: root.bytes,
      groups,
      selected,
      remainingBytes,
    } satisfies RustCachePlan,
    usage,
    nodes,
  };
}

export async function inspectRustCache(
  directory: string,
  policy: RustCachePolicy,
  now = Date.now(),
): Promise<RustCachePlan> {
  return (await inspect(directory, policy, now)).plan;
}

async function unchanged(directory: string, entry: TreeEntry, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const path = ownedPath(directory, entry.path);
  if (identity(await lstat(path)) !== identity(entry.stat))
    throw new Error("Rust cache changed during cleanup selection");
  for (const child of entry.children) await unchanged(directory, child, signal);
}

/** Only marked Workbench output is eligible; the shared build lock excludes checks and session admission. */
export async function pruneRustCache(
  reference: ResultToolReference,
  policy: RustCachePolicy,
  options: { apply?: boolean; now?: number; validate?: () => void; expected?: string; signal?: AbortSignal } = {},
): Promise<RustCachePlan> {
  if (reference.kind !== "builds" || !reference.tools.some((tool) => tool.tool === "rust"))
    throw new Error("Expected an owned Rust build generation");
  return withBuildLock({ identity: reference.identity }, async () => {
    assertBuildUnused(reference.identity);
    return withCacheLocksSync(
      [reference.directory],
      async () => {
        const validate = () => {
          options.signal?.throwIfAborted();
          readBuildGeneration(reference.storageRoot, reference.directory, "builds", reference.identity);
          if (keptCacheAssets().has(reference.directory))
            throw new CacheBusy("Rust build generation is explicitly retained");
          options.validate?.();
        };
        validate();
        const directory = ownedPath(reference.directory, "cargo");
        const { plan, usage, nodes } = await inspect(directory, policy, options.now ?? Date.now(), options.signal);
        if (options.expected && options.expected !== plan.digest)
          throw new Error("Rust cache changed; inspect a fresh cleanup preview");
        if (!options.apply) return plan;
        validate();
        for (const group of plan.selected)
          for (const entry of nodes.get(group.id) ?? []) await unchanged(directory, entry, options.signal);
        return withCacheSizeChanges([reference.directory, directory], async () => {
          let failure: unknown;
          try {
            for (const group of plan.selected) {
              options.signal?.throwIfAborted();
              for (const path of group.paths) await rm(ownedPath(directory, path), { recursive: true });
              usage.delete(group.id);
            }
          } catch (error) {
            failure = error;
            throw error;
          } finally {
            await settleCleanup(
              [
                () => {
                  const contents = JSON.stringify({ version: 1, groups: Object.fromEntries(usage) }) + "\n";
                  if (Buffer.byteLength(contents) > metadataLimit)
                    throw new Error("Rust cache usage metadata exceeds its size bound");
                  writeAtomic(ownedPath(directory, usageFile), contents);
                },
              ],
              failure,
            );
          }
          return plan;
        });
      },
      { mutable: false },
    );
  });
}
