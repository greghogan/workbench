import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MaintenanceProvider, MaintenanceState, type MaintenanceTarget, type Release } from "./contract.mjs";
import { nativeMaintenanceEdits } from "./native.mjs";
import { MaintenanceSources } from "./sources.mjs";

/** Resolve mutable tags and native evidence before the plan is presented for review. */
export async function bindPublication(
  root: string,
  target: MaintenanceTarget,
  value: Release,
  sources?: MaintenanceSources,
): Promise<Release> {
  const release = structuredClone(value);
  if (!sources) return release; // Fixture discovery supplies its own complete release contract.
  if (target.provider === MaintenanceProvider.Action)
    release.revision = await sources.tagRevision(target.name, `v${release.version}`);
  if (target.provider === MaintenanceProvider.Tool && existsSync(join(root, "scripts/native-assets.json"))) {
    const edits = await nativeMaintenanceEdits(
      root,
      [{ ...target, state: MaintenanceState.Available, selected: release }],
      sources,
    );
    release.evidence = edits.map(([path, text]) => ({
      path,
      sha256: createHash("sha256")
        .update(text.replace(/"checked": "\d{4}-\d{2}-\d{2}"/g, '"checked": "reviewed"'))
        .digest("hex"),
    }));
  }
  return release;
}
export function publicationIdentity(release: Release): unknown {
  return {
    version: release.version,
    reference: release.reference,
    revision: release.revision ?? null,
    integrity: release.integrity ?? null,
    assets: [...(release.assets ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    evidence: release.evidence ?? [],
  };
}
