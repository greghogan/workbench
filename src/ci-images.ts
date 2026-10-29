import { acquireRegistryImage } from "../scripts/image-acquisition.mts";
import { mapWork } from "../scripts/work-admission.mjs";
import { processCancellation } from "../scripts/owned-child.mjs";
import { record, string, strings } from "../scripts/values.mjs";
import { imageDigest, RegistryAvailability } from "./image-contract.js";
import { executeCI, CILifecycle } from "../scripts/ci-lifecycle.mjs";
import { offlineProfile, offlineInputs, offlineImageReference } from "./offline-profiles.js";
import { readConfig } from "./project-configuration.js";
import { ciTargets } from "./ci-targets.js";
import { registryImageStatus } from "./registry-images.js";
import { pushCIDestinations } from "./ci-destinations.js";
import type { CIDestination } from "./ci-hosting.js";

import { readAcquiredCIImage, type AcquiredCIImage } from "../scripts/ci-image-contract.mjs";

/** Check the actual image before it can execute, independently of a mutable registry tag. */
export function checkedCIImage(
  value: unknown,
  expected: Pick<AcquiredCIImage, "profile" | "platform" | "inputs" | "reference"> &
    Partial<Pick<AcquiredCIImage, "published">>,
  builder: string,
): AcquiredCIImage {
  const image = record(value, "Invalid CI image inspection"),
    config = record(image.Config, "Missing CI image configuration"),
    labels = record(config.Labels, "Missing prepared-image input labels"),
    architecture = expected.platform === "linux-x64" ? "amd64" : "arm64";
  const id = string(image.Id, "Missing CI image identity");
  if (
    image.Os !== "linux" ||
    image.Architecture !== architecture ||
    !imageDigest.test(id) ||
    labels["org.workbench.inputs"] !== expected.inputs ||
    labels["org.workbench.builder"] !== builder ||
    Object.keys(record(config.Volumes ?? {}, "Invalid image volumes")).length
  )
    throw new Error("CI image identity, native platform, or declared inputs do not match this revision");
  const repository = expected.reference.slice(0, expected.reference.lastIndexOf(":"));
  const published = strings(image.RepoDigests ?? [], "Invalid registry image identities").find((digest) =>
    expected.published
      ? digest === expected.published
      : digest.startsWith(repository + "@") && imageDigest.test(digest.slice(repository.length + 1)),
  );
  if (!published) throw new Error("Acquired CI image has no immutable registry identity");
  return readAcquiredCIImage({ version: 1, ...expected, image: id, ...(published ? { published } : {}) });
}

/** Acquire inputs for a fresh CI gate; standalone preparation retains its own offline verification. */
export function ciImageReference(
  root: string,
  name: string,
  architecture: string,
  destination?: CIDestination,
): string {
  const profile = offlineProfile(root, name);
  return destinationReference(offlineImageReference(root, name, architecture), profile.builder, destination);
}
function destinationReference(
  reference: string,
  builder: "native" | "nix" | "guix",
  destination?: CIDestination,
): string {
  const registry = destination?.registries[builder];
  return registry ? `${registry}:${reference.slice(reference.lastIndexOf(":") + 1)}` : reference;
}

export async function acquireCIImage(
  root: string,
  name: string,
  destination?: CIDestination,
): Promise<AcquiredCIImage> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Prepared CI images require native Linux x64 or ARM64");
  const lifecycle = new CILifecycle();
  try {
    const profile = offlineProfile(root, name),
      inputs = offlineInputs(root, profile),
      reference = ciImageReference(root, name, process.arch, destination);
    await lifecycle.checkpoint();
    if (!profile.offline.registry && !destination?.registries[profile.builder])
      throw new Error("CI requires a configured image registry");
    await acquireRegistryImage(reference, {
      platform: `linux/${process.arch === "x64" ? "amd64" : "arm64"}`,
      profile: name,
    });
    await lifecycle.checkpoint();
    const inspected: unknown = JSON.parse(
      await executeCI("docker", ["image", "inspect", "--format", "{{json .}}", reference], { capture: true }),
    );
    const result = checkedCIImage(
      inspected,
      { profile: name, platform: process.arch === "x64" ? "linux-x64" : "linux-arm64", inputs, reference },
      profile.builder,
    );
    if (offlineInputs(root, offlineProfile(root, name)) !== inputs)
      throw new Error("Prepared-image inputs changed during CI acquisition");
    await lifecycle.checkpoint();
    return result;
  } finally {
    lifecycle.close();
  }
}

/** Inspect only the published manifests required by the configured CI target catalog; never pull or build. */
export async function verifyCIImages(root: string, remote?: string, url?: string): Promise<void> {
  const configured: Partial<Record<string, string>> = readConfig(root).ci?.images ?? {};
  if (!Object.keys(configured).length) return;
  const references = new Map<string, string>();
  const targets = ciTargets(root);
  const selections = new Map<string, { name: string; architecture: string }>();
  for (const target of targets) {
    if (target.os !== "linux" || !["native", "environment"].includes(target.kind)) continue;
    const builder = target.environment === "nix-docker" ? "nix" : target.environment;
    const name = configured[builder];
    if (!name) continue;
    selections.set(`${name}/${target.architecture}`, { name, architecture: target.architecture });
  }
  const destinations = pushCIDestinations(root, remote, url);
  for (const { name, architecture } of selections.values()) {
    const profile = offlineProfile(root, name);
    const base = offlineImageReference(root, name, architecture);
    for (const destination of destinations) {
      if (!profile.offline.registry && !destination?.registries[profile.builder])
        throw new Error(`Prepared CI profile '${name}' requires a published registry image`);
      const reference = destinationReference(base, profile.builder, destination);
      references.set(reference, `${destination ? destination.remote + "/" : ""}${name} (linux-${architecture})`);
    }
  }
  const failures: string[] = [];
  let missing = false;
  const cancellation = processCancellation();
  let results;
  try {
    results = await mapWork(
      [...references],
      { capacity: 4, signal: cancellation.signal },
      async ([reference, label]) => ({
        reference,
        label,
        status: await registryImageStatus(reference, cancellation.signal),
      }),
    );
  } finally {
    cancellation.close();
  }
  for (const { reference, label, status } of results) {
    missing ||= status.state === RegistryAvailability.Missing;
    if (status.state !== RegistryAvailability.Available)
      failures.push(
        `${label}: ${status.state === RegistryAvailability.Missing ? "published image is missing" : `registry availability could not be verified: ${status.detail ?? "registry unavailable"}`}\n  ${reference}`,
      );
  }
  if (failures.length)
    throw new Error(
      `Prepared CI image availability failed:\n${failures.join("\n")}\n${missing ? "Prepare, verify, and publish the missing profiles for their selected architectures. Local foreign execution requires configured binfmt; an explicit native image-preparation workflow is also supported." : "Check registry connectivity, service availability, and authentication; existing images may still be published."} Routine CI does not rebuild prepared images.`,
    );
  console.log(`Published prepared CI images available (${String(references.size)}).`);
}

/** Restore a preparation handoff by immutable registry digest and recheck current input labels. */
export async function restoreCIImage(
  root: string,
  name: string,
  value: unknown,
  destination?: CIDestination,
): Promise<AcquiredCIImage> {
  const lifecycle = new CILifecycle();
  try {
    await lifecycle.checkpoint();
    const expected = readAcquiredCIImage(value);
    const profile = offlineProfile(root, name),
      inputs = offlineInputs(root, profile);
    const reference = ciImageReference(root, name, process.arch, destination);
    if (
      expected.profile !== name ||
      expected.inputs !== inputs ||
      expected.reference !== reference ||
      expected.platform !== `linux-${process.arch}` ||
      !expected.published
    )
      throw new Error("Prepared CI image handoff does not match current inputs");
    await acquireRegistryImage(expected.published, { profile: name });
    await lifecycle.checkpoint();
    const inspected: unknown = JSON.parse(
      await executeCI("docker", ["image", "inspect", "--format", "{{json .}}", expected.published], { capture: true }),
    );
    const actual = checkedCIImage(inspected, expected, profile.builder);
    if (
      actual.image !== expected.image ||
      actual.published !== expected.published ||
      offlineInputs(root, offlineProfile(root, name)) !== inputs
    )
      throw new Error("Transferred CI image differs from verified preparation");
    await lifecycle.checkpoint();
    return actual;
  } finally {
    lifecycle.close();
  }
}
