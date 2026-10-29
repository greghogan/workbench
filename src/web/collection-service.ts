import { prepareCollectionReview } from "../collection-service.js";
import type { CollectionPin } from "../collection-schema.js";
import type { GitCollectionOptions } from "../collection-git.js";
import { reconcileCollection, type CollectionReviewPlan } from "../collection-reconcile.js";
import { StateConflict } from "../input-errors.js";
import { contentsDiff } from "./diff.js";
import type { CollectionPreview } from "./protocol.js";

export interface CollectionRequest {
  source: string;
  commit: string;
  collection: string;
  visibility: "public" | "private";
  id?: string;
}
/** Both interfaces use the same validated reconciliation, including its exact publication plan. */
export function previewCollection(root: string, request: CollectionRequest): CollectionPreview {
  let plan: CollectionReviewPlan | undefined;
  reconcileCollection(
    root,
    request.source,
    request satisfies GitCollectionOptions,
    request.id,
    undefined,
    (current) => {
      plan = current;
      return "preview";
    },
  );
  if (!plan) throw new Error("collection preview was not produced");
  return {
    ...plan,
    differences: Object.fromEntries(
      plan.files
        .filter((file) => /\/ADR-[0-9A-Z]+\.md$/.test(file.path) && file.before !== null && file.after !== null)
        .map((file) => [file.path, contentsDiff(file.before ?? "", file.after ?? "", file.path)]),
    ),
  };
}
export function applyCollection(root: string, request: CollectionRequest, expected: string): CollectionPin {
  return reconcileCollection(root, request.source, request, request.id, undefined, (plan) => {
    if (plan.digest !== expected)
      throw new StateConflict("collection proposal changed; prepare and review a fresh preview");
    return undefined;
  });
}

export interface CollectionApplication {
  id: string;
  issues: string[];
  omitted: number;
}
/** Applying is distinct from preparation: a later diagnostic never misreports the already applied files as unchanged. */
export async function applyCollectionForReview(
  root: string,
  request: CollectionRequest,
  expected: string,
): Promise<CollectionApplication> {
  const pin = applyCollection(root, request, expected);
  return { id: pin.id, ...(await prepareCollectionReview(root)) };
}
