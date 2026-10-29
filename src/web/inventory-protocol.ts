import type { CacheSize } from "../cache-size.js";
import { decodeCacheSize } from "./size-protocol.js";

export const inventorySections = ["projects", "roots", "tools", "builders", "images"] as const;
export type InventorySection = (typeof inventorySections)[number];
export const isInventorySection = (value: string): value is InventorySection =>
  inventorySections.some((section) => section === value);
export interface InventoryPatch {
  sections: Partial<Record<InventorySection, string>>;
  problems: string[];
  refreshing: boolean;
  sizes: CacheSize[];
}
/** Shared producer and browser contract; decoding finishes before publishing any DOM update. */
export function decodeInventoryPatch(input: unknown): InventoryPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid inventory update");
  const data = input as Record<string, unknown>;
  if (
    !data.sections ||
    typeof data.sections !== "object" ||
    Array.isArray(data.sections) ||
    Object.entries(data.sections).some(([key, value]) => !isInventorySection(key) || typeof value !== "string") ||
    !Array.isArray(data.problems) ||
    data.problems.some((value: unknown) => typeof value !== "string") ||
    typeof data.refreshing !== "boolean" ||
    !Array.isArray(data.sizes)
  )
    throw new Error("Invalid inventory update");
  return {
    sections: data.sections,
    problems: data.problems as string[],
    refreshing: data.refreshing,
    sizes: data.sizes.map((value) => decodeCacheSize(value)),
  };
}
