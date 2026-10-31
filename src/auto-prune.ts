import { discoverCacheSizes } from "./cache-size.js";
import { totalBytes, addBytes } from "./byte-size.js";
import { inspectBuildCache, cachePruneCandidates, pruneBuildCache, type CacheReport } from "./build-cache.js";
import { inspectToolCache, prunableTools, pruneToolCache, type ToolCacheReport } from "./tool-cache.js";
import { inspectToolReferences, refreshToolReferences } from "./tool-references.js";
import { projectRegistrySnapshot } from "./project-registry.js";
import { matchesToolRequirement, type ToolRequirement } from "./tool-requirements.js";
import {
  projectRequirements,
  refreshProjectRequirements,
  type SuccessfulGateEvidence,
} from "./project-requirements.js";
import { userConfigValues } from "./user-config.js";
import { managerOwnershipSnapshot } from "./managed-installations.js";
import { buildPaths } from "./builds.js";
import { readConfig, readLanguageRoots } from "./project-configuration.js";
import { join, relative, sep } from "node:path";
import { readChecks } from "./check-configuration.js";
import { dependencyTargets } from "./dependencies.js";
import { supersededBuilds } from "./build-retention.js";
import { autoPrunePreparedImages } from "./image-retention.js";
import { withConfigurationSnapshot } from "./configuration-snapshot.js";
import { LogLevel, DiagnosticOperation, DiagnosticOutcome, diagnostic } from "./diagnostics.js";

function newerPatch(newer: string, older: string): boolean {
  const a = newer.split("."),
    b = older.split(".");
  return (
    a.length >= 3 &&
    a.length === b.length &&
    a.slice(0, -1).join(".") === b.slice(0, -1).join(".") &&
    /^\d+$/.test(a.at(-1) ?? "") &&
    /^\d+$/.test(b.at(-1) ?? "") &&
    newer.localeCompare(older, undefined, { numeric: true }) > 0
  );
}
/** Pure selection: working replacements permit patch upgrades and bounded build retention. */
export function planAutoPrune(evidence: {
  root: string;
  platform: string;
  requirements: ToolRequirement[];
  working: ToolRequirement[];
  allWorking: ToolRequirement[];
  kept: Set<string>;
  references: ReturnType<typeof inspectToolReferences>;
  reports: CacheReport[];
  tools: ToolCacheReport;
  managerOwned: Set<string>;
  current?: Set<string>;
  retention?: { maxGenerations: number; maxAgeDays: number; now: number };
}) {
  const { root, requirements, working, allWorking, kept, references, tools } = evidence;
  if (references.issues.length || tools.issues.length) return { reports: [], tools: { ...tools, entries: [] } };
  const byDirectory = new Map(
    references.results.filter((entry) => entry.identity.checkout === root).map((entry) => [entry.directory, entry]),
  );
  const superseded = evidence.retention
    ? supersededBuilds(references, evidence.current ?? new Set(), evidence.retention, evidence.retention.now)
    : new Set<string>();
  const reports = evidence.reports.map((report) => ({
    ...report,
    entries: report.entries.filter((entry) => {
      if (byDirectory.get(entry.directory)?.platform !== evidence.platform) return false;
      if (kept.has(entry.directory)) return false;
      if (evidence.current?.has(entry.directory)) return false;
      if (superseded.has(entry.directory)) return true;
      const obsolete =
        byDirectory
          .get(entry.directory)
          ?.tools.filter(
            (tool) =>
              !requirements.some(
                (current) =>
                  current.tool === tool.tool &&
                  current.version === tool.version &&
                  current.directory === tool.directory,
              ),
          ) ?? [];
      return (
        obsolete.length > 0 &&
        obsolete.every((tool) =>
          working.some(
            (replacement) => replacement.tool === tool.tool && newerPatch(replacement.version, tool.version),
          ),
        )
      );
    }),
  }));
  const released = reports.flatMap((report) =>
    report.entries.filter((entry) => !entry.blockedBy).map((entry) => entry.directory),
  );
  const entries = prunableTools(tools, released).filter(
    (entry) =>
      (entry.provider === "workbench" || evidence.managerOwned.has(entry.directory)) &&
      tools.entries.some(
        (replacement) =>
          replacement.provider === entry.provider &&
          replacement.platform === entry.platform &&
          replacement.tool === entry.tool &&
          newerPatch(replacement.version, entry.version) &&
          allWorking.some((requirement) => matchesToolRequirement(requirement, replacement)),
      ),
  );
  return { reports, tools: { ...tools, entries } };
}
function maintenanceFailure(error: unknown): void {
  try {
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.Command,
      DiagnosticOutcome.Failed,
      { command: "automatic cache maintenance" },
      error,
      "automatic cache cleanup did not complete",
    );
  } catch {
    /* Diagnostic storage failures cannot change a completed quality gate's outcome. */
  }
}
export async function maintainAfterSuccessfulChecks(
  root: string,
  checkedRoot: string,
  evidence: SuccessfulGateEvidence,
  observe?: (event: {
    name: "requirements" | "prune";
    state: "running" | "finished" | "failed" | "skipped";
    durationMs: number;
  }) => void,
): Promise<void> {
  const phase = async (name: "requirements" | "prune", action: () => unknown) => {
    const started = performance.now();
    observe?.({ name, state: "running", durationMs: 0 });
    let outcome: unknown;
    try {
      outcome = await action();
    } catch (error) {
      observe?.({ name, state: "failed", durationMs: performance.now() - started });
      throw error;
    }
    observe?.({
      name,
      state: outcome === "failed" ? "failed" : outcome === "skipped" ? "skipped" : "finished",
      durationMs: performance.now() - started,
    });
  };
  try {
    await phase("requirements", () => {
      refreshProjectRequirements(root, evidence, checkedRoot);
    });
    await phase("prune", () => autoPrune(root));
  } catch (error) {
    maintenanceFailure(error);
  }
}
function retentionProtection(root: string, references: ReturnType<typeof inspectToolReferences>): Set<string> {
  return withConfigurationSnapshot(() => {
    const current = new Set<string>();
    const platform = `${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
    const paths = new Set([
      ...readLanguageRoots(root).map((entry) => entry.path),
      ...readChecks(root).map((entry) => relative(root, entry.directory).replaceAll("\\", "/") || "."),
    ]);
    for (const path of paths) {
      const targets = dependencyTargets(join(root, path));
      for (const reference of references.results)
        if (
          reference.identity.checkout === root &&
          reference.kind === "dependencies" &&
          targets.some((target) => target === reference.directory || target.startsWith(reference.directory + sep))
        )
          current.add(reference.directory);
      const profiles =
        readConfig(root).toolchains?.profiles?.filter(
          (profile) => profile.paths.includes(path) && (!profile.platforms || profile.platforms.includes(platform)),
        ) ?? [];
      for (const toolchain of [false, ...profiles.map((profile) => profile.name)] as const) {
        const paths = buildPaths(root, join(root, path), "native", { toolchain });
        if (paths.external) {
          current.add(paths.directory);
          current.add(paths.dependencies);
        }
      }
    }
    return current;
  });
}

/** Maintenance is independent of the successful gate, including configuration and registry failures. */
export async function autoPrune(root: string): Promise<"skipped" | "finished" | "failed"> {
  try {
    const config = userConfigValues();
    if (config["cache.auto_prune"] === false) return "skipped";
    await autoPrunePreparedImages(root);
    const registry = projectRegistrySnapshot(),
      project = registry.byPath.get(root);
    if (!project?.working?.length || project.requirementError) return "skipped";
    const references = inspectToolReferences();
    if (references.issues.length) return "skipped";
    const working = project.working;
    const current = retentionProtection(root, references);
    const retention = {
      maxGenerations: config["cache.max_generations"] as number,
      maxAgeDays: config["cache.max_age_days"] as number,
    };
    const superseded = supersededBuilds(references, current, retention, Date.now());
    const { value: plan } = discoverCacheSizes(() => {
      const tools = inspectToolCache(root);
      const ownsManagerInstallation = managerOwnershipSnapshot();
      return planAutoPrune({
        root,
        platform: `${process.platform}-${process.arch}`,
        requirements: [...projectRequirements(root), ...working],
        working,
        allWorking: registry.projects.flatMap((entry) => entry.working ?? []),
        kept: registry.kept,
        references,
        tools,
        reports: [
          ...new Set(
            references.results.filter((entry) => entry.identity.checkout === root).map((entry) => entry.storageRoot),
          ),
        ].map((storage) => inspectBuildCache(undefined, false, root, storage)),
        managerOwned: new Set(
          tools.entries
            .filter((entry) => entry.provider !== "workbench" && ownsManagerInstallation(entry))
            .map((entry) => entry.directory),
        ),
        current,
        retention: {
          ...retention,
          now: Date.now(),
        },
      });
    });
    let generations = 0,
      installations = 0,
      bytes: number | undefined = 0;
    for (const report of plan.reports) {
      const removed = await pruneBuildCache({
        report: cachePruneCandidates(report, true),
        dependencies: true,
        apply: true,
        validate: (entries) => {
          const fresh = inspectToolReferences();
          const preferences = userConfigValues();
          if (fresh.issues.length || preferences["cache.auto_prune"] === false)
            throw new Error("Cache references or preferences changed; automatic retention deferred");
          const protectedNow = retentionProtection(root, fresh);
          const eligible = supersededBuilds(
            fresh,
            protectedNow,
            {
              maxGenerations: preferences["cache.max_generations"] as number,
              maxAgeDays: preferences["cache.max_age_days"] as number,
            },
            Date.now(),
          );
          for (const entry of entries)
            if (
              protectedNow.has(entry.directory) ||
              (superseded.has(entry.directory) && !eligible.has(entry.directory))
            )
              throw new Error("Build retention selection changed; automatic cleanup deferred");
        },
      });
      generations += removed.length;
      bytes = addBytes(bytes, totalBytes(removed.map((entry) => entry.bytes)));
    }
    if (plan.tools.entries.length) {
      const removed = await pruneToolCache(plan.tools, root, true);
      installations += removed.length;
      bytes = addBytes(bytes, totalBytes(removed.map((entry) => entry.bytes)));
    }
    if (generations) refreshToolReferences();
    if (generations || installations)
      diagnostic(LogLevel.Info, DiagnosticOperation.Command, DiagnosticOutcome.Pruned, {
        command: "automatic cache pruning",
        generations,
        installations,
        bytes: bytes ?? null,
      });
    return "finished";
  } catch (error) {
    maintenanceFailure(error);
    return "failed";
  }
}
