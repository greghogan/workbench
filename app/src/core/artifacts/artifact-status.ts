import type { ArtifactPlanEntry } from "./artifact-catalog.js";
import { inspectFileArtifactStates, type FileArtifactState } from "./artifact-files.js";
import { offlineCandidateReference, offlineImageReference, offlineProfile } from "./offline-profiles.js";
import { parsePreparedTag, RegistryAvailability, type LocalImageEntry } from "./image-contract.js";
import { inspectPreparedImages, registryImageStatus } from "./prepared-images.js";
import { localImageReferences } from "./local-images.js";
import { mapWork } from "../execution/checks/work-admission.mjs";
import { processCancellation } from "../runtime/owned-child.mjs";

interface ArtifactState extends FileArtifactState {
  reference?: string;
  image?: LocalImageEntry;
  registry?: { state: RegistryAvailability; detail?: string };
}

/** Inspect local output ownership once, and only query a registry when explicitly requested. */
export async function inspectArtifactStates(
  root: string,
  rows: readonly ArtifactPlanEntry[],
  options: { registry?: boolean; toolchain?: string } = {},
) {
  const states = new Map<ArtifactPlanEntry, ArtifactState>(
    inspectFileArtifactStates(
      root,
      rows.filter(({ definition }) => !("offlineProfile" in definition)),
      options.toolchain,
    ),
  );
  const selections = rows.flatMap((row) => {
    if (!("offlineProfile" in row.definition)) return [];
    try {
      const profile = offlineProfile(root, row.definition.offlineProfile);
      if (options.toolchain && options.toolchain !== profile.toolchain)
        throw new Error(`Select a recipe configured for toolchain '${options.toolchain}'`);
      const architecture = row.platform === "linux-arm64" ? "arm64" : "x64";
      const reference = offlineImageReference(root, profile.name, architecture);
      const parsed = parsePreparedTag(reference.slice(reference.lastIndexOf(":") + 1));
      if (!parsed) throw new Error("Invalid prepared image identity");
      const candidate = offlineCandidateReference(root, profile.name, parsed.inputs, architecture);
      return [{ row, profile, reference, candidate }];
    } catch (error) {
      states.set(row, { state: "unavailable", detail: error instanceof Error ? error.message : String(error) });
      return [];
    }
  });
  if (!selections.length) return states;
  let references: ReadonlySet<string>;
  let local: ReturnType<typeof inspectPreparedImages>;
  try {
    references = localImageReferences();
    local = inspectPreparedImages(root, undefined, false, references);
  } catch (error) {
    references = new Set();
    local = { location: "local", entries: [], issues: [error instanceof Error ? error.message : String(error)] };
  }
  const measuredAt = new Date().toISOString();
  for (const { row, profile, reference, candidate } of selections) {
    const entries = local.entries.filter(
      (entry) => entry.profile === profile.name && entry.platform === row.platform && entry.blockedReason !== "changed",
    );
    const accepted = entries.find((entry) => entry.reference === reference);
    const current = accepted?.verified
      ? accepted
      : (entries.find((entry) => entry.reference === candidate) ?? accepted);
    const previous = entries.find((entry) => entry.reference !== reference && entry.reference !== candidate);
    if (current)
      states.set(row, { state: current.verified ? "verified" : "unverified", reference, image: current, measuredAt });
    else if (references.has(reference))
      states.set(row, {
        state: "unverified",
        reference,
        detail: "A local image matches this tag. Verify it for this checkout.",
      });
    else if (previous) states.set(row, { state: "outdated", reference, image: previous, measuredAt });
    else if (local.issues.length) states.set(row, { state: "unavailable", reference, detail: local.issues.join("\n") });
    else states.set(row, { state: "missing", reference });
  }
  if (!options.registry) return states;
  const targets = new Map(selections.map(({ profile, reference }) => [reference, profile.offline.registry]));
  const cancellation = processCancellation();
  try {
    const results = new Map(
      await mapWork(
        [...targets],
        { capacity: 4, signal: cancellation.signal },
        async ([reference, registry]) =>
          [
            reference,
            registry
              ? await registryImageStatus(reference, cancellation.signal)
              : { state: RegistryAvailability.NotConfigured },
          ] as const,
      ),
    );
    for (const { row, reference } of selections) {
      const state = states.get(row);
      const registry = results.get(reference);
      if (state && registry) state.registry = registry;
    }
  } finally {
    cancellation.close();
  }
  return states;
}
