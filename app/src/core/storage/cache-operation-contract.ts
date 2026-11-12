import type { CacheSize } from "./cache-size.js";

export interface CacheOperation {
  directory: string;
  location: "operation" | "unowned";
  target?: string;
  action: "install" | "delete" | "unknown";
  state: "pending" | "active" | "uncertain";
  digest: string;
  problem?: string;
  bytes?: number | undefined;
  measurement?: CacheSize;
}
export function cacheOperations(report: {
  operations?: CacheOperation[];
  tools?: { operations?: CacheOperation[] };
}): CacheOperation[] {
  return [...(report.operations ?? []), ...(report.tools?.operations ?? [])];
}
