import { GitSnapshot } from "../git/git-snapshot.js";
import { proposedRecordTrees } from "./staged-records.js";

/** Registrations in either tree retain project records; exports and supporting files are not independent records. */
export function checkRecordRetention(root: string, tree?: string): void {
  const snapshot = new GitSnapshot(root, tree ? { tree } : {});
  const trees = proposedRecordTrees(root, snapshot);
  const after = trees[0],
    before = trees[1];
  if (!before || !after) return;
  for (const path of before.entries.keys())
    if (!after.entries.has(path) && trees.some((tree) => tree.classify(path).primary))
      throw new Error(`retain committed records; change status or supersede instead of deleting ${path}`);
}
