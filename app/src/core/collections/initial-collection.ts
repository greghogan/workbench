import { existsSync } from "node:fs";
import { join } from "node:path";
import { executingToolPin } from "../distribution/launcher-identity.js";
import { git } from "../distribution/update-git.js";
import { ReviewSource, approveReviewFiles, reviewStatus } from "../review/review-service.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { readText } from "../runtime/files.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { ownedPath } from "../runtime/paths.js";
import { toolPin } from "../toolchains/tool-pin.js";
import { collectionFileLimit } from "./collection-files.js";
import { collectionOriginals } from "./collection-git.js";
import type { CollectionPin } from "./collection-schema.js";

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
