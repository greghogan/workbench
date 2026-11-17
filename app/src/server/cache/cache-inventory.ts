import { inspectBuildCache, type CacheReport } from "../../core/storage/build-cache.js";
import { describeError } from "../../core/diagnostics/diagnostic-errors.mjs";
import { inspectBuilderCache } from "../../core/storage/builder-cache.js";
import { buildStorageSettings } from "../../core/artifacts/builds.js";
import { discoverCacheSizes, measureCacheSize, type CacheSize } from "../../core/storage/cache-size.js";
import { inspectPreparedImages } from "../../core/artifacts/prepared-images.js";
import { registeredProjectName } from "../../core/projects/project-registration.js";
import { projectRegistrySnapshot, type RegisteredProject } from "../../core/projects/project-registry.js";
import { projectRequirementSnapshot } from "../../core/projects/project-requirements.js";
import { inspectToolCache, prunableTools } from "../../core/toolchains/tool-cache.js";
import { inspectToolReferences } from "../../core/toolchains/tool-references.js";
import { matchesToolRequirement } from "../../core/toolchains/tool-requirements.js";
import { measureSizes } from "./cache-measurements.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectPaths } from "../../core/projects/project-paths.js";

export interface InventoryIssue {
  component: "registry" | "requirements" | "references" | "builds" | "tools" | "builders" | "images" | "size";
  phase: "discovery" | "measurement";
  message: string;
  path?: string;
}
export interface CacheInventory {
  pendingComponents?: InventoryIssue["component"][];
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
export function applyInventorySize(value: CacheInventory, size: CacheSize): CacheSize | undefined {
  let lookup = sizeIndexes.get(value);
  if (!lookup) {
    const entries = new Map<string, { bytes?: number | undefined; measurement?: CacheSize | undefined }[]>();
    for (const entry of [
      ...value.inventory.entries,
      ...(value.inventory.tools?.entries ?? []),
      ...(value.inventory.operations ?? []),
      ...(value.inventory.tools?.operations ?? []),
    ]) {
      const directory = entry.measurement?.directory ?? entry.directory;
      const group = entries.get(directory) ?? [];
      group.push(entry);
      entries.set(directory, group);
    }
    lookup = { positions: new Map(value.sizes.map((entry, index) => [entry.directory, index])), entries };
    sizeIndexes.set(value, lookup);
  }
  const index = lookup.positions.get(size.directory) ?? -1;
  if (index < 0) return;
  const previous = value.sizes[index];
  const measured =
    size.bytes === undefined && previous?.bytes !== undefined
      ? { ...size, bytes: previous.bytes, ...(previous.measuredAt ? { measuredAt: previous.measuredAt } : {}) }
      : size;
  value.sizes[index] = measured;
  for (const entry of lookup.entries.get(size.directory) ?? []) {
    if (measured.bytes !== undefined) entry.bytes = measured.bytes;
    entry.measurement = measured;
  }
  return measured;
}
const sizeIndexes = new WeakMap<
  CacheInventory,
  {
    positions: Map<string, number>;
    entries: Map<string, { bytes?: number | undefined; measurement?: CacheSize | undefined }[]>;
  }
>();
/** Component discovery publishes useful partial results before any recursive size calculation. */
export async function collectCacheInventory(
  progress?: (event: CacheProgress) => void,
  force = false,
  priority?: string,
  parentSignal?: AbortSignal,
): Promise<CacheInventory> {
  parentSignal?.throwIfAborted();
  const cancellation = new AbortController(),
    signal = cancellation.signal;
  const cancel = () => {
    cancellation.abort(parentSignal?.reason);
  };
  parentSignal?.addEventListener("abort", cancel, { once: true });
  let measurements: Promise<void> | undefined;
  const result = emptyInventory();
  result.pendingComponents = ["builders"];
  // Begin external discovery before synchronous filesystem metadata acquisition.
  const builders = inspectBuilderCache(undefined, signal).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
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
        if (entry.unavailable && existsSync(join(entry.project.path, projectPaths.projects)))
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
        if (report) {
          result.inventory.entries.push(...report.entries);
          (result.inventory.operations ??= []).push(...(report.operations ?? []));
        }
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
        for (const message of report?.issues ?? [])
          result.issues.push({ component: name, phase: "discovery", message });
    });
    result.sizes = sizes;
    progress?.({ kind: "metadata", value: { ...result, inventory: { ...result.inventory } } });
    const preferred = new Set(
      result.inventory.entries.filter((entry) => entry.identity.checkout === priority).map((entry) => entry.directory),
    );
    const pending = [...sizes].sort(
      (left, right) => Number(preferred.has(right.directory)) - Number(preferred.has(left.directory)),
    );
    measurements = measureSizes(pending, async (size) => {
      signal.throwIfAborted();
      const measured = await measureCacheSize(size, force, signal);
      applyInventorySize(result, measured);
      if (measured.problem)
        result.issues.push({
          component: "size",
          phase: "measurement",
          path: size.directory,
          message: measured.problem,
        });
      if (measured !== size) progress?.({ kind: "size", size: measured });
    });
    void measurements.catch(() => undefined);
    try {
      const discovered = await builders;
      if ("error" in discovered) throw discovered.error;
      result.inventory.builders = discovered.value;
      for (const message of discovered.value.issues)
        result.issues.push({ component: "builders", phase: "discovery", message });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        await measurements.catch(() => undefined);
        signal.throwIfAborted();
        throw error;
      }
      result.issues.push({ component: "builders", phase: "discovery", message: describeError(error) });
    }
    delete result.pendingComponents;
    progress?.({ kind: "metadata", value: result });
    await measurements;
    return result;
  } finally {
    cancellation.abort();
    await Promise.allSettled([builders, ...(measurements ? [measurements] : [])]);
    parentSignal?.removeEventListener("abort", cancel);
  }
}
