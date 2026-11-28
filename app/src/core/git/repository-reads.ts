import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { WeightedCache } from "../storage/weighted-cache.js";

interface CommitObject {
  oid: string;
  bytes: Buffer;
}

const observations = new AsyncLocalStorage<{
  locations: Map<string, string>;
  objects: WeightedCache<Buffer>;
}>();

export function withRepositoryReads<T>(action: () => T): T {
  if (observations.getStore()) return action();
  return observations.run({ locations: new Map(), objects: new WeightedCache(16 * 1024 * 1024) }, action);
}

function repositoryReadKey(root: string, query: string, env: NodeJS.ProcessEnv): string {
  const gitEnvironment = Object.keys(env)
    .filter((name) => name.startsWith("GIT_") || name === "PATH" || name === "Path")
    .sort()
    .map((name) => [name, env[name]]);
  return JSON.stringify([resolve(root), query, gitEnvironment]);
}

/** Reuse repository locations during an operation. Refs and files at those locations stay live. */
export function repositoryLocation(root: string, query: string, read: () => string, env = process.env): string {
  const current = observations.getStore()?.locations;
  if (!current) return read();
  const key = repositoryReadKey(root, query, env);
  const cached = current.get(key);
  if (cached !== undefined) return cached;
  const location = read();
  if (location) current.set(key, location);
  return location;
}

/** Only immutable commit object requests can reuse bytes within an operation. */
export function repositoryCommitObject(root: string, revision: string, read: () => CommitObject): CommitObject {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)) return read();
  const cache = repositoryObjects(root, "commit");
  const cached = cache?.get(revision);
  if (cached) return { oid: revision, bytes: Buffer.from(cached) };
  const object = read();
  if (object.oid === revision) cache?.set(revision, object.bytes);
  return object;
}

/** Reuse verified object bytes, keyed by full object ID and repository selection. */
export function repositoryObjects(root: string, type: "blob" | "commit") {
  const cache = observations.getStore()?.objects;
  if (!cache) return undefined;
  const prefix = repositoryReadKey(root, type, process.env);
  return {
    get(oid: string): Buffer | undefined {
      return cache.get(prefix + oid);
    },
    set(oid: string, bytes: Buffer): void {
      const key = prefix + oid;
      cache.set(key, Buffer.from(bytes), bytes.length + key.length * 2 + 128);
    },
  };
}
