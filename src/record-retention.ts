import { GitSnapshot } from "./git-snapshot.js";
import { recordGit, proposedRecordTrees } from "./staged-records.js";

/** Registrations in either tree retain project records; exports and supporting files are not independent records. */
export function checkRecordRetention(root: string, tree?: string): void {
  const snapshot = tree ? new GitSnapshot(root, { tree }) : undefined;
  const removed = recordGit(root, [
    "diff",
    ...(tree
      ? [snapshot?.head.length ? snapshot.head : recordGit(root, ["mktree"], "").toString().trim(), tree]
      : ["--cached"]),
    "--no-renames",
    "--diff-filter=D",
    "--name-only",
    "-z",
  ])
    .toString()
    .split("\0")
    .filter(Boolean);
  if (!removed.length) return;
  const trees = proposedRecordTrees(root, snapshot);
  for (const path of removed)
    if (trees.some((tree) => tree.classify(path).primary))
      throw new Error(`retain committed records; change status or supersede instead of deleting ${path}`);
}
