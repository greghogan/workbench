import { lstatSync, readdirSync, writeFileSync } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { readBoundedFile } from "./file-reads.js";
import { cacheSizeMarker as marker, cacheGenerationMarker as generationMarker } from "../scripts/cache-generation.mjs";
export { invalidateCacheSize, withCacheSizeChanges } from "../scripts/cache-generation.mjs";
interface SizeRecord {
  version: 1;
  identity: string;
  generation: string;
  measurement?: { generation: string; bytes: number; at: string };
}
export interface CacheSize {
  directory: string;
  state: "pending" | "ready" | "stale" | "blocked" | "error";
  bytes?: number;
  measuredAt?: string;
  problem?: string;
}
const discovery = new AsyncLocalStorage<Map<string, CacheSize>>();
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
function savedSize(directory: string): CacheSize {
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
  try {
    try {
      writeFileSync(join(directory, generationMarker), "00000000-0000-0000-0000-000000000000\n", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const before = { version: 1 as const, identity: identity(directory), generation: generation(directory) };
    async function walk(path: string): Promise<number> {
      signal?.throwIfAborted();
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory()) return stat.size;
        let bytes = 0;
        for await (const entry of await opendir(path)) {
          signal?.throwIfAborted();
          if (
            entry.name === marker ||
            entry.name === generationMarker ||
            entry.name.startsWith(`.${marker}.`) ||
            entry.name.startsWith(`.${generationMarker}.`)
          )
            continue;
          bytes += await walk(join(path, entry.name));
        }
        return bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
    }
    const bytes = await walk(directory);
    signal?.throwIfAborted();
    if (identity(directory) !== before.identity || generation(directory) !== before.generation)
      return { ...previous, state: "stale" };
    const at = new Date().toISOString();
    writeAtomic(
      join(directory, marker),
      JSON.stringify({ ...before, measurement: { generation: before.generation, bytes, at } }) + "\n",
      0o600,
    );
    return { directory, bytes, measuredAt: at, state: generation(directory) === before.generation ? "ready" : "stale" };
  } catch (error) {
    signal?.throwIfAborted();
    return { ...previous, state: "error", problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Approximate file bytes without following links; disappearing build products contribute zero. */
function filesystemBytes(path: string): number {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory()
      ? readdirSync(path)
          .filter(
            (name) =>
              name !== marker &&
              name !== generationMarker &&
              !name.startsWith(`.${marker}.`) &&
              !name.startsWith(`.${generationMarker}.`),
          )
          .reduce((total, name) => total + filesystemBytes(join(path, name)), 0)
      : metadata.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** Unknown measurements remain absent; consumers must never treat them as a measured zero. */
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
