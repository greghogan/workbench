import type { CacheSize } from "../cache-size.js";
export const CacheSizeState = {
  Pending: "pending",
  Ready: "ready",
  Stale: "stale",
  Blocked: "blocked",
  Error: "error",
} as const;
export function decodeCacheSize(input: unknown, options: { currentRead?: true } = {}): CacheSize {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid cache size");
  const data = input as Record<string, unknown>;
  if (
    typeof data.directory !== "string" ||
    typeof data.state !== "string" ||
    !Object.values(CacheSizeState).some((state) => state === data.state) ||
    (data.bytes !== undefined &&
      (typeof data.bytes !== "number" || !Number.isSafeInteger(data.bytes) || data.bytes < 0)) ||
    (data.measuredAt !== undefined &&
      (typeof data.measuredAt !== "string" || !Number.isFinite(Date.parse(data.measuredAt)))) ||
    (data.problem !== undefined && typeof data.problem !== "string") ||
    (data.state === CacheSizeState.Ready &&
      (data.bytes === undefined || (!options.currentRead && data.measuredAt === undefined)))
  )
    throw new Error("Invalid cache size");
  return data as unknown as CacheSize;
}
