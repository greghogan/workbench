import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBoundedFile } from "./file-reads.js";
import { userDirectory } from "./storage.js";
import { imageHash, imageDigest, type LocalImageReport } from "./image-contract.js";
import { inspectPreparedImages, prunePreparedImages } from "./prepared-images.js";
import { projectRegistrySnapshot, keptCacheAssets } from "./project-registry.js";
import { inspectBuilderCache, pruneBuilderCache } from "./builder-cache.js";
import { userConfigValues } from "./user-config.js";
import { diagnostic, LogLevel, DiagnosticOperation, DiagnosticOutcome } from "./diagnostics.js";

/** A private store may release older roots only when all configured profiles have accepted requirements. */
export function retainedBuilderInputs(root: string, profiles: readonly string[]): string[] | undefined {
  try {
    const report = inspectPreparedImages(root);
    if (report.issues.length) return undefined;
    const accepted = acceptedProfiles(report, new Set([root]), new Set(profiles));
    if (profiles.some((profile) => !accepted.profiles.has(profile))) return undefined;
    const kept = keptCacheAssets();
    return [
      ...new Set([
        ...accepted.inputs.values(),
        ...report.entries.flatMap((entry) => (kept.has(entry.catalog) && entry.inputs ? [entry.inputs] : [])),
      ]),
    ];
  } catch {
    return undefined;
  }
}

/** Current accepted profile receipts retain their images until a verified replacement is activated. */
function acceptedProfiles(report: LocalImageReport, owners: Set<string>, selectedProfiles?: ReadonlySet<string>) {
  const required = new Set<string>();
  const builders = new Set<string>();
  const inputs = new Map<string, string>();
  const profileNames = new Set<string>();
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
    profileNames.add(entry.profile);
    found = true;
    if (value.builderCaches === undefined) complete = false;
    else {
      if (
        !Array.isArray(value.builderCaches) ||
        !value.builderCaches.every(
          (key: unknown) => typeof key === "string" && /^(?:workbench-buildkit|guix|nix)-[a-f0-9]{24}$/.test(key),
        )
      )
        throw new Error(`${path}: invalid builder cache requirements`);
      for (const key of value.builderCaches as string[]) builders.add(key);
    }
  }
  return { images: required, inputs, profiles: profileNames, builders: complete && found ? builders : undefined };
}

// Assembly alone cannot prove that another platform's builder store has a working replacement.
const pendingImages = (report: LocalImageReport, root: string) =>
  report.entries.some((entry) => entry.checkout === root && !entry.verified);

async function retireBuilderGenerations(
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
  const cache = await inspectBuilderCache(root, undefined, false);
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
    const key = JSON.stringify([entry.profile, entry.platform]);
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
): Promise<void> {
  try {
    const config = userConfigValues();
    if (
      config["cache.auto_prune"] === false ||
      !existsSync(join(userDirectory("cache"), "prepared-images", imageHash(root)))
    )
      return;
    const projects = projectRegistrySnapshot().projects;
    if (projects.some((project) => !existsSync(join(project.path, "workbench/projects.toml")))) return;
    const owners = new Set([root, ...projects.map((project) => project.path)]);
    const report = inspectPreparedImages();
    const entries = supersededImages(
      report,
      root,
      acceptedProfiles(report, owners).images,
      config["cache.max_image_generations"] as number,
    );
    if (entries.length)
      await prunePreparedImages({ ...report, entries }, undefined, () => {
        const fresh = inspectPreparedImages();
        const preferences = userConfigValues();
        const currentProjects = projectRegistrySnapshot().projects;
        if (currentProjects.some((project) => !existsSync(join(project.path, "workbench/projects.toml"))))
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
    if (definitions && userConfigValues()["cache.auto_prune"] !== false)
      await retireBuilderGenerations(root, report, definitions);
  } catch (error) {
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
