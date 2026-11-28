import { projectPaths } from "../projects/project-paths.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBoundedFile } from "../runtime/file-reads.js";
import { userDirectory } from "../storage/storage.js";
import { imageHash, imageDigest, type LocalImageReport } from "./image-contract.js";
import { inspectPreparedImages, prunePreparedImages } from "./prepared-images.js";
import { localImageReferences, preparedImageEvidence } from "./local-images.js";
import { projectRegistrySnapshot, keptCacheAssets } from "../projects/project-registry.js";
import { pruneBuilderCache } from "../storage/builder-cache.js";
import { inspectBuildkitCache } from "./buildkit.js";
import { inspectManagedStorePins } from "../storage/managed-store-pins.js";
import { userConfigValues } from "../configuration/user-config.js";
import { diagnostic, LogLevel, DiagnosticOperation, DiagnosticOutcome } from "../diagnostics/diagnostics.mjs";

/** Current accepted profile receipts retain their images until a verified replacement is activated. */
function acceptedProfiles(report: LocalImageReport, owners: Set<string>, selectedProfiles?: ReadonlySet<string>) {
  const required = new Set<string>();
  const builders = new Set<string>();
  const inputs = new Map<string, string>();
  let complete = true,
    found = false;
  const profiles = new Map(
    report.entries
      .filter((entry) => owners.has(entry.checkout) && (!selectedProfiles || selectedProfiles.has(entry.profile)))
      .map((entry) => [entry.receipt, entry]),
  );
  for (const entry of profiles.values()) {
    const path = entry.receipt;
    if (!existsSync(path)) {
      complete = false;
      continue;
    }
    const value = JSON.parse(readBoundedFile(path, 64 * 1024, "prepared profile").toString("utf8")) as {
      image?: string;
      inputs?: string;
      platform?: string;
      verified?: string;
      version?: number;
      profile?: string;
      builderCaches?: unknown;
    } | null;
    if (
      value?.version !== 1 ||
      value.profile !== entry.profile ||
      typeof value.image !== "string" ||
      !imageDigest.test(value.image) ||
      typeof value.inputs !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.inputs) ||
      typeof value.platform !== "string" ||
      !["linux-x64", "linux-arm64"].includes(value.platform) ||
      value.platform !== entry.platform ||
      !Number.isFinite(Date.parse(value.verified ?? ""))
    )
      throw new Error(`${path}: current prepared image requirements are unavailable`);
    required.add(value.image);
    inputs.set(`${entry.profile}/${value.platform}`, value.inputs);
    found = true;
    if (
      Array.isArray(value.builderCaches) &&
      value.builderCaches.every(
        (key: unknown) => typeof key === "string" && /^workbench-buildkit-[a-f0-9]{24}$/.test(key),
      )
    ) {
      for (const key of value.builderCaches as string[]) builders.add(key);
    } else complete = false;
  }
  return { images: required, inputs, builders: complete && found ? builders : undefined };
}

// Assembly alone cannot prove that another platform's builder store has a working replacement.
const pendingImages = (report: LocalImageReport, root: string) =>
  report.entries.some((entry) => entry.checkout === root && !entry.verified);
const profileKey = ({ profile, platform }: { profile: string; platform?: string }) =>
  JSON.stringify([profile, platform]);

function imagePruneInventory(root: string, limit: number): LocalImageReport {
  const empty: LocalImageReport = { location: "local", entries: [], issues: [] };
  if (limit === 0) return empty;
  const owned = preparedImageEvidence(empty.issues, root);
  if (empty.issues.length || owned.length <= limit) return empty;
  let listed: ReadonlySet<string>;
  try {
    listed = localImageReferences();
  } catch (error) {
    empty.issues.push(error instanceof Error ? error.message : String(error));
    return empty;
  }
  const counts = new Map<string, number>();
  for (const { record } of owned) {
    if (record.checkout !== root || !listed.has(record.reference)) continue;
    const key = profileKey(record);
    const count = (counts.get(key) ?? 0) + 1;
    if (count > limit) return inspectPreparedImages(undefined, undefined, true, listed);
    counts.set(key, count);
  }
  return empty;
}

async function retireBuildkitGenerations(
  root: string,
  report: LocalImageReport,
  definitions: (architecture?: string) => ReadonlyMap<string, string>,
): Promise<void> {
  if (pendingImages(report, root)) return;
  const expectedDefinitions = (inventory: LocalImageReport) => {
    const platforms = new Set(
      inventory.entries
        .filter((entry) => entry.checkout === root)
        .flatMap((entry) => (entry.platform ? [entry.platform] : [])),
    );
    return new Map(
      [...platforms].flatMap((platform) =>
        [...definitions(platform.slice("linux-".length))].map(
          ([profile, inputs]) => [`${profile}/${platform}`, inputs] as const,
        ),
      ),
    );
  };
  const expected = expectedDefinitions(report);
  const requirements = acceptedProfiles(report, new Set([root]), new Set(definitions().keys()));
  if ([...expected].some(([profile, inputs]) => requirements.inputs.get(profile) !== inputs)) return;
  if (
    !requirements.builders ||
    !report.entries.some(
      (entry) =>
        entry.checkout === root &&
        requirements.images.has(entry.image) &&
        entry.verified &&
        entry.blockedReason !== "changed",
    )
  )
    return;
  const cache = await inspectBuildkitCache(root, undefined, false);
  if (cache.issues.length) throw new Error(`Builder ownership is unavailable: ${cache.issues.join("; ")}`);
  const kept = keptCacheAssets();
  const entries = cache.entries.filter(
    (entry) =>
      entry.checkout === root &&
      entry.receipt &&
      !entry.blockedBy &&
      !kept.has(entry.receipt) &&
      !requirements.builders?.has(entry.key),
  );
  if (!entries.length) return;
  await pruneBuilderCache({ ...cache, entries }, undefined, () => {
    const inventory = inspectPreparedImages(root);
    const planned = expectedDefinitions(inventory);
    const current = acceptedProfiles(inventory, new Set([root]), new Set(definitions().keys()));
    if (
      userConfigValues()["cache.auto_prune"] === false ||
      !current.builders ||
      pendingImages(inspectPreparedImages(root), root) ||
      [...planned].some(([profile, inputs]) => current.inputs.get(profile) !== inputs) ||
      entries.some((entry) => current.builders?.has(entry.key))
    )
      throw new Error("Builder cache requirements changed; automatic cleanup deferred");
  });
  diagnostic(LogLevel.Info, DiagnosticOperation.Command, DiagnosticOutcome.Pruned, {
    command: "automatic builder cache pruning",
    generations: entries.length,
  });
}

export function supersededImages(
  report: LocalImageReport,
  root: string,
  required: Set<string>,
  limit: number,
  held = new Set<string>(),
) {
  if (report.issues.length || limit === 0) return [];
  const blocked = (entry: LocalImageReport["entries"][number]) =>
    !!entry.blockedBy && !(entry.checkout === root && entry.blockedReason === "locked" && held.has(entry.lock));
  const protectedImages = new Set(report.entries.filter(blocked).map((entry) => entry.image));
  const groups = new Map<string, LocalImageReport["entries"]>();
  for (const entry of report.entries) {
    if (entry.checkout !== root || !entry.platform) continue;
    const key = profileKey(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const timestamp = (entry: LocalImageReport["entries"][number]) =>
      Date.parse(entry.verified ?? entry.assembled ?? "");
    const working = group.find(
      (entry) =>
        required.has(entry.image) &&
        Number.isFinite(Date.parse(entry.verified ?? "")) &&
        entry.blockedReason !== "changed",
    );
    if (!working) return [];
    group.sort((a, b) => timestamp(b) - timestamp(a) || a.reference.localeCompare(b.reference));
    return group.filter(
      (entry, index) =>
        index >= limit &&
        !required.has(entry.image) &&
        !protectedImages.has(entry.image) &&
        Number.isFinite(timestamp(entry)) &&
        timestamp(entry) <= Date.parse(working.verified ?? ""),
    );
  });
}

/** Local Docker cache maintenance never deletes registry artifacts or changes a successful preparation outcome. */
export async function autoPrunePreparedImages(
  root: string,
  definitions?: (architecture?: string) => ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  try {
    signal?.throwIfAborted();
    const config = userConfigValues();
    if (
      config["cache.auto_prune"] === false ||
      !existsSync(join(userDirectory("cache"), "prepared-images", imageHash(root)))
    )
      return;
    const projects = projectRegistrySnapshot().projects;
    if (projects.some((project) => !existsSync(join(project.path, projectPaths.projects)))) return;
    const owners = new Set([root, ...projects.map((project) => project.path)]);
    const limit = config["cache.max_image_generations"] as number;
    const report = definitions ? inspectPreparedImages() : imagePruneInventory(root, limit);
    const entries = supersededImages(report, root, acceptedProfiles(report, owners).images, limit);
    if (entries.length)
      await prunePreparedImages({ ...report, entries }, undefined, () => {
        const fresh = inspectPreparedImages();
        const preferences = userConfigValues();
        const currentProjects = projectRegistrySnapshot().projects;
        if (currentProjects.some((project) => !existsSync(join(project.path, projectPaths.projects))))
          throw new Error("Registered image requirements are unavailable; automatic cleanup deferred");
        const currentOwners = new Set([root, ...currentProjects.map((project) => project.path)]);
        const eligible =
          preferences["cache.auto_prune"] === false
            ? []
            : supersededImages(
                fresh,
                root,
                acceptedProfiles(fresh, currentOwners).images,
                preferences["cache.max_image_generations"] as number,
                new Set(entries.map((entry) => entry.lock)),
              );
        if (entries.some((entry) => !eligible.some((candidate) => candidate.key === entry.key)))
          throw new Error("Prepared image requirements changed; automatic cleanup deferred");
      });
    if (entries.length)
      diagnostic(LogLevel.Info, DiagnosticOperation.Command, DiagnosticOutcome.Pruned, {
        command: "automatic prepared image pruning",
        images: entries.length,
      });
    signal?.throwIfAborted();
    if (definitions && userConfigValues()["cache.auto_prune"] !== false)
      await retireBuildkitGenerations(root, report, definitions);
    if (userConfigValues()["cache.auto_prune"] !== false) {
      const pins = await inspectManagedStorePins(root);
      signal?.throwIfAborted();
      const ready = pins.entries.filter((entry) => !entry.blockedBy);
      if (pins.issues.length) throw new Error(`Managed store inspection failed: ${pins.issues.join("; ")}`);
      await pruneBuilderCache({ ...pins, entries: ready }, undefined, () => {
        if (userConfigValues()["cache.auto_prune"] === false) throw new Error("Automatic store cleanup was disabled");
      });
    }
  } catch (error) {
    signal?.throwIfAborted();
    try {
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.Command,
        DiagnosticOutcome.Failed,
        { command: "automatic prepared image pruning" },
        error,
        "automatic image cleanup did not complete",
      );
    } catch {
      /* Maintenance diagnostics cannot change completed checks. */
    }
  }
}
