import { AsyncLocalStorage } from "node:async_hooks";
import { WeightedCache } from "../storage/weighted-cache.js";
import { readText } from "../runtime/files.js";

const observations = new AsyncLocalStorage<WeightedCache<unknown>>();

/** Structural validation is read-only and owns the lifetime of this inventory. */
export function withRecordObservation<T>(validate: () => T): T {
  return observations.run(new WeightedCache(32 * 1024 * 1024), validate);
}

export function observeRecord<T>(key: string, read: () => T, size: (value: T) => number): T {
  const observation = observations.getStore();
  if (!observation) return read();
  const cached = observation.get(key) as { value: T } | undefined;
  if (cached) return cached.value;
  const value = read();
  observation.set(key, { value }, size(value) + key.length * 2 + 128);
  return value;
}

export function observeRecordBytes(path: string, read: () => Buffer): Buffer {
  return observeRecord(`bytes:${path}`, read, (bytes) => bytes.byteLength);
}

export function readObservedRecordText(path: string): string {
  const cached = observations.getStore()?.get(`bytes:${path}`) as { value: Buffer } | undefined;
  return cached ? cached.value.toString() : readText(path);
}
