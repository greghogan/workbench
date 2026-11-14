import { gitBytes } from "./git-snapshot.js";
import { commitVersion, committedReview } from "../review/review-units.js";
import { retainReviewAuthority } from "../review/review-authority.js";
import { reviewPolicy } from "../review/agent-review.js";
import { rewriteCommit } from "./commit-writing.js";
import { publishGitTree } from "./tree-publication.js";
import { StateConflict } from "../runtime/input-errors.js";
import type { BranchIntegration } from "./branch-integration.js";

const text = (root: string, args: string[]) => gitBytes(root, args).toString().trim();
/** New integration contexts stay unpublished until their required evidence covers the resulting snapshots. */
export function prepareIntegrationReview(root: string, operation: BranchIntegration, save: () => void): void {
  if (operation.reviewHistory) {
    const prepared = operation.reviewHistory;
    publishGitTree(root, operation.branch, prepared.before, prepared.after, []);
    return;
  }
  const current = text(root, ["rev-parse", "HEAD"]);
  if (current === operation.before) return;
  const common = text(root, ["merge-base", operation.before, operation.target]),
    previous = text(root, ["rev-list", operation.before, "--not", common]).split("\n").filter(Boolean),
    history = text(root, ["rev-list", "--reverse", "--topo-order", current, "--not", operation.target])
      .split("\n")
      .filter(Boolean);
  if (previous.length > 1000 || history.length > 1000)
    throw new StateConflict("Arrange at most 1000 commits in this integration review set");
  for (const revision of previous) {
    const unit = commitVersion(root, revision);
    if (!unit.provisional && unit.parents[0]) retainReviewAuthority(root, unit.parents[0], revision);
  }
  if (!commitVersion(root, operation.target).provisional) retainReviewAuthority(root, common, operation.target);
  const original = new Set(previous),
    replacements = new Map<string, string>();
  for (const revision of history) {
    const unit = commitVersion(root, revision),
      parents = unit.parents.map((parent) => replacements.get(parent) ?? parent),
      changedParent = parents.some((parent, index) => parent !== unit.parents[index]),
      required =
        reviewPolicy(root, unit.tree).changes ||
        (unit.parents[0] ? reviewPolicy(root, text(root, ["rev-parse", `${unit.parents[0]}^{tree}`])).changes : false);
    if (
      !changedParent &&
      (original.has(revision) || unit.provisional || (!required && committedReview(root, revision).pending === 0))
    ) {
      replacements.set(revision, revision);
      continue;
    }
    const after = rewriteCommit(root, revision, parents, true);
    replacements.set(revision, after);
    gitBytes(root, ["update-ref", `refs/workbench/recovery/${operation.id}/review/${revision}`, after]);
  }
  const after = replacements.get(current) ?? current;
  if (after === current) return;
  operation.reviewHistory = { before: current, after };
  save();
  publishGitTree(root, operation.branch, current, after, []);
}
