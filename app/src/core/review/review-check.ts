import { GitSnapshot } from "../git/git-snapshot.js";
import { reviewStatus as fileReviewStatus, ReviewSource } from "./review-service.js";

export function checkReview(root: string, tree?: string): void {
  const pending = fileReviewStatus(
    root,
    ReviewSource.Staged,
    tree ? new GitSnapshot(root, { tree, review: true }) : undefined,
  ).changes.filter((change) => !change.approved);
  if (!pending.length) return;
  throw new Error(
    `protected staged changes need human review:\n${pending.map((change) => `  ${change.path}${change.charter ? " (confirm human authorship)" : ""}`).join("\n")}\nReview the current files in 'workbench serve' and stage those exact contents, or run 'workbench review' in an interactive terminal to review the proposed commit.`,
  );
}
