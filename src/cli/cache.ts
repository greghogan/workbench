import { addBytes, formatBytes } from "../byte-size.js";
import { registerCommand } from "./commands.js";
import { imageDisplayTag } from "../image-contract.js";
import type { Command } from "commander";
import { hasCollectionProject } from "../collections.js";
import { terminalTable } from "../terminal-table.js";
import { chooseItems, terminalAvailable, type TerminalInput, type TerminalOutput } from "../terminal-choice.js";
import { cachePruneSelection, cachePruneSummary } from "../cache-prune-selection.js";
import { refreshToolReferences } from "../tool-references.js";
import { inspectToolCacheActivity, withToolCacheAdmission } from "../tool-cache-lock.js";
import { CachePruneProgress, type CachePruneObserver } from "../cache-prune-progress.js";
import { CheckCancellation } from "../check-cancellation.js";
import { discoverCacheSizesAsync, measureCacheSize } from "../cache-size.js";
import { inspectCache, groupCacheReport, cachePruneCandidates, pruneCache, type CacheReport } from "../build-cache.js";
import { pruneRustCommand } from "../rust-cache-command.js";

interface CacheSelectionOptions {
  all?: boolean;
  checkout?: string;
  json?: boolean;
  registry?: boolean;
  path?: string;
  fresh?: boolean;
}

export function printCacheReport(report: CacheReport): void {
  if (report.images?.location === "registry") {
    console.log("Prepared registry images (registry deletion is separate from local cleanup):");
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
  let builds: number | undefined = 0,
    dependencies: number | undefined = 0,
    checks: number | undefined = 0,
    tools: number | undefined = 0;
  for (const project of projects) {
    builds = addBytes(builds, project.builds);
    dependencies = addBytes(dependencies, project.dependencies);
    checks = addBytes(checks, project.checks);
    tools = addBytes(tools, project.tools);
    for (const [index, row] of project.rows.entries())
      table.push([
        index === 0 ? project.checkout : "",
        row.root,
        row.target,
        formatBytes(row.builds),
        formatBytes(row.dependencies),
        formatBytes(row.checks),
        formatBytes(row.tools),
        formatBytes(addBytes(row.builds, row.dependencies, row.checks, row.tools)),
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
        formatBytes(addBytes(project.builds, project.dependencies, project.checks, project.tools)),
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
  printCacheSizeNotices(report);
  printCacheNotices(report);
}

function printCacheSizeNotices(report: CacheReport): void {
  const measurements = [...report.entries, ...(report.tools?.entries ?? [])].map((entry) => entry.measurement);
  const measuredAt = measurements
    .flatMap((size) => (size?.measuredAt ? [new Date(size.measuredAt).toISOString()] : []))
    .sort();
  const first = measuredAt[0],
    last = measuredAt.at(-1);
  if (first) console.log(`Sizes measured: ${first}${last !== first ? ` to ${last ?? first}` : ""}`);
  if (measurements.some((size) => size && size.state !== "ready"))
    console.log("Some cache sizes are stale or unavailable; use --fresh to measure the selected filesystem caches.");
  for (const size of measurements) if (size?.problem) console.error(`Cache size ${size.directory}: ${size.problem}`);
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
  const selectRoot = (report: CacheReport, path?: string) => {
    if (path === undefined) return report;
    const selected = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
    if (!report.entries.some((entry) => entry.identity.root === selected))
      throw new Error(
        "Select an existing build root shown by workbench cache; shared workspace builds are cleared together",
      );
    return {
      storageRoot: report.storageRoot,
      checkout: report.checkout,
      entries: report.entries.filter((entry) => entry.identity.root === selected),
    };
  };
  const inspect = async (options: CacheSelectionOptions): Promise<CacheReport> => {
    const { value } = await discoverCacheSizesAsync(() =>
      inspectCache(project(), options.all, options.checkout, options.registry),
    );
    const report = selectRoot(value, options.path);
    if (!options.fresh) return report;
    const cancellation = new CheckCancellation("Cache size refresh");
    try {
      for (const entry of [...report.entries, ...(report.tools?.entries ?? [])]) {
        cancellation.checkpoint();
        const previous = entry.measurement ?? { directory: entry.directory, state: "pending" as const };
        const measured = await measureCacheSize(previous, true, cancellation.signal);
        entry.measurement = measured;
        entry.bytes = measured.bytes;
      }
      cancellation.checkpoint();
      return report;
    } catch (error) {
      cancellation.checkpoint();
      throw error;
    } finally {
      cancellation.close();
    }
  };
  const cache = registerCommand(program, "cache")
    .description(
      "Show project caches, prepared images, Tools, and Builders; defaults to this checkout, or all outside a project",
    )
    .option("--all", "Select all checkouts, Tools, and Builders")
    .option("--checkout <path|tools|builders|images>", "Select a checkout or the Tools, Builders, or Images group")
    .option("--registry", "Inspect Prepared registry images for the current project instead of local caches")
    .option("--json", "Print ownership, locations, installed versions, and file sizes as JSON")
    .option("--fresh", "Remeasure selected filesystem caches instead of reusing saved sizes")
    .option("--path <path>", "Select one build root; shared workspace roots are cleared together")
    .action(async (options: CacheSelectionOptions) => {
      const report = await inspect(options);
      if (options.json) console.log(JSON.stringify({ schema_version: 2, ...report }, null, 2));
      else printCacheReport(report);
    });
  cache
    .command("prune")
    .description("Select and confirm cache cleanup in a terminal; otherwise preview until --apply")
    .option("--all", "Select all checkouts, Tools, and Builders")
    .option("--checkout <path|tools|builders|images>", "Select a checkout or the Tools, Builders, or Images group")
    .option("--registry", "Explicitly select registry image deletion instead of any local cleanup")
    .option("--dependencies", "Also remove installed project dependencies")
    .option("--rust", "Selectively prune owned Rust artifacts and incremental sessions using retention settings")
    .option("--path <path>", "Select one build root; shared workspace roots are cleared together")
    .option("--apply", "Delete the previewed selection instead of prompting")
    .option("--json", "Print the preview or completed deletion set as JSON")
    .addHelpText(
      "after",
      "\nSelecting a project includes all its roots. Tools groups shared installations by language. Retained results and active commands protect their tools. Selecting results for deletion releases their tool references in the same cleanup. Shared downloads are preserved.\n\nLocal image cleanup removes owned image tags; shared layers and build cache may remain. Selecting a dedicated BuildKit builder also removes its owned daemon and cache volume. Other containers (including stopped containers) protect their referenced images and volumes; inspect with docker ps -a and remove unneeded containers before retrying. --registry deletes published image versions or tags instead; it does not force local cleanup.",
    )
    .action(
      async (
        options: CacheSelectionOptions & {
          dependencies?: boolean;
          apply?: boolean;
          rust?: boolean;
        },
      ) => {
        if (options.rust) {
          if (options.registry || options.dependencies)
            throw new Error("--rust cannot be combined with --registry or --dependencies");
          await pruneRustCommand(root, options);
          return;
        }
        if (!options.registry) {
          withToolCacheAdmission(() => {
            inspectToolCacheActivity(true);
          });
          refreshToolReferences();
        }
        let report = await inspect({ ...options, fresh: true });
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
          const { value } = await discoverCacheSizesAsync(() =>
            pruneCache({
              report: report,
              root: project(),
              dependencies: options.dependencies,
              apply: applied,
              progress: observer,
            }),
          );
          result = { ...value, applied };
          cancellation?.checkpoint();
        } catch (error) {
          progress?.close(false);
          throw error;
        } finally {
          cancellation?.close();
        }
        progress?.close(true);
        if (options.json) console.log(JSON.stringify({ schema_version: 2, ...result }, null, 2));
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
