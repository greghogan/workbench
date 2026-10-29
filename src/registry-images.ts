import { acquireCommand } from "../scripts/network-command.mts";
import { acquisitionReason, AcquisitionReason } from "../scripts/network-retry.mts";
import { ciProcessOwner } from "../scripts/ci-lifecycle.mjs";
import { describeError } from "../scripts/diagnostic-errors.mjs";
import { type ImageBuilder } from "./ci-hosting.js";
import {
  RegistryProvider,
  managedRegistryImages,
  revalidateManagedRegistryImage,
  deleteManagedRegistryImage,
  type RegistryManagement,
} from "./registry-management.js";
import { processCancellation } from "../scripts/owned-child.mjs";
import { existsSync } from "node:fs";
import { readConfig } from "./project-configuration.js";
import { imageReference } from "./container-references.js";
import {
  imageHash as hash,
  imageProfileLock,
  imageProfileMaintenanceLock,
  parsePreparedTag,
  imageProtection,
  type RegistryImageReport,
  RegistryAvailability,
  type RegistryImageEntry,
} from "./image-contract.js";
export async function registryImageStatus(
  reference: string,
  signal?: AbortSignal,
): Promise<{
  state: Exclude<RegistryAvailability, "not configured">;
  detail?: string;
}> {
  if (!imageReference(reference)) throw new Error("Invalid registry image reference");
  try {
    const owner = ciProcessOwner();
    const manifest = JSON.parse(
      await acquireCommand("Inspect registry image", "docker", ["manifest", "inspect", reference], {
        capture: true,
        ...(signal ? { signal } : {}),
        ...(owner ? { owner } : {}),
      }),
    ) as { schemaVersion?: unknown };
    if (manifest.schemaVersion !== 2) throw new Error("Registry returned an unsupported image manifest");
    return { state: RegistryAvailability.Available };
  } catch (error) {
    signal?.throwIfAborted();
    const detail = describeError(error);
    return acquisitionReason(error) === AcquisitionReason.Missing
      ? { state: RegistryAvailability.Missing }
      : { state: RegistryAvailability.Unavailable, detail };
  }
}

function managementFor(root: string, repository: string): RegistryManagement {
  const explicit = readConfig(root).ci?.registry_management?.[repository];
  if (explicit && explicit.provider !== "none") return explicit;
  if (!explicit && repository.startsWith("ghcr.io/")) return { provider: RegistryProvider.GHCR, host: "github.com" };
  throw new Error("Image transport is supported; no registry management capability is configured for this repository");
}

/** Registry inventory is explicit and uses provider CLI authentication, separately from Docker transport. */
export async function inspectRegistryImages(root: string, signal?: AbortSignal): Promise<RegistryImageReport> {
  const owner = signal ? undefined : processCancellation();
  const active = signal ?? owner?.signal;
  if (!active) throw new Error("Registry inventory requires an operation owner");
  try {
    const report: RegistryImageReport = { location: "registry", entries: [], issues: [] };
    const repositories = new Set<string>();
    const config = readConfig(root);
    const declared = [
      ...(config.development?.profiles ?? []).flatMap((profile) =>
        profile.offline?.registry ? [{ name: profile.name, repository: profile.offline.registry }] : [],
      ),
      ...(config.ci?.destinations ?? []).flatMap((destination) =>
        Object.entries(destination.registries).flatMap(([builder, repository]) => {
          const name = config.ci?.images?.[builder as ImageBuilder];
          return name ? [{ name, repository }] : [];
        }),
      ),
    ];
    for (const profile of declared) {
      active.throwIfAborted();
      const repository = profile.repository;
      if (!repository || repositories.has(repository)) continue;
      repositories.add(repository);
      try {
        const management = managementFor(root, repository);
        const images = await managedRegistryImages(repository, management, active);
        for (const version of images) {
          const tags = version.tags;
          if (!tags.some((tag) => parsePreparedTag(tag) !== undefined)) continue;
          report.entries.push({
            key: hash(`${management.provider}/${management.host}/${version.endpoint}`),
            checkout: root,
            profile: profile.name,
            reference: `${repository}:${tags.find((tag) => parsePreparedTag(tag) !== undefined) ?? ""}`,
            image: version.image,
            bytes: 0,
            lock: imageProfileLock(
              root,
              profile.name,
              parsePreparedTag(tags.find((tag) => parsePreparedTag(tag)) ?? "")?.architecture,
            ),
            identity: version.identity,
            endpoint: version.endpoint,
            management,
            tags,
            created: version.created,
            ...imageProtection(
              tags.some((tag) => !parsePreparedTag(tag))
                ? "unrelatedTags"
                : existsSync(`${imageProfileMaintenanceLock(root, profile.name)}.lock`) ||
                    tags.some((tag) => {
                      const parsed = parsePreparedTag(tag);
                      return parsed && existsSync(`${imageProfileLock(root, profile.name, parsed.architecture)}.lock`);
                    })
                  ? "locked"
                  : undefined,
            ),
          });
        }
      } catch (error) {
        active.throwIfAborted();
        report.issues.push(`${repository}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return report;
  } finally {
    owner?.close();
  }
}

export async function revalidateRegistryImage(entry: RegistryImageEntry, signal?: AbortSignal): Promise<void> {
  await revalidateManagedRegistryImage(entry.management, entry.endpoint, entry.identity, signal);
}

export async function deleteRegistryImage(entry: RegistryImageEntry, signal?: AbortSignal): Promise<void> {
  await deleteManagedRegistryImage(entry.management, entry.endpoint, signal);
}
