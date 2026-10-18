import { imageDisplayTag, filterPreparedImages } from "./image-contract.js";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Command } from "commander";
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
import { hasCollectionProject } from "./collections.js";
import { ownedPath } from "./paths.js";
import { terminalTable } from "./terminal-table.js";
import { chooseItems, terminalAvailable, type TerminalInput, type TerminalOutput } from "./terminal-choice.js";
import { formatBytes } from "./byte-size.js";
import { cachePruneSelection, cachePruneSummary } from "./cache-prune-selection.js";
import { withCacheLocksSync } from "./cache-lock.js";
import { cacheBytes as bytes } from "./cache-size.js";
import { inspectToolCache, pruneToolCache, prunableTools, toolCacheGroup, type ToolCacheReport } from "./tool-cache.js";
import { refreshToolReferences } from "./tool-references.js";
import { inspectToolCacheActivity, withToolCacheAdmission } from "./tool-cache-lock.js";
import { guixProfileRegistrations, releaseGuixProfiles } from "./managed-profiles.js";
import { inspectBuilderCache, pruneBuilderCache, type BuilderCacheReport } from "./builder-cache.js";
import { CachePruneProgress, pruneItem, type CachePruneObserver } from "./cache-prune-progress.js";
import { CheckCancellation, ChecksCancelled } from "./check-cancellation.js";
import {
  inspectPreparedImages,
  inspectRegistryImages,
  prunePreparedImages,
  type PreparedImageReport,
} from "./prepared-images.js";

export interface CacheEntry {
  kind: BuildCacheKind;
  directory: string;
  bytes: number;
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
export function inspectBuildCache(root?: string, all = false, checkout?: string): CacheReport {
  if (all && checkout !== undefined) throw new Error("select --all or --checkout, not both");
  if (root !== undefined) root = realpathSync(root);
  let selected = root && !all ? buildCheckout(root) : undefined;
  if (checkout !== undefined) {
    const requested = resolve(checkout);
    selected = existsSync(requested) ? realpathSync(requested) : requested;
    if (root === selected) selected = buildCheckout(root);
  }
  const storageRoot = buildStorageSettings(root).root;
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
  return { storageRoot, checkout: selected ?? null, entries };
}

function cacheEntry(storageRoot: string, kind: BuildCacheKind, directory: string, identity: BuildIdentity): CacheEntry {
  const lock = buildLockDirectory(identity);
  const dependencies = managedDependencyDirectory(storageRoot, identity);
  const blockedBy = [lock, `${directory}.lock`, ...(dependencies ? [`${dependencies}.lock`] : [])].find(existsSync);
  return { kind, directory, identity, bytes: bytes(directory), ...(blockedBy ? { blockedBy } : {}) };
}

function managedDependencyDirectory(storageRoot: string, identity: BuildIdentity): string | undefined {
  if (identity.environment !== "nix" && identity.environment !== "guix") return;
  return join(
    buildStorageRoots(storageRoot, identity).dependencyRoots,
    `${identity.environment}-${identity.fingerprint}`,
  );
}

/** Lock every selected root and validate the complete deletion set before removing any owned generation. */
export function pruneBuildCache(report: CacheReport, dependencies?: boolean, apply?: false): CacheEntry[];
export function pruneBuildCache(
  report: CacheReport,
  dependencies: boolean,
  apply: true,
  admissionHeld?: boolean,
  progress?: CachePruneObserver,
): Promise<CacheEntry[]>;
export function pruneBuildCache(
  report: CacheReport,
  dependencies = false,
  apply = false,
  admissionHeld = false,
  progress?: CachePruneObserver,
): CacheEntry[] | Promise<CacheEntry[]> {
  const selected = report.entries.filter((entry) => dependencies || entry.kind !== "dependencies");
  if (!apply) return selected;
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
    );
  }
  async function remove(): Promise<void> {
    for (const entry of selected) {
      readBuildGeneration(report.storageRoot, entry.directory, entry.kind, entry.identity);
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
  builds: number;
  dependencies: number;
  checks: number;
  tools: number;
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
    project[kind] += entry.bytes;
    const target = localCI?.target ?? "—";
    const key = JSON.stringify([root, target]);
    const row = project.rows.get(key) ?? { root, target, builds: 0, dependencies: 0, checks: 0, tools: 0 };
    row[kind] += entry.bytes;
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
      builds: report.images.entries.reduce((sum, entry) => sum + entry.bytes, 0),
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
      dependencies: report.builders.entries.reduce((sum, entry) => sum + entry.bytes, 0),
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
    const groups = new Map<string, number>();
    for (const entry of report.tools.entries) {
      const group = toolCacheGroup(entry.tool);
      groups.set(group, (groups.get(group) ?? 0) + entry.bytes);
    }
    projects.push({
      checkout: "Tools",
      count: report.tools.entries.length,
      builds: 0,
      dependencies: 0,
      checks: 0,
      tools: report.tools.entries.reduce((sum, entry) => sum + entry.bytes, 0),
      rows: [...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([root, tools]) => ({ root, target: "—", builds: 0, dependencies: 0, checks: 0, tools })),
    });
  }
  return projects;
}

export function inspectCache(root?: string, all = false, checkout?: string, registry = false): CacheReport {
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
      ? { builders: inspectBuilderCache(report.checkout === "builders" ? undefined : (report.checkout ?? undefined)) }
      : {}),
    ...(checkout === undefined || checkout === "images"
      ? { images: inspectPreparedImages(report.checkout === "images" ? undefined : (report.checkout ?? undefined)) }
      : {}),
  };
}

export async function pruneCache(
  report: CacheReport,
  root?: string,
  dependencies = false,
  apply = false,
  progress?: CachePruneObserver,
): Promise<CacheReport> {
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
            await pruneBuildCache({ ...report, entries }, dependencies, true, true, progress);
          },
        },
        progress,
      );
    else await pruneBuildCache({ ...report, entries }, dependencies, true, false, progress);
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
  const busy = (entry: CacheEntry) => entry.blockedBy !== undefined && existsSync(entry.blockedBy);
  const blocked = new Set(report.entries.filter(busy).map((entry) => entry.identity.checkout));
  for (const checkout of [...blocked].sort())
    retained.push(`${checkout}: active or recovery-required cache locks; retained.`);
  const entries = pruneBuildCache({ ...report, entries: report.entries.filter((entry) => !busy(entry)) }, dependencies);
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

export function printCacheReport(report: CacheReport): void {
  if (report.images?.location === "registry") {
    console.log("GHCR prepared images (registry deletion is separate from local cleanup):");
    if (report.images.entries.length)
      console.log(
        terminalTable(
          ["PROFILE", "TAGS", "CREATED (UTC)", "STATUS"],
          report.images.entries.map((entry) => [
            entry.profile,
            entry.tags.join(", "),
            entry.created,
            entry.blockedBy ?? "removable",
          ]),
        ),
      );
    else console.log("No matching prepared images found.");
    printCacheNotices(report);
    return;
  }
  const projects = groupCacheReport(report).filter((project) => !["Images", "Builders"].includes(project.checkout));
  console.log(`Cache: ${report.storageRoot}`);
  console.log(
    `Selection: ${report.checkout === "tools" ? "Tools" : report.checkout === "builders" ? "Builders" : report.checkout === "images" ? "Images" : (report.checkout ?? "all checkouts")}${report.tools && report.checkout !== "tools" ? " and Tools" : ""}${report.builders?.entries.length && report.checkout !== "builders" ? " and Builders" : ""}${report.images?.entries.length && report.checkout !== "images" ? " and Images" : ""}`,
  );
  const table: string[][] = [],
    separators: { after: number; from?: number }[] = [];
  let builds = 0,
    dependencies = 0,
    checks = 0,
    tools = 0;
  for (const project of projects) {
    builds += project.builds;
    dependencies += project.dependencies;
    checks += project.checks;
    tools += project.tools;
    for (const [index, row] of project.rows.entries())
      table.push([
        index === 0 ? project.checkout : "",
        row.root,
        row.target,
        formatBytes(row.builds),
        formatBytes(row.dependencies),
        formatBytes(row.checks),
        formatBytes(row.tools),
        formatBytes(row.builds + row.dependencies + row.checks + row.tools),
      ]);
    if (project.rows.length > 1) {
      separators.push({ after: table.length - 1, from: 1 });
      table.push([
        "",
        "Project total",
        "",
        formatBytes(project.builds),
        formatBytes(project.dependencies),
        formatBytes(project.checks),
        formatBytes(project.tools),
        formatBytes(project.builds + project.dependencies + project.checks + project.tools),
      ]);
    }
    separators.push({ after: table.length - 1 });
  }
  if (projects.length)
    console.log(
      terminalTable(
        ["CHECKOUT", "ROOT", "LOCAL CI TARGET", "BUILDS", "DEPENDENCIES", "CHECKS", "TOOLS", "TOTAL"],
        table,
        { quantities: [3, 4, 5, 6, 7], separators },
      ),
    );
  else if (!["images", "builders"].includes(report.checkout ?? "")) console.log("No owned filesystem caches found.");
  if (projects.length || !["images", "builders"].includes(report.checkout ?? ""))
    console.log(
      `Estimated size: ${formatBytes(builds)} builds; ${formatBytes(dependencies)} installed dependencies; ${formatBytes(checks)} check logs/results; ${formatBytes(tools)} shared tools.`,
    );
  if (report.images?.entries.length) {
    console.log("Local Docker image tags (logical image sizes; reclaimed space unknown):");
    console.log(
      terminalTable(
        ["PROFILE", "TAG", "IMAGE SIZE", "STATUS"],
        report.images.entries.map((entry) => [
          entry.profile,
          imageDisplayTag(entry.reference),
          formatBytes(entry.bytes),
          entry.blockedBy ?? "removable tag",
        ]),
        { quantities: [2] },
      ),
    );
  } else if (report.checkout === "images") console.log("No owned local image tags found.");
  if (report.builders?.entries.length) {
    console.log("Owned Docker builder volumes (separate size estimates):");
    console.log(
      terminalTable(
        ["BUILDER", "SIZE", "STATUS"],
        report.builders.entries.map((entry) => [entry.key, formatBytes(entry.bytes), entry.blockedBy ?? "removable"]),
        { quantities: [1] },
      ),
    );
  } else if (report.checkout === "builders") console.log("No owned Docker builder stores found.");
  printCacheNotices(report);
}

function printCacheNotices(report: CacheReport): void {
  if (report.images?.location === "local" && report.images.entries.length)
    console.log(
      "Image sizes include shared layers; removing tags may not reclaim their full size. Image-tag deletion preserves build cache; select a dedicated BuildKit builder separately to remove its cache.",
    );
  const protectedCount = report.tools?.entries.filter((entry) => entry.protected.length).length ?? 0;
  if (protectedCount)
    console.log(
      `${String(protectedCount)} shared installations are protected; --json lists versions, identities, and protection reasons.`,
    );
  for (const issue of report.tools?.issues ?? []) console.error(`Shared tool inspection: ${issue}`);
  for (const issue of report.builders?.issues ?? []) console.error(`Docker builder inspection: ${issue}`);
  for (const issue of report.images?.issues ?? []) console.error(`Prepared image inspection: ${issue}`);
  for (const entry of report.images?.entries ?? [])
    if (entry.blockedBy) console.log(`Image ${entry.reference}: ${entry.blockedBy}; retained.`);
  for (const entry of report.builders?.entries ?? [])
    if (entry.blockedBy) console.log(`Builder ${entry.key}: ${entry.blockedBy}.`);
  for (const reason of report.retained ?? []) console.log(reason);
  if (
    report.images?.entries.some((entry) => entry.blockedReason === "attached") ||
    report.builders?.entries.some((entry) => entry.blockedBy === "attached to a Docker container") ||
    report.retained?.some((reason) => /(?:referenced by|attached to) a Docker container/.test(reason))
  )
    console.log(
      "Existing Docker containers are preserved, including stopped containers; selecting a BuildKit entry removes only its owned daemon. Inspect with docker ps -a; remove unneeded containers, then rerun cache prune. No option forces removal of other containers.",
    );
}

/** Selection and confirmation precede locking and deletion; cancellation leaves the cache untouched. */
export async function chooseCachePrune(
  report: CacheReport,
  dependencies = false,
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
): Promise<CacheReport | undefined> {
  const candidates = cachePruneCandidates(report, dependencies),
    projects = groupCacheReport(report);
  if (!projects.length) return candidates;
  const model = cachePruneSelection(report, candidates, projects);
  const selected = await chooseItems(
    "Select caches to prune",
    model.items,
    model.initial,
    input,
    output,
    model.confirmation,
  );
  return selected === undefined ? undefined : model.report(selected);
}

export function registerCacheCommands(program: Command, root: string): void {
  const project = () => (hasCollectionProject(root) ? root : undefined);
  const cache = program
    .command("cache")
    .description(
      "Show project caches, prepared images, Tools, and Builders; defaults to this checkout, or all outside a project",
    )
    .option("--all", "Select all checkouts, Tools, and Builders")
    .option("--checkout <path|tools|builders|images>", "Select a checkout or the Tools, Builders, or Images group")
    .option("--registry", "Inspect GHCR prepared images for the current project instead of local caches")
    .option("--json", "Print ownership, locations, installed versions, and file sizes as JSON")
    .action((options: { all?: boolean; checkout?: string; json?: boolean; registry?: boolean }) => {
      const report = inspectCache(project(), options.all, options.checkout, options.registry);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printCacheReport(report);
    });
  cache
    .command("prune")
    .description("Select and confirm cache cleanup in a terminal; otherwise preview until --apply")
    .option("--all", "Select all checkouts, Tools, and Builders")
    .option("--checkout <path|tools|builders|images>", "Select a checkout or the Tools, Builders, or Images group")
    .option("--registry", "Explicitly select GHCR image deletion instead of any local cleanup")
    .option("--dependencies", "Also remove installed project dependencies")
    .option("--apply", "Delete the previewed selection instead of prompting")
    .option("--json", "Print the preview or completed deletion set as JSON")
    .addHelpText(
      "after",
      "\nSelecting a project includes all its roots. Tools groups shared installations by language. Retained results and active commands protect their tools. Selecting results for deletion releases their tool references in the same cleanup. Shared downloads are preserved.\n\nLocal image cleanup removes owned image tags; shared layers and build cache may remain. Selecting a dedicated BuildKit builder also removes its owned daemon and cache volume. Other containers (including stopped containers) protect their referenced images and volumes; inspect with docker ps -a and remove unneeded containers before retrying. --registry deletes GHCR versions instead; it does not force local cleanup.",
    )
    .action(
      async (options: {
        all?: boolean;
        checkout?: string;
        dependencies?: boolean;
        apply?: boolean;
        json?: boolean;
        registry?: boolean;
      }) => {
        if (!options.registry) {
          withToolCacheAdmission(() => {
            inspectToolCacheActivity(true);
          });
          refreshToolReferences();
        }
        let report = inspectCache(project(), options.all, options.checkout, options.registry);
        if (report.images?.location === "registry" && report.images.issues.length && !report.images.entries.length)
          throw new Error(`Cannot inspect registry images: ${report.images.issues.join("; ")}`);
        const interactive = !options.apply && !options.json && terminalAvailable();
        if (interactive) {
          if (report.images?.location === "local" && (report.images.entries.length || report.builders?.entries.length))
            console.log(
              "Local Docker cleanup removes selected image tags and owned builder state. Selecting BuildKit removes its owned daemon and cache; other containers and shared build cache are preserved. Image layers may remain.",
            );
          for (const issue of report.images?.issues ?? []) console.error(`Prepared image inspection: ${issue}`);
          for (const reason of cachePruneCandidates(report, options.dependencies).retained ?? []) console.log(reason);
          const chosen = await chooseCachePrune(report, options.dependencies);
          if (!chosen) {
            console.log("Cancelled; no caches removed.");
            return;
          }
          report = chosen;
        }
        const applied = interactive || (options.apply ?? false);
        const progress = applied && !options.json ? new CachePruneProgress() : undefined;
        const cancellation = applied ? new CheckCancellation("Cache pruning") : undefined;
        const observer: CachePruneObserver | undefined = cancellation
          ? {
              begin: (total) => {
                progress?.begin(total);
                cancellation.checkpoint();
              },
              start: (label) => {
                cancellation.checkpoint();
                progress?.start(label);
              },
              complete: () => progress?.complete(),
            }
          : undefined;
        let result: CacheReport & { applied: boolean };
        try {
          result = { ...(await pruneCache(report, project(), options.dependencies, applied, observer)), applied };
          cancellation?.checkpoint();
        } catch (error) {
          progress?.close(false);
          throw error;
        } finally {
          cancellation?.close();
        }
        progress?.close(true);
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else if (applied) printCacheNotices(result);
        else {
          printCacheReport(result);
          const { description, details } = cachePruneSummary(result);
          console.log(
            result.images?.location === "registry"
              ? `Would delete ${description}; remote sizes are not provided by the registry.`
              : `Would remove ${description}.`,
          );
          for (const detail of details) console.log(detail);
          console.log("Preview only; add --apply to delete the listed caches.");
        }
      },
    );
}
