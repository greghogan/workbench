import { cacheGenerationIdentity } from "./cache-plan-identity.js";
import { addBytes, totalBytes } from "./byte-size.js";
import { imageDisplayTag, filterPreparedImages } from "./image-contract.js";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  buildCheckout,
  buildOwnerKey,
  buildStorageSettings,
  buildStorageRoots,
  readBuildGeneration,
  withBuildLock,
  buildLockDirectory,
  type BuildIdentity,
  type BuildCacheKind,
} from "./builds.js";
import { ownedPath } from "./paths.js";
import { withCacheLocksSync } from "./cache-lock.js";
import { cacheAmount } from "./cache-size.js";
import { inspectToolCache, pruneToolCache, prunableTools, toolCacheGroup, type ToolCacheReport } from "./tool-cache.js";
import { refreshToolReferences } from "./tool-references.js";
import { keptCacheAssets } from "./project-registry.js";
import { guixProfileRegistrations, releaseGuixProfiles } from "./managed-profiles.js";
import { inspectBuilderCache, pruneBuilderCache, type BuilderCacheReport } from "./builder-cache.js";
import { pruneItem, type CachePruneObserver } from "./cache-prune-progress.js";
import { ChecksCancelled } from "./check-cancellation.js";
import {
  inspectPreparedImages,
  inspectRegistryImages,
  prunePreparedImages,
  type PreparedImageReport,
} from "./prepared-images.js";

export interface CacheEntry {
  generation?: string;
  measurement?: import("./cache-size.js").CacheSize;
  kind: BuildCacheKind;
  directory: string;
  bytes: number | undefined;
  identity: BuildIdentity;
  blockedBy?: string;
}

export interface CacheReport {
  storageRoot: string;
  checkout: string | null;
  entries: CacheEntry[];
  tools?: ToolCacheReport;
  builders?: BuilderCacheReport;
  images?: PreparedImageReport;
  retained?: string[];
}

function directories(root: string, pattern?: RegExp): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => !pattern || pattern.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const path = ownedPath(root, entry.name);
      if (!entry.isDirectory()) throw new Error(`${path}: unexpected file in build storage`);
      return path;
    });
}

/** Inspect existing receipts only: no registry, missing-checkout probes, setup, or cache creation. */
export function inspectBuildCache(
  root?: string,
  all = false,
  checkout?: string,
  storage?: string,
  retained = keptCacheAssets(),
): CacheReport {
  if (all && checkout !== undefined) throw new Error("select --all or --checkout, not both");
  if (root !== undefined) root = realpathSync(root);
  let selected = root && !all ? buildCheckout(root) : undefined;
  if (checkout !== undefined) {
    const requested = resolve(checkout);
    selected = existsSync(requested) ? realpathSync(requested) : requested;
    if (root === selected) selected = buildCheckout(root);
  }
  const storageRoot = storage ?? buildStorageSettings(root).root;
  const entries: CacheEntry[] = [];
  const selectedRoots = selected ? buildStorageRoots(storageRoot, { checkout: selected, root: "." }) : undefined;
  for (const kind of ["builds", "dependencies", "checks"] as const) {
    const base = ownedPath(storageRoot, kind === "checks" ? "check-results" : kind);
    const checkouts = selectedRoots
      ? [
          dirname(
            kind === "builds"
              ? selectedRoots.roots
              : kind === "checks"
                ? selectedRoots.checkRoots
                : selectedRoots.dependencyRoots,
          ),
        ]
      : directories(base, /^[a-f0-9]{24}$/);
    for (const namespace of checkouts) {
      for (const languageRoot of directories(namespace)) {
        for (const directory of directories(
          languageRoot,
          kind === "checks" ? /^native-[a-f0-9]{24}$/ : /^(?!.*\.lock$)/,
        )) {
          if (
            kind === "checks" &&
            existsSync(`${directory}.lock`) &&
            !existsSync(join(directory, ".workbench-check-result.json"))
          )
            continue;
          const identity = readBuildGeneration(storageRoot, directory, kind);
          if (!selected || identity.checkout === selected)
            entries.push(cacheEntry(storageRoot, kind, directory, identity));
        }
      }
    }
  }
  for (const namespace of directories(ownedPath(storageRoot, "check-logs"))) {
    if (!existsSync(join(namespace, ".workbench-check-logs.json"))) continue;
    for (const directory of directories(namespace, /^(?!.*\.lock$)[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)) {
      const identity = readBuildGeneration(storageRoot, directory, "logs");
      if (!selected || identity.checkout === selected)
        entries.push(cacheEntry(storageRoot, "logs", directory, identity));
    }
  }
  const kept = retained;
  for (const entry of entries)
    if (kept.has(entry.directory) && !entry.blockedBy) entry.blockedBy = "explicitly retained";
  return { storageRoot, checkout: selected ?? null, entries };
}

function cacheEntry(storageRoot: string, kind: BuildCacheKind, directory: string, identity: BuildIdentity): CacheEntry {
  const lock = buildLockDirectory(identity);
  const dependencies = managedDependencyDirectory(storageRoot, identity);
  const blockedBy = [lock, `${directory}.lock`, ...(dependencies ? [`${dependencies}.lock`] : [])].find(existsSync);
  return {
    kind,
    directory,
    identity,
    generation: cacheGenerationIdentity(directory),
    ...cacheAmount(directory),
    ...(blockedBy ? { blockedBy } : {}),
  };
}

function managedDependencyDirectory(storageRoot: string, identity: BuildIdentity): string | undefined {
  if (identity.environment !== "nix" && identity.environment !== "guix") return;
  return join(
    buildStorageRoots(storageRoot, identity).dependencyRoots,
    `${identity.environment}-${identity.fingerprint}`,
  );
}

/** Lock every selected root and validate the complete deletion set before removing any owned generation. */
export interface BuildPruneRequest {
  report: CacheReport;
  dependencies?: boolean | undefined;
  apply?: boolean;
  admissionHeld?: boolean;
  progress?: CachePruneObserver | undefined;
  validate?: ((entries: readonly CacheEntry[]) => void) | undefined;
}
export function pruneBuildCache(request: BuildPruneRequest & { apply: true }): Promise<CacheEntry[]>;
export function pruneBuildCache(request: BuildPruneRequest & { apply?: false }): CacheEntry[];
export function pruneBuildCache({
  report,
  dependencies = false,
  apply = false,
  admissionHeld = false,
  progress,
  validate,
}: BuildPruneRequest): CacheEntry[] | Promise<CacheEntry[]> {
  const selected = report.entries.filter((entry) => dependencies || entry.kind !== "dependencies");
  if (!apply) return selected;
  if (!selected.length) return Promise.resolve([]);
  const owners = [...new Map(selected.map((entry) => [buildOwnerKey(entry.identity), entry.identity])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, identity]) => identity);
  async function locked(index: number): Promise<void> {
    const identity = owners[index];
    if (identity) {
      await withBuildLock({ identity }, () => locked(index + 1), admissionHeld);
      return;
    }
    await withCacheLocksSync(
      [
        ...new Set(
          selected.flatMap((entry) => [
            ...(entry.kind !== "builds" ? [entry.directory] : []),
            ...[managedDependencyDirectory(report.storageRoot, entry.identity)].filter((path) => path !== undefined),
          ]),
        ),
      ].sort(),
      remove,
      { mutable: false },
    );
  }
  async function remove(): Promise<void> {
    validate?.(selected);
    const kept = keptCacheAssets();
    for (const entry of selected) {
      if (kept.has(entry.directory))
        throw new Error(`${entry.directory}: explicitly retained; inspect a fresh cleanup selection`);
      readBuildGeneration(report.storageRoot, entry.directory, entry.kind, entry.identity);
      if (entry.generation !== undefined && cacheGenerationIdentity(entry.directory) !== entry.generation)
        throw new Error(`${entry.directory}: cache generation changed; inspect a fresh cleanup selection`);
      if (entry.kind === "dependencies") guixProfileRegistrations(entry.directory);
    }
    let removed = 0;
    for (const entry of selected) {
      try {
        await pruneItem(
          `${basename(entry.identity.checkout)} / ${entry.identity.root} / ${entry.kind}`,
          async () => {
            if (entry.kind === "dependencies") releaseGuixProfiles(entry.directory);
            await rm(entry.directory, { recursive: true });
          },
          progress,
        );
        removed++;
      } catch (error) {
        if (error instanceof ChecksCancelled) throw error;
        throw new Error(
          `${entry.directory}: cleanup failed after removing ${String(removed)} cache directories; inspect usage again`,
          { cause: error },
        );
      }
    }
  }
  return locked(0).then(() => selected);
}

interface CacheUsage {
  builds: number | undefined;
  dependencies: number | undefined;
  checks: number | undefined;
  tools: number | undefined;
}

export interface CacheProject extends CacheUsage {
  checkout: string;
  count: number;
  rows: (CacheUsage & { root: string; target: string })[];
}

/** One aggregation supplies table rows, checkout subtotals, and deletion selection estimates. */
export function groupCacheEntries(entries: CacheEntry[]): CacheProject[] {
  const projects = new Map<string, Omit<CacheProject, "rows"> & { rows: Map<string, CacheProject["rows"][number]> }>();
  for (const entry of entries) {
    const { checkout, root, localCI } = entry.identity;
    let project = projects.get(checkout);
    if (!project) {
      project = { checkout, count: 0, builds: 0, dependencies: 0, checks: 0, tools: 0, rows: new Map() };
      projects.set(checkout, project);
    }
    project.count++;
    const kind = entry.kind === "logs" ? "checks" : entry.kind;
    project[kind] = addBytes(project[kind], entry.bytes);
    const target = localCI?.target ?? "—";
    const key = JSON.stringify([root, target]);
    const row = project.rows.get(key) ?? { root, target, builds: 0, dependencies: 0, checks: 0, tools: 0 };
    row[kind] = addBytes(row[kind], entry.bytes);
    project.rows.set(key, row);
  }
  return [...projects.values()]
    .sort((a, b) => (a.checkout < b.checkout ? -1 : a.checkout > b.checkout ? 1 : 0))
    .map(({ rows, ...project }) => ({
      ...project,
      rows: [...rows.values()].sort((a, b) => a.root.localeCompare(b.root) || a.target.localeCompare(b.target)),
    }));
}

/** Tools are a virtual project; its language groups use the same totals and recursive selection. */
export function groupCacheReport(report: CacheReport): CacheProject[] {
  const projects = groupCacheEntries(report.entries);
  if (report.images?.entries.length)
    projects.push({
      checkout: "Images",
      count: report.images.entries.length,
      builds: totalBytes(report.images.entries.map((entry) => entry.bytes)),
      dependencies: 0,
      checks: 0,
      tools: 0,
      rows: report.images.entries.map((entry) => ({
        root: `${entry.profile} (${imageDisplayTag(entry.reference)})`,
        target: report.images?.location === "registry" ? "GHCR" : "Docker image",
        builds: entry.bytes,
        dependencies: 0,
        checks: 0,
        tools: 0,
      })),
    });
  if (report.builders?.entries.length)
    projects.push({
      checkout: "Builders",
      count: report.builders.entries.length,
      builds: 0,
      dependencies: totalBytes(report.builders.entries.map((entry) => entry.bytes)),
      checks: 0,
      tools: 0,
      rows: report.builders.entries.map((entry) => ({
        root: entry.key,
        target: "Docker volumes",
        builds: 0,
        dependencies: entry.bytes,
        checks: 0,
        tools: 0,
      })),
    });
  if (report.tools?.entries.length) {
    const groups = new Map<string, number | undefined>();
    for (const entry of report.tools.entries) {
      const group = toolCacheGroup(entry.tool);
      groups.set(group, addBytes(groups.has(group) ? groups.get(group) : 0, entry.bytes));
    }
    projects.push({
      checkout: "Tools",
      count: report.tools.entries.length,
      builds: 0,
      dependencies: 0,
      checks: 0,
      tools: totalBytes(report.tools.entries.map((entry) => entry.bytes)),
      rows: [...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([root, tools]) => ({ root, target: "—", builds: 0, dependencies: 0, checks: 0, tools })),
    });
  }
  return projects;
}

export async function inspectCache(
  root?: string,
  all = false,
  checkout?: string,
  registry = false,
): Promise<CacheReport> {
  if (registry) {
    if (!root || all || checkout !== undefined)
      throw new Error("Registry inspection requires the current project without --all or --checkout");
    return {
      storageRoot: buildStorageSettings(root).root,
      checkout: "images",
      entries: [],
      images: inspectRegistryImages(root),
    };
  }
  if (all && ["tools", "builders", "images"].includes(checkout ?? ""))
    throw new Error("select --all or --checkout, not both");
  const report =
    checkout === "tools" || checkout === "builders" || checkout === "images"
      ? { storageRoot: buildStorageSettings(root).root, checkout, entries: [] }
      : inspectBuildCache(root, all, checkout);
  return {
    ...report,
    ...(checkout === undefined || checkout === "tools" ? { tools: inspectToolCache(root) } : {}),
    ...(checkout !== "tools" && checkout !== "images"
      ? {
          builders: await inspectBuilderCache(
            report.checkout === "builders" ? undefined : (report.checkout ?? undefined),
          ),
        }
      : {}),
    ...(checkout === undefined || checkout === "images"
      ? { images: inspectPreparedImages(report.checkout === "images" ? undefined : (report.checkout ?? undefined)) }
      : {}),
  };
}

export interface CachePruneRequest {
  report: CacheReport;
  root?: string | undefined;
  dependencies?: boolean | undefined;
  apply?: boolean;
  progress?: CachePruneObserver | undefined;
}
export async function pruneCache({
  report,
  root,
  dependencies = false,
  apply = false,
  progress,
}: CachePruneRequest): Promise<CacheReport> {
  const candidates = cachePruneCandidates(report, dependencies);
  const entries = candidates.entries;
  const tools = report.tools
    ? {
        ...report.tools,
        entries: prunableTools(
          report.tools,
          entries.map((entry) => entry.directory),
        ),
      }
    : undefined;
  if (apply) {
    progress?.begin(
      entries.length +
        (tools?.entries.length ?? 0) +
        (candidates.builders?.entries.length ?? 0) +
        (candidates.images?.entries.length ?? 0),
    );
    if (candidates.images) await prunePreparedImages(candidates.images, progress);
    if (candidates.builders) await pruneBuilderCache(candidates.builders, progress);
    if (tools?.entries.length)
      await pruneToolCache(
        tools,
        root,
        true,
        {
          directories: entries.map((entry) => entry.directory),
          remove: async () => {
            await pruneBuildCache({
              report: { ...report, entries },
              dependencies: dependencies,
              apply: true,
              admissionHeld: true,
              progress: progress,
            });
          },
        },
        progress,
      );
    else
      await pruneBuildCache({
        report: { ...report, entries },
        dependencies: dependencies,
        apply: true,
        admissionHeld: false,
        progress: progress,
      });
    if (report.images?.location !== "registry") refreshToolReferences();
  }
  return {
    ...report,
    retained: candidates.retained ?? [],
    entries,
    ...(tools ? { tools } : {}),
    ...(candidates.builders ? { builders: candidates.builders } : {}),
    ...(candidates.images ? { images: candidates.images } : {}),
  };
}

/** Establish the offer before prompting; deletion revalidates it under locks. */
export function cachePruneCandidates(report: CacheReport, dependencies = false): CacheReport {
  const retained = [...(report.retained ?? [])];
  for (const entry of report.images?.entries ?? [])
    if (entry.blockedBy) retained.push(`Image ${entry.reference}: ${entry.blockedBy}; retained.`);
  for (const entry of report.builders?.entries ?? [])
    if (entry.blockedBy) retained.push(`Builder ${entry.key}: ${entry.blockedBy}; retained.`);
  const busy = (entry: CacheEntry) =>
    entry.blockedBy !== undefined && (entry.blockedBy === "explicitly retained" || existsSync(entry.blockedBy));
  const blocked = new Set(report.entries.filter(busy).map((entry) => entry.identity.checkout));
  for (const checkout of [...blocked].sort())
    retained.push(`${checkout}: active or recovery-required cache locks; retained.`);
  const entries = pruneBuildCache({
    report: { ...report, entries: report.entries.filter((entry) => !busy(entry)) },
    dependencies: dependencies,
  });
  const toolCandidates = report.tools
    ? prunableTools(
        report.tools,
        entries.map((entry) => entry.directory),
      )
    : [];
  const protectedTools = (report.tools?.entries.length ?? 0) - toolCandidates.length;
  if (protectedTools)
    retained.push(
      `Tools: retained ${String(protectedTools)} protected installations${report.tools?.blockedBy ? `; active or recovery-required build lock: ${report.tools.blockedBy}` : " (retained results or active commands)"}.`,
    );
  return {
    ...report,
    entries,
    ...(report.tools ? { tools: { ...report.tools, entries: toolCandidates } } : {}),
    ...(report.builders
      ? { builders: { ...report.builders, entries: report.builders.entries.filter((entry) => !entry.blockedBy) } }
      : {}),
    ...(report.images ? { images: filterPreparedImages(report.images, (entry) => !entry.blockedBy) } : {}),
    retained,
  };
}
