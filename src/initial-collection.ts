import { existsSync } from "node:fs";
import { join } from "node:path";
import { executingToolPin } from "./launcher.js";
import { toolPin } from "./tool-pin.js";
import { git } from "./update-git.js";
import { readText } from "./files.js";
import { collectionOriginals } from "./collection-git.js";
import { collectionFileLimit } from "./collection-files.js";
import type { CollectionPin } from "./collection-schema.js";
import { reviewStatus, ReviewSource, approveReviewFiles } from "./review-service.js";
import { readBoundedFile } from "./file-reads.js";
import { ownedPath } from "./paths.js";
import { InvalidInput, StateConflict } from "./input-errors.js";
import { terminalAvailable } from "./terminal-choice.js";
import { prompt } from "./projects.js";

/** Adopt committed policy, including when the development checkout contains unreviewed edits. */
export function initialCollectionSource(distribution: string) {
  const checkout = existsSync(join(distribution, ".git")) ? distribution : undefined;
  let pin = executingToolPin(distribution);
  if (!pin && checkout) {
    const metadata = JSON.parse(readText(join(distribution, "package.json"))) as {
      repository?: string | { url?: string };
    };
    pin = toolPin({
      repository: typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url,
      revision: git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]).trim(),
    });
  }
  if (!pin)
    throw new InvalidInput(
      "Cannot identify the initial Workbench collection revision. Use a verified Workbench release or Git checkout, or explicitly select --no-workbench-collection.",
    );
  return {
    source: pin.repository.replace(/^git\+/, ""),
    commit: pin.revision,
    ...(checkout ? { fetchFrom: checkout } : {}),
  };
}

export async function confirmCollectionAcceptance(label: string, yes?: boolean): Promise<boolean> {
  if (yes !== undefined) return yes;
  if (!terminalAvailable()) return false;
  return /^(?:y|yes)$/i.test(await prompt(`Accept all ADRs in ${label}?`, "no"));
}

/** One explicit acceptance covers the verified import, never project adaptations or unrelated records. */
export function acceptCollectionAdoption(root: string, pin: CollectionPin): void {
  const original = collectionOriginals(root, pin);
  const prefix = `workbench/collections/${pin.id}/`;
  const changes = reviewStatus(root, ReviewSource.Working).changes.filter((change) => change.path.startsWith(prefix));
  for (const change of changes) {
    const expected = original.files.get(`workbench/${change.path.slice(prefix.length)}`);
    if (
      !expected ||
      !existsSync(ownedPath(root, change.path)) ||
      !readBoundedFile(ownedPath(root, change.path), collectionFileLimit, "initial collection acceptance").equals(
        expected,
      )
    )
      throw new StateConflict(
        "Collection differs from its pinned original; review its project adaptations with workbench review.",
      );
  }
  if (changes.length)
    approveReviewFiles(
      root,
      changes.map(({ path, digest }) => ({ path, digest })),
      true,
      ReviewSource.Working,
    );
}
