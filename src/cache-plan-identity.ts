import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { cacheGenerationMarker } from "../scripts/cache-generation.mjs";
import { readBoundedFile } from "./file-reads.js";
/** Measurement sidecars do not change deletion identity; replacement and writer generations do. */
export function cacheDeletionIdentity(directory: string): unknown {
  if (!existsSync(directory)) return null;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${directory}: invalid cache directory`);
  const marker = join(directory, cacheGenerationMarker);
  return [
    stat.dev,
    stat.ino,
    stat.birthtimeMs,
    existsSync(marker)
      ? readBoundedFile(marker, 64, "cache generation").toString("utf8").trim()
      : "00000000-0000-0000-0000-000000000000",
  ];
}
export function withoutMeasurement<T extends { bytes?: number | undefined }>(
  entry: T,
): Omit<T, "bytes" | "measurement"> {
  const identity = { ...entry } as T & { measurement?: unknown };
  Reflect.deleteProperty(identity, "bytes");
  Reflect.deleteProperty(identity, "measurement");
  return identity;
}

export function cacheGenerationIdentity(directory: string): string {
  return createHash("sha256")
    .update(JSON.stringify(cacheDeletionIdentity(directory)))
    .digest("hex");
}
