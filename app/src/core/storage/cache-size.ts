import { existsSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { cacheSizeMarker as marker, cacheGenerationMarker as generationMarker } from "./cache-generation.mjs";
import {
  CacheBusy,
  CacheLockState,
  inspectCacheMetadataLock,
  recoverCacheMetadataLock,
  withCacheLocksSync,
} from "./cache-lock.js";
import { userDirectory } from "./storage.js";
export { invalidateCacheSize, withCacheSizeChanges } from "./cache-generation.mjs";
interface SizeRecord {
  version: 1;
  identity: string;
  generation: string;
  measurement?: { generation: string; bytes: number; at: string };
}
export interface CacheSize {
  directory: string;
  state: "pending" | "ready" | "stale" | "error";
  bytes?: number;
  measuredAt?: string;
  problem?: string;
}
const discovery = new AsyncLocalStorage<Map<string, CacheSize>>();
/** Serialize measurement writes with deletion, without owning the directory walk or recreating missing groups. */
export function withCacheMeasurementLocks<T>(directories: string[], action: () => T): T {
  const locks = [...new Set(directories.map((directory) => resolve(directory)))]
    .sort()
    .map((directory) =>
      join(userDirectory("cache"), "measurement-locks", createHash("sha256").update(directory).digest("hex")),
    );
  for (const directory of locks) {
    const previous = inspectCacheMetadataLock(directory);
    if (previous.state === CacheLockState.Uncertain)
      throw new Error(`Cache measurement lock ownership requires inspection: ${previous.path}`);
    if (previous.state === CacheLockState.Abandoned) recoverCacheMetadataLock(directory, { expected: previous.digest });
  }
  return withCacheLocksSync(locks, action, { mutable: false });
}
/** One I/O budget is shared by concurrent walks; directory admission does not multiply it. */
class SizeIO {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active >= 8)
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    else this.active++;
    try {
      return await action();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
const sizeIO = new SizeIO();
function sizeEntry(name: string): boolean {
  return (
    name !== marker &&
    name !== generationMarker &&
    !name.startsWith(`.${marker}.`) &&
    !name.startsWith(`.${generationMarker}.`)
  );
}
function identity(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${path}: expected a cache directory`);
  return JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs]);
}
function readSize(path: string): SizeRecord | undefined {
  try {
    const value: unknown = JSON.parse(readBoundedFile(join(path, marker), 4096, "cache size record").toString("utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("identity" in value) ||
      value.identity !== identity(path) ||
      !("generation" in value) ||
      typeof value.generation !== "string"
    )
      return;
    if ("measurement" in value && value.measurement !== undefined) {
      const m = value.measurement;
      if (
        !m ||
        typeof m !== "object" ||
        !("generation" in m) ||
        typeof m.generation !== "string" ||
        !("bytes" in m) ||
        typeof m.bytes !== "number" ||
        !Number.isSafeInteger(m.bytes) ||
        m.bytes < 0 ||
        !("at" in m) ||
        typeof m.at !== "string" ||
        !Number.isFinite(Date.parse(m.at))
      )
        return;
    }
    return value as SizeRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
    throw error;
  }
}
function generation(directory: string): string {
  const token = readBoundedFile(join(directory, generationMarker), 64, "cache size generation").toString("utf8").trim();
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error(`${directory}: invalid cache size generation`);
  return token;
}
/** Discover metadata without recursively walking cache contents. */
export function discoverCacheSizes<T>(action: () => T): { value: T; sizes: CacheSize[] } {
  const sizes = new Map<string, CacheSize>();
  const value = discovery.run(sizes, action);
  return { value, sizes: [...sizes.values()] };
}
/** Retain the same metadata-only discovery boundary across asynchronous inventory work. */
export async function discoverCacheSizesAsync<T>(action: () => Promise<T>): Promise<{ value: T; sizes: CacheSize[] }> {
  const sizes = new Map<string, CacheSize>();
  const value = await discovery.run(sizes, action);
  return { value, sizes: [...sizes.values()] };
}
export function savedSize(directory: string): CacheSize {
  let measurement: SizeRecord["measurement"];
  try {
    measurement = readSize(directory)?.measurement;
    return {
      directory,
      state: measurement ? (measurement.generation === generation(directory) ? "ready" : "stale") : "pending",
      ...(measurement ? { bytes: measurement.bytes, measuredAt: measurement.at } : {}),
    };
  } catch (error) {
    return {
      directory,
      state: "error",
      ...(measurement ? { bytes: measurement.bytes, measuredAt: measurement.at } : {}),
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}
/** Cooperative cancellation drains the current filesystem read without an elapsed deadline. */
export async function measureCacheSize(previous: CacheSize, force = false, signal?: AbortSignal): Promise<CacheSize> {
  signal?.throwIfAborted();
  if (!force && previous.state === "ready") return previous;
  const directory = previous.directory;
  const changed = new Error("Cache changed before size publication");
  try {
    const before = withCacheMeasurementLocks([directory], () => {
      try {
        writeFileSync(join(directory, generationMarker), "00000000-0000-0000-0000-000000000000\n", {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return { version: 1 as const, identity: identity(directory), generation: generation(directory) };
    });
    async function walk(path: string): Promise<number> {
      signal?.throwIfAborted();
      try {
        const stat = await sizeIO.run(async () => lstat(path));
        if (!stat.isDirectory()) return stat.size;
        let bytes = 0;
        let files: Promise<number>[] = [];
        const drain = async () => {
          const current = files;
          files = [];
          const results = await Promise.allSettled(current);
          for (const result of results) {
            if (result.status === "rejected") throw result.reason as unknown;
            bytes += result.value;
          }
        };
        try {
          for await (const entry of await sizeIO.run(async () => opendir(path))) {
            signal?.throwIfAborted();
            if (!sizeEntry(entry.name)) continue;
            if (entry.isDirectory()) bytes += await walk(join(path, entry.name));
            else {
              const measurement = walk(join(path, entry.name));
              // Attach rejection handling immediately; all admitted reads are drained on cancellation.
              void measurement.catch(() => undefined);
              files.push(measurement);
              if (files.length >= 8) await drain();
            }
          }
        } finally {
          await drain();
        }
        return bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
    }
    const bytes = await walk(directory);
    signal?.throwIfAborted();
    return withCacheMeasurementLocks([directory], () => {
      if (identity(directory) !== before.identity || generation(directory) !== before.generation)
        return { ...previous, state: "stale" };
      const at = new Date().toISOString();
      writeAtomic(
        join(directory, marker),
        JSON.stringify({ ...before, measurement: { generation: before.generation, bytes, at } }) + "\n",
        0o600,
        () => {
          if (identity(directory) !== before.identity || generation(directory) !== before.generation) throw changed;
        },
        { createParent: false },
      );
      return {
        directory,
        bytes,
        measuredAt: at,
        state:
          identity(directory) === before.identity && generation(directory) === before.generation ? "ready" : "stale",
      };
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error === changed) return { ...previous, state: "stale" };
    if (error instanceof CacheBusy && existsSync(directory))
      return { ...previous, state: previous.bytes === undefined ? "pending" : "stale" };
    return { ...previous, state: "error", problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Approximate file bytes without following links; disappearing build products contribute zero. */
function filesystemBytes(path: string): number {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory()
      ? readdirSync(path)
          .filter(sizeEntry)
          .reduce((total, name) => total + filesystemBytes(join(path, name)), 0)
      : metadata.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** Unknown measurements remain absent; consumers must never treat them as a measured zero. */
export function cachedAmount(directory: string): { bytes: number | undefined; measurement: CacheSize } {
  const sizes = discovery.getStore();
  const measurement = sizes?.get(directory) ?? savedSize(directory);
  sizes?.set(directory, measurement);
  return { bytes: measurement.bytes, measurement };
}
export function cacheAmount(directory: string): { bytes: number | undefined; measurement: CacheSize } {
  const sizes = discovery.getStore();
  let measurement = sizes?.get(directory);
  if (!measurement) {
    if (sizes) {
      measurement = savedSize(directory);
      sizes.set(directory, measurement);
    } else {
      try {
        measurement = {
          directory,
          state: "ready",
          bytes: filesystemBytes(directory),
        };
      } catch (error) {
        measurement = { directory, state: "error", problem: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  return { bytes: measurement.bytes, measurement };
}
export function cacheBytes(path: string): number | undefined {
  return cacheAmount(path).bytes;
}
