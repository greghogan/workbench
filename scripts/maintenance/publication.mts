import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  MaintenanceProvider,
  MaintenanceState,
  NativeCatalog,
  type NativeArtifactIdentity,
  type MaintenanceTarget,
  type Release,
} from "./contract.mjs";
import { resolveNativeArtifacts, type NativeCatalogs, type ResolvedNativeArtifact } from "./native.mjs";
import type { MaintenanceSources } from "./sources.mjs";
import { isRecord, record, string } from "../values.mjs";

/** Only the proof-absence review date is incidental; all acquisition and verification policy identifies the recipe. */
export function recipeDigest(recipe: Record<string, unknown>): string {
  const value = structuredClone(recipe);
  if (
    isRecord(value.authenticationUnavailable) &&
    typeof value.authenticationUnavailable.checked === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.authenticationUnavailable.checked)
  )
    delete value.authenticationUnavailable.checked;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isRecord(value))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function artifactIdentity(artifact: ResolvedNativeArtifact): NativeArtifactIdentity {
  const { catalog, tool, version, platform, recipe } = artifact;
  return {
    catalog,
    tool,
    version,
    platform,
    filename:
      typeof recipe.url === "string"
        ? basename(new URL(recipe.url).pathname)
        : string(recipe.name, "Missing archive filename"),
    sha256: string(recipe.sha256, "Missing archive digest"),
    recipeSHA256: recipeDigest(recipe),
  };
}
export function publicationChanged(catalogs: NativeCatalogs, release: Release): boolean {
  return (
    release.artifacts?.some((artifact) => {
      const catalog = catalogs.get(artifact.catalog) ?? {};
      const versions =
        artifact.catalog === NativeCatalog.Tools
          ? record(catalog[artifact.tool] ?? {}, "Invalid native tool")
          : catalog;
      const platforms = record(versions[artifact.version] ?? {}, "Invalid native platforms");
      const recipe = platforms[artifact.platform];
      return !isRecord(recipe) || recipeDigest(recipe) !== artifact.recipeSHA256;
    }) ?? false
  );
}

/** Mutable upstream metadata is resolved independently at plan/apply time, then carried to the pure renderer. */
export async function bindPublication(
  catalogs: NativeCatalogs,
  target: MaintenanceTarget,
  value: Release,
  sources?: MaintenanceSources,
): Promise<{ release: Release; artifacts: ResolvedNativeArtifact[] }> {
  const release = structuredClone(value);
  if (!sources) return { release, artifacts: [] }; // Fixture discovery supplies its own complete release contract.
  if (target.provider === MaintenanceProvider.Action)
    release.revision = await sources.tagRevision(target.name, `v${release.version}`);
  const artifacts =
    target.provider === MaintenanceProvider.Tool
      ? await resolveNativeArtifacts(
          catalogs,
          [{ ...target, state: MaintenanceState.Available, selected: release }],
          sources,
        )
      : [];
  if (artifacts.length) release.artifacts = artifacts.map(artifactIdentity);
  return { release, artifacts };
}
export function publicationIdentity(release: Release): unknown {
  return {
    version: release.version,
    reference: release.reference,
    revision: release.revision ?? null,
    integrity: release.integrity ?? null,
    assets: release.artifacts?.length ? [] : [...(release.assets ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    artifacts: [...(release.artifacts ?? [])].sort((a, b) =>
      JSON.stringify([a.catalog, a.tool, a.version, a.platform]).localeCompare(
        JSON.stringify([b.catalog, b.tool, b.version, b.platform]),
      ),
    ),
  };
}
