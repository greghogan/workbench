import { decodeCacheMeasurement, type CacheMeasurement } from "./size-protocol.js";

export const inventorySections = ["projects", "roots", "tools", "builders", "images", "operations"] as const;
export type InventorySection = (typeof inventorySections)[number];
export const isInventorySection = (value: string): value is InventorySection =>
  inventorySections.some((section) => section === value);
export interface InventoryPatch {
  revision?: number;
  sections: Partial<Record<InventorySection, string>>;
  problems: string[];
  refreshing: boolean;
  sizes: CacheMeasurement[];
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
    !Array.isArray(data.sizes) ||
    (data.revision !== undefined &&
      (typeof data.revision !== "number" || !Number.isSafeInteger(data.revision) || data.revision < 0))
  )
    throw new Error("Invalid inventory update");
  return {
    ...(typeof data.revision === "number" ? { revision: data.revision } : {}),
    sections: data.sections,
    problems: data.problems as string[],
    refreshing: data.refreshing,
    sizes: data.sizes.map((value) => decodeCacheMeasurement(value)),
  };
}

export interface ProjectCacheSizeUpdate {
  cell: string;
  text: string;
  title: string;
  revision: number;
}

export function decodeProjectCacheSize(input: unknown): ProjectCacheSizeUpdate {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid project cache total");
  const data = input as Record<string, unknown>;
  if (
    typeof data.cell !== "string" ||
    !/^project-[a-f0-9]{24}-(owned|eligible|retained|tools|shared)$/.test(data.cell) ||
    typeof data.text !== "string" ||
    typeof data.title !== "string" ||
    typeof data.revision !== "number" ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0
  )
    throw new Error("Invalid project cache total");
  return { cell: data.cell, text: data.text, title: data.title, revision: data.revision };
}
