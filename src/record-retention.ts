import { recordGit, proposedRecordTrees } from "./staged-records.js";

/** Registrations in either tree retain project records; exports and supporting files are not independent records. */
export function checkRecordRetention(root: string): void {
  const removed = recordGit(root, ["diff", "--cached", "--no-renames", "--diff-filter=D", "--name-only", "-z"])
    .toString()
    .split("\0")
    .filter(Boolean);
  if (!removed.length) return;
  const trees = proposedRecordTrees(root);
  for (const path of removed)
    if (trees.some((tree) => tree.classify(path).primary))
      throw new Error(`retain committed records; change status or supersede instead of deleting ${path}`);
}
