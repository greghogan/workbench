import { string } from "../../runtime/values.mjs";
import { InvalidInput } from "../../runtime/input-errors.js";
import { gitBytes, updatedReviewTree, type GitEntry } from "../../git/git-snapshot.js";
export const oid = (value: unknown): string => {
  const result = string(value, "Missing planning revision");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) throw new InvalidInput("Invalid planning revision");
  return result;
};
export function treeFromEntries(root: string, entries: ReadonlyMap<string, GitEntry>): string {
  return updatedReviewTree(
    root,
    "",
    [...entries].map(([path, entry]) => ({ path, entry })),
  );
}
export function transaction(root: string, commands: string[]): void {
  if (commands.length)
    gitBytes(root, ["update-ref", "--create-reflog", "--stdin"], `start\n${commands.join("\n")}\nprepare\ncommit\n`);
}
