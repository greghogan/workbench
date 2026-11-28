import { browserEvidenceRetentionState, pruneBrowserEvidence } from "./browser-evidence.js";
import { pruneRuntimeCompileCache, runtimeCompileRetentionState } from "./node-compile-cache.js";
import { discoverCacheSizes } from "./cache-size.js";
import { totalBytes, addBytes } from "../runtime/byte-size.js";
import {
  inspectReferencedBuilds,
  buildCacheGroups,
  cachePruneCandidates,
  pruneBuildCache,
  recoverPendingCacheOperations,
  type CacheReport,
} from "./build-cache.js";
import {
  inspectToolCache,
  prunableTools,
  pruneToolCache,
  toolInstallationGroups,
  type ToolCacheReport,
} from "../toolchains/tool-cache.js";
import {
  inspectToolReferences,
  refreshToolReferences,
  toolRetentionReferences,
} from "../toolchains/tool-references.js";
import { projectPathKey, projectRegistrySnapshot } from "../projects/project-registry.js";
import { matchesToolRequirement, type ToolRequirement } from "../toolchains/tool-requirements.js";
import {
  projectRequirements,
  projectRequirementSnapshot,
  refreshProjectRequirements,
  type SuccessfulGateEvidence,
} from "../projects/project-requirements.js";
import { userConfigValues } from "../configuration/user-config.js";
import { managerOwnershipSnapshot } from "../execution/environments/managed-installations.js";
import { buildCheckout, buildPaths, buildStorageSettings, latestCheckResult } from "../artifacts/builds.js";
import { readConfig, readLanguageRoots } from "../projects/project-configuration.js";
import { projectPaths } from "../projects/project-paths.js";
import { join, relative, sep } from "node:path";
import { readChecks } from "../execution/checks/check-configuration.js";
import { dependencyTargets } from "../toolchains/dependencies.js";
import { expiredCheckResults, supersededBuilds } from "./build-retention.js";
import { autoPrunePreparedImages } from "../artifacts/image-retention.js";
import { withConfigurationSnapshot } from "../configuration/configuration-snapshot.js";
import { LogLevel, DiagnosticOperation, DiagnosticOutcome, diagnostic } from "../diagnostics/diagnostics.mjs";
import { pruneRustCache, RustArtifactKind } from "./rust-cache.js";
import { CacheBusy } from "./cache-lock.js";
import { existsSync, lstatSync, readdirSync, statfsSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createHash } from "node:crypto";
import { readBoundedFile } from "../runtime/file-reads.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { ownedPath } from "../runtime/paths.js";
import { cacheOperationsDirectory, inspectCacheOperations } from "./cache-operations.js";
import { cacheGenerationIdentity } from "./cache-plan-identity.js";
import { userDirectory } from "./storage.js";
import { inspectToolCacheActivity } from "../toolchains/tool-cache-lock.js";

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
function replacedTools(tools: ToolRequirement[], requirements: ToolRequirement[], working: ToolRequirement[]): boolean {
  const obsolete = tools.filter(
    (tool) =>
      !requirements.some(
        (current) =>
          current.tool === tool.tool && current.version === tool.version && current.directory === tool.directory,
      ),
  );
  return (
    obsolete.length > 0 &&
    obsolete.every((tool) =>
      working.some((replacement) => replacement.tool === tool.tool && newerPatch(replacement.version, tool.version)),
    )
  );
}

function replacedInstallations(
  tools: ToolCacheReport,
  allWorking: ToolRequirement[],
  reports: CacheReport[],
): ToolCacheReport {
  const ownsInstallation = managerOwnershipSnapshot();
  const released = reports.flatMap((report) =>
    report.entries.filter((entry) => !entry.blockedBy).map((entry) => entry.directory),
  );
  const entries = prunableTools(tools, released).filter(
    (entry) =>
      (entry.provider === "workbench" || ownsInstallation(entry)) &&
      tools.entries.some(
        (replacement) =>
          replacement.provider === entry.provider &&
          replacement.platform === entry.platform &&
          replacement.tool === entry.tool &&
          newerPatch(replacement.version, entry.version) &&
          allWorking.some((requirement) => matchesToolRequirement(requirement, replacement)),
      ),
  );
  return { ...tools, entries };
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
  signal?: AbortSignal,
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
    await phase("prune", () => pruneAfterGate(root, signal, evidence.refreshArtifacts !== false));
  } catch (error) {
    signal?.throwIfAborted();
    maintenanceFailure(error);
  }
}
function fileState(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs] : null;
}

function retentionObservation(root: string) {
  const references = toolRetentionReferences();
  const cacheRoots = [buildStorageSettings(root).root, userDirectory("cache")];
  const stores = (refs: typeof references) =>
    [...new Set([...cacheRoots, ...refs.map((entry) => entry.storageRoot)])].sort();
  const roots = stores(references);
  for (const store of roots) {
    if (!existsSync(store)) continue;
    const disk = statfsSync(store);
    if (disk.bavail * disk.bsize < 2 * 1024 ** 3) return undefined;
  }
  const groups = [
    ...roots.flatMap((store) => buildCacheGroups(store, buildCheckout(root)).map(({ directory }) => directory)),
    ...toolInstallationGroups(),
  ].sort();
  const namespaces: { directory: string; names: string[] }[] = [];
  for (const directory of groups) {
    const operations = join(directory, cacheOperationsDirectory);
    if (existsSync(operations) && readdirSync(operations).length) return undefined;
    const names = readdirSync(directory)
      .filter((name) => name !== cacheOperationsDirectory && name !== latestCheckResult)
      .sort();
    namespaces.push({ directory, names });
  }
  const registry = projectRegistrySnapshot();
  const fixed = [
    Object.entries(userConfigValues()).filter(([name]) => name.startsWith("cache.")),
    browserEvidenceRetentionState(root),
    runtimeCompileRetentionState(),
    fileState(join(userDirectory("state"), "managed-installations.json")),
    [projectPaths.config, projectPaths.projects, projectPaths.automation].map((path) => fileState(join(root, path))),
    inspectToolCacheActivity(),
    [...registry.kept].sort(),
    registry.projects.map(({ path, requirements, working, requirementError }) => [
      path,
      requirements,
      working,
      requirementError,
    ]),
  ];
  const generations = references.map((entry) => ({
    entry,
    identity:
      entry.kind === "builds" &&
      entry.verifiedAt &&
      entry.identity.checkout === root &&
      entry.tools.some(({ tool }) => tool === "rust") &&
      existsSync(entry.directory)
        ? cacheGenerationIdentity(entry.directory)
        : undefined,
  }));
  return (retired?: ReadonlySet<string>) => {
    const remaining = generations.filter(({ entry }) => !retired?.has(entry.directory));
    const names = namespaces.flatMap(({ directory, names }) => {
      const retained = names.filter((name) => !retired?.has(join(directory, name)));
      return retained.length ? [[directory, retained]] : [];
    });
    // Use can postpone age-off, and a change in order can change which generation is protected.
    const order = (field: "lastUsed" | "verifiedAt") =>
      remaining
        .map(({ entry }) => entry)
        .filter((entry) => entry.identity.checkout === root && entry.kind !== "checks" && entry[field] !== undefined)
        .sort((a, b) => Date.parse(b[field] ?? "") - Date.parse(a[field] ?? ""))
        .map(({ directory }) => directory);
    const data = [
      fixed,
      stores(remaining.map(({ entry }) => entry)),
      names,
      order("lastUsed"),
      order("verifiedAt"),
      remaining.map(
        ({ entry: { directory, identity, storageRoot, tools, verifiedAt, platform, kind }, identity: generation }) => [
          directory,
          identity,
          storageRoot,
          tools,
          verifiedAt !== undefined,
          platform,
          kind,
          generation,
        ],
      ),
    ];
    return createHash("sha256").update(JSON.stringify(data)).digest("hex");
  };
}

function currentRetentionReceipt(path: string, key: string, now: number): boolean {
  try {
    const receipt = JSON.parse(readBoundedFile(path, 4096, "automatic retention state").toString()) as {
      key?: unknown;
      observed?: unknown;
      nextScan?: unknown;
    } | null;
    return (
      receipt?.key === key &&
      typeof receipt.observed === "number" &&
      Number.isSafeInteger(receipt.observed) &&
      receipt.observed <= now &&
      (receipt.nextScan === null ||
        (typeof receipt.nextScan === "number" && Number.isFinite(receipt.nextScan) && receipt.nextScan > now))
    );
  } catch {
    return false;
  }
}

export async function pruneAfterGate(
  root: string,
  signal?: AbortSignal,
  refreshArtifacts = true,
): Promise<"skipped" | "finished" | "failed"> {
  signal?.throwIfAborted();
  if (userConfigValues()["cache.auto_prune"] === false) return "skipped";
  // Prepared image and store protection also depends on external managers' live state.
  if (refreshArtifacts) await autoPrunePreparedImages(root, undefined, signal);
  await maintenanceCheckpoint(signal);
  const now = Date.now();
  let observation: ReturnType<typeof retentionObservation>;
  let path: string | undefined;
  try {
    observation = retentionObservation(root);
    if (observation) {
      path = ownedPath(userDirectory("state"), `cache-retention/${projectPathKey(root)}.json`);
      if (currentRetentionReceipt(path, observation(), now)) return "skipped";
    }
  } catch {
    // Unavailable or uncertain observations require the ordinary full retention pass.
    observation = undefined;
  }
  await maintenanceCheckpoint(signal);
  const { outcome, nextScan, retired } = await scanCaches(root, now, signal);
  if (outcome === "finished" && observation && path) {
    try {
      const expected = observation(retired);
      // A cleanup receipt only blesses the measured state and this scan's own deletions.
      if (!retired.size || retentionObservation(root)?.() === expected)
        writeAtomic(
          path,
          JSON.stringify({ key: expected, observed: now, nextScan: nextScan === Infinity ? null : nextScan }) + "\n",
          0o600,
        );
    } catch (error) {
      maintenanceFailure(error);
    }
  }
  return outcome;
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
  await autoPrunePreparedImages(root);
  return (await scanCaches(root, Date.now())).outcome;
}

async function maintenanceCheckpoint(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return;
  await nextTurn();
  signal.throwIfAborted();
}

function retentionCandidates(
  root: string,
  now: number,
  config: ReturnType<typeof userConfigValues>,
  registry: ReturnType<typeof projectRegistrySnapshot>,
  references: ReturnType<typeof inspectToolReferences>,
) {
  const project = registry.atPath(root);
  if (config["cache.auto_prune"] === false || !project || project.requirementError || references.issues.length)
    return undefined;
  const working = project.working ?? [];
  const protectedPaths = new Set([...retentionProtection(root, references), ...registry.kept]);
  const retention = {
    maxGenerations: config["cache.max_generations"] as number,
    maxAgeDays: config["cache.max_age_days"] as number,
  };
  const platform = `${process.platform}-${process.arch}`;
  const projectReferences = {
    ...references,
    results: references.results.filter(
      ({ identity, platform: host }) => identity.checkout === root && host === platform,
    ),
  };
  const builds = supersededBuilds(projectReferences, protectedPaths, retention, now);
  const results = expiredCheckResults(projectReferences, retention.maxAgeDays, now);
  const requirements = [...projectRequirements(root), ...working];
  const candidates = projectReferences.results.filter(
    ({ directory, tools }) =>
      !protectedPaths.has(directory) &&
      (builds.selected.has(directory) ||
        results.selected.has(directory) ||
        replacedTools(tools, requirements, working)),
  );
  return { candidates, nextScan: Math.min(builds.nextScan, results.nextScan) };
}

async function scanCaches(root: string, now: number, signal?: AbortSignal) {
  const retired = new Set<string>();
  const skipped = { outcome: "skipped" as const, nextScan: now, retired };
  try {
    const config = userConfigValues();
    if (config["cache.auto_prune"] === false) return skipped;
    const storageRoot = buildStorageSettings(root).root;
    const stores = new Set([
      storageRoot,
      ...toolRetentionReferences()
        .filter(({ identity }) => identity.checkout === root)
        .map(({ storageRoot }) => storageRoot),
    ]);
    const groups = [...stores].flatMap((store) => buildCacheGroups(store, buildCheckout(root)));
    await recoverPendingCacheOperations({
      storageRoot,
      checkout: root,
      entries: [],
      operations: [...groups.map(({ directory }) => directory), ...toolInstallationGroups()].flatMap(
        inspectCacheOperations,
      ),
    });
    await maintenanceCheckpoint(signal);
    const compileDeadline = await pruneRuntimeCompileCache(config["cache.max_age_days"] as number, now);
    await maintenanceCheckpoint(signal);
    const browserDeadline = await pruneBrowserEvidence(root, now);
    const progress = signal
      ? {
          begin: () => undefined,
          start: () => {
            signal.throwIfAborted();
          },
          complete: () => undefined,
        }
      : undefined;
    const registry = projectRegistrySnapshot();
    const references = inspectToolReferences();
    const selection = retentionCandidates(root, now, config, registry, references);
    if (!selection) return skipped;
    let nextScan = Math.min(compileDeadline, browserDeadline, selection.nextScan);
    const { value: plan } = discoverCacheSizes(() => {
      const tools = inspectToolCache(root, [], {
        registry,
        requirements: projectRequirementSnapshot(registry.projects),
        references,
      });
      if (tools.issues.length) {
        nextScan = now;
        return { reports: [], tools: { ...tools, entries: [] } };
      }
      const reports = inspectReferencedBuilds(selection.candidates);
      return {
        reports,
        tools: replacedInstallations(
          tools,
          registry.projects.flatMap((entry) => entry.working ?? []),
          reports,
        ),
      };
    });
    await recoverPendingCacheOperations({ storageRoot: "", checkout: null, entries: [], tools: plan.tools });
    let generations = 0,
      installations = 0,
      bytes: number | undefined = 0;
    for (const report of plan.reports) {
      await maintenanceCheckpoint(signal);
      const removed = await pruneBuildCache({
        report: cachePruneCandidates(report, true),
        dependencies: true,
        apply: true,
        progress,
        validate: (entries) => {
          const fresh = withConfigurationSnapshot(
            () =>
              retentionCandidates(
                root,
                Date.now(),
                userConfigValues(),
                projectRegistrySnapshot(),
                inspectToolReferences(),
              ),
            { fresh: true },
          );
          const eligible = new Set(fresh?.candidates.map(({ directory }) => directory));
          if (entries.some(({ directory }) => !eligible.has(directory)))
            throw new Error("Cache retention selection changed; automatic cleanup deferred");
        },
      });
      if (removed.length < report.entries.length) nextScan = now;
      for (const entry of removed) retired.add(entry.directory);
      generations += removed.length;
      bytes = addBytes(bytes, totalBytes(removed.map((entry) => entry.bytes)));
    }
    if (plan.tools.entries.length) {
      await maintenanceCheckpoint(signal);
      const removed = await pruneToolCache(plan.tools, root, true, undefined, progress);
      for (const entry of removed) retired.add(entry.directory);
      installations += removed.length;
      bytes = addBytes(bytes, totalBytes(removed.map((entry) => entry.bytes)));
    }
    if (generations) refreshToolReferences();
    let rustFailed = false;
    let rustGroups = 0,
      incrementalSessions = 0;
    for (const reference of (generations ? inspectToolReferences() : references).results) {
      if (config["cache.rust_max_bytes"] === 0 && config["cache.rust_max_age_days"] === 0) break;
      if (
        reference.identity.checkout !== root ||
        reference.kind !== "builds" ||
        reference.platform !== `${process.platform}-${process.arch}` ||
        !reference.verifiedAt ||
        !reference.tools.some((tool) => tool.tool === "rust") ||
        registry.kept.has(reference.directory) ||
        !existsSync(join(reference.directory, "cargo"))
      )
        continue;
      await maintenanceCheckpoint(signal);
      try {
        const result = await pruneRustCache(
          reference,
          {
            maxBytes: config["cache.rust_max_bytes"] as number,
            maxAgeDays: config["cache.rust_max_age_days"] as number,
          },
          {
            apply: true,
            now,
            observeDeadline: (deadline) => {
              nextScan = Math.min(nextScan, deadline);
            },
            validate: () => {
              const fresh = userConfigValues();
              if (
                !fresh["cache.auto_prune"] ||
                fresh["cache.rust_max_bytes"] !== config["cache.rust_max_bytes"] ||
                fresh["cache.rust_max_age_days"] !== config["cache.rust_max_age_days"]
              )
                throw new CacheBusy("Rust cache retention preferences changed; cleanup deferred");
            },
          },
        );
        rustGroups += result.selected.length;
        incrementalSessions += result.selected.filter((group) => group.kind === RustArtifactKind.Incremental).length;
        bytes = addBytes(bytes, totalBytes(result.selected.map((group) => group.bytes)));
      } catch (error) {
        nextScan = now;
        if (!(error instanceof CacheBusy)) {
          rustFailed = true;
          maintenanceFailure(error);
        }
      }
    }
    if (generations || installations || rustGroups)
      diagnostic(LogLevel.Info, DiagnosticOperation.Command, DiagnosticOutcome.Pruned, {
        command: "automatic cache pruning",
        generations,
        installations,
        rustGroups,
        incrementalSessions,
        bytes: bytes ?? null,
      });
    return { outcome: rustFailed ? ("failed" as const) : ("finished" as const), nextScan, retired };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof CacheBusy) return skipped;
    maintenanceFailure(error);
    return { outcome: "failed" as const, nextScan: now, retired };
  }
}
