import { inspectBuildCache, type CacheReport } from "../build-cache.js";
import { describeError } from "../../scripts/diagnostic-errors.mjs";
import { inspectBuilderCache } from "../builder-cache.js";
import { buildStorageSettings } from "../builds.js";
import { discoverCacheSizes, measureCacheSize, type CacheSize } from "../cache-size.js";
import { inspectPreparedImages } from "../prepared-images.js";
import { registeredProjectName } from "../project-registration.js";
import { projectRegistrySnapshot, type RegisteredProject } from "../project-registry.js";
import { projectRequirementSnapshot } from "../project-requirements.js";
import { inspectToolCache, prunableTools } from "../tool-cache.js";
import { inspectToolReferences } from "../tool-references.js";
import { matchesToolRequirement } from "../tool-requirements.js";
import { measureSizes } from "./cache-measurements.js";

export interface InventoryIssue {
  component: "registry" | "requirements" | "references" | "builds" | "tools" | "builders" | "images" | "size";
  phase: "discovery" | "measurement";
  message: string;
  path?: string;
}
export interface CacheInventory {
  inventory: CacheReport;
  projects: RegisteredProject[];
  prunable: string[];
  kept: string[];
  consumers: Record<string, string[]>;
  uncertainConsumers: string[];
  sizes: CacheSize[];
  issues: InventoryIssue[];
}
export type CacheProgress = { kind: "metadata"; value: CacheInventory } | { kind: "size"; size: CacheSize };
export function emptyInventory(): CacheInventory {
  return {
    inventory: { storageRoot: "", checkout: null, entries: [] },
    projects: [],
    prunable: [],
    kept: [],
    consumers: {},
    uncertainConsumers: [],
    sizes: [],
    issues: [],
  };
}
export function applyInventorySize(value: CacheInventory, size: CacheSize): void {
  const index = value.sizes.findIndex((entry) => entry.directory === size.directory);
  if (index < 0) return;
  value.sizes[index] = size;
  for (const entry of [...value.inventory.entries, ...(value.inventory.tools?.entries ?? [])])
    if (entry.directory === size.directory) {
      if (size.bytes !== undefined) entry.bytes = size.bytes;
      entry.measurement = size;
    }
}
/** Component discovery publishes useful partial results before any recursive size calculation. */
export async function collectCacheInventory(
  progress?: (event: CacheProgress) => void,
  force = false,
  priority?: string,
  signal?: AbortSignal,
): Promise<CacheInventory> {
  const result = emptyInventory();
  function component<T>(name: InventoryIssue["component"], action: () => T): T | undefined {
    try {
      return action();
    } catch (error) {
      result.issues.push({
        component: name,
        phase: "discovery",
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
  const { sizes } = discoverCacheSizes(() => {
    const registry = component("registry", projectRegistrySnapshot);
    result.projects = (registry?.projects ?? []).map((project) => ({
      ...project,
      name: registeredProjectName(project),
    }));
    result.kept = [...(registry?.kept ?? [])];
    const references = component("references", inspectToolReferences) ?? {
      results: [],
      issues: ["Result references are unavailable"],
    };
    const requirements = component("requirements", () => projectRequirementSnapshot(result.projects)) ?? [];
    result.uncertainConsumers = requirements.filter((entry) => entry.unavailable).map((entry) => entry.project.path);
    for (const entry of requirements)
      if (entry.unavailable)
        result.issues.push({
          component: "requirements",
          phase: "discovery",
          path: entry.project.path,
          message: entry.problem ?? "Requirements unavailable",
        });
    const stores = new Set(references.results.map((entry) => entry.storageRoot));
    const defaultStore = component("builds", () => buildStorageSettings().root);
    if (defaultStore) {
      stores.add(defaultStore);
      result.inventory.storageRoot = defaultStore;
    }
    for (const project of result.projects) {
      const store = component("builds", () => buildStorageSettings(project.path).root);
      if (store) stores.add(store);
    }
    for (const store of stores) {
      const report = component("builds", () =>
        inspectBuildCache(undefined, true, undefined, store, registry?.kept ?? new Set()),
      );
      if (!registry && report) for (const entry of report.entries) entry.blockedBy ??= "Retention state unavailable";
      if (report) result.inventory.entries.push(...report.entries);
    }
    if (registry) {
      const tools = component("tools", () => inspectToolCache(undefined, [], { registry, requirements, references }));
      if (tools) {
        result.inventory.tools = tools;
        result.prunable = prunableTools(tools).map((entry) => entry.id);
        const actual = new Map<string, Set<string>>();
        for (const tool of tools.entries) {
          const consumers = new Set(
            tool.protections.flatMap((entry) => (entry.kind === "project" ? [entry.project] : [])),
          );
          for (const ref of references.results)
            if (ref.tools.some((required) => matchesToolRequirement(required, tool)))
              consumers.add(ref.identity.checkout);
          actual.set(tool.id, consumers);
        }
        result.consumers = Object.fromEntries([...actual].map(([key, value]) => [key, [...value]]));
      }
    }
    const images = component("images", () => inspectPreparedImages());
    if (images) result.inventory.images = images;
    for (const [name, report] of [
      ["tools", result.inventory.tools],
      ["images", images],
    ] as const)
      for (const message of report?.issues ?? []) result.issues.push({ component: name, phase: "discovery", message });
  });
  try {
    const builders = await inspectBuilderCache(undefined, signal);
    result.inventory.builders = builders;
    for (const message of builders.issues) result.issues.push({ component: "builders", phase: "discovery", message });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    result.issues.push({ component: "builders", phase: "discovery", message: describeError(error) });
  }
  result.sizes = sizes;
  progress?.({ kind: "metadata", value: result });
  const preferred = new Set(
    result.inventory.entries.filter((entry) => entry.identity.checkout === priority).map((entry) => entry.directory),
  );
  const pending = [...sizes].sort(
    (left, right) => Number(preferred.has(right.directory)) - Number(preferred.has(left.directory)),
  );
  await measureSizes(pending, async (size) => {
    signal?.throwIfAborted();
    const measured = await measureCacheSize(size, force, signal);
    applyInventorySize(result, measured);
    if (measured.problem)
      result.issues.push({ component: "size", phase: "measurement", path: size.directory, message: measured.problem });
    if (measured !== size) progress?.({ kind: "size", size: measured });
  });
  return result;
}
