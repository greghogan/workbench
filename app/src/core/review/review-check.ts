import { withRepositoryReads } from "../git/repository-reads.js";
import { GitSnapshot } from "../git/git-snapshot.js";
import { reviewStatus as fileReviewStatus, ReviewSource } from "./review-service.js";
import { pendingCommitReviews, stagedMergeReview } from "./review-units.js";

export function checkReview(root: string, tree?: string): void {
  withRepositoryReads(() => {
    const units = pendingCommitReviews(root).filter((unit) => unit.pending > 0);
    if (units.length)
      throw new Error(
        `Retained commits need human review:\n${units.map((unit) => `  ${unit.revision.slice(0, 12)}: ${String(unit.pending)} protected file(s)`).join("\n")}\nUse 'workbench commit reviews' and 'workbench review --commit <revision>'. Arrange discarded checkpoints before review using provisional commits.`,
      );
    const merge = stagedMergeReview(root, tree);
    const comparison =
      merge ?? fileReviewStatus(root, ReviewSource.Staged, new GitSnapshot(root, { ...(tree ? { tree } : {}) }));
    const pending = comparison.changes.filter((change) => !change.approved);
    if (!pending.length) return;
    throw new Error(
      `protected staged changes need human review:\n${pending.map((change) => `  ${change.path}${change.charter ? " (confirm human authorship)" : ""}`).join("\n")}\n${merge ? "Run 'workbench review' in an interactive terminal to compare the staged merge against each parent." : "Review the current files in 'workbench serve' and stage those exact contents, or run 'workbench review' in an interactive terminal to review the proposed commit."}`,
    );
  });
}
