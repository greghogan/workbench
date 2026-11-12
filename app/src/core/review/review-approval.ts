import { approveReviewFiles, proposedReview as proposed, reviewChangeDigest } from "./review-service.js";

/** A cooperative acknowledgment, never a claim of authenticated human identity. */
export function approveReview(root: string, expected: string, humanWrittenCharters: boolean): void {
  const { changes, digest } = proposed(root);
  if (!changes.length) throw new Error("no protected staged changes to approve");
  if (expected !== digest) throw new Error("review digest changed; inspect 'workbench review' again");
  approveReviewFiles(
    root,
    changes.map((change) => ({ path: change.path, digest: reviewChangeDigest(change) })),
    humanWrittenCharters,
  );
  console.log("Recorded acknowledgment for the exact protected staged changes.");
}
