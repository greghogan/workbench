import { gitRevision } from "../../git/refs.js";
import { readGitObjects, writeReviewBlobs } from "../../git/git-snapshot.js";
import { InvalidInput, StateConflict } from "../../runtime/input-errors.js";
import { parsePlanReference, planningPaths } from "./plan-model.js";

export interface DraftGroups {
  before?: string;
  after?: string;
  groups: string[][];
}
export function decodeDraftGroups(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length > 10000) throw new InvalidInput("Invalid planning edit groups");
  const seen = new Set<string>();
  return value.map((group: unknown) => {
    if (!Array.isArray(group) || group.length < 2 || group.length > 10000)
      throw new InvalidInput("Invalid planning edit group");
    return group.map((reference: unknown) => {
      if (typeof reference !== "string" || seen.has(reference))
        throw new InvalidInput("Repeated or invalid planning edit group member");
      parsePlanReference(reference);
      seen.add(reference);
      return reference;
    });
  });
}
export function readDraftGroups(root: string): { before?: string; groups: string[][] } {
  const before = gitRevision(root, planningPaths.groups);
  if (!before) return { groups: [] };
  const contents = readGitObjects(root, [before], 2 * 1024 * 1024).get(before);
  if (!contents) throw new InvalidInput("Planning edit groups are unavailable");
  return { before, groups: decodeDraftGroups(JSON.parse(contents.toString()) as unknown) };
}
export function expandDraftSelection(root: string, selected: ReadonlySet<string>): Set<string> {
  const result = new Set(selected);
  for (const group of readDraftGroups(root).groups)
    if (group.some((reference) => selected.has(reference))) for (const reference of group) result.add(reference);
  return result;
}
export function prepareDraftGroups(root: string, references: readonly string[], remove: boolean): DraftGroups {
  const current = readDraftGroups(root),
    selected = new Set(references),
    groups: string[][] = [];
  for (const group of current.groups) {
    if (group.some((reference) => selected.has(reference))) {
      if (remove && group.some((reference) => !selected.has(reference)))
        throw new InvalidInput("Checkpoint related planning edits together");
      if (!remove) for (const reference of group) selected.add(reference);
    } else groups.push(group);
  }
  if (!remove && selected.size > 1) groups.push([...selected].sort());
  groups.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  const after = groups.length ? writeReviewBlobs(root, [Buffer.from(JSON.stringify(groups) + "\n")])[0] : undefined;
  return { ...(current.before ? { before: current.before } : {}), ...(after ? { after } : {}), groups };
}
/** Recreate prepared metadata after interruption, before its CAS publication. */
export function draftGroupCommands(root: string, change: DraftGroups): string[] {
  decodeDraftGroups(change.groups);
  const after = change.groups.length
    ? writeReviewBlobs(root, [Buffer.from(JSON.stringify(change.groups) + "\n")])[0]
    : undefined;
  if (after !== change.after) throw new InvalidInput("Planning group recovery differs from the recorded result");
  const current = gitRevision(root, planningPaths.groups);
  if (current !== change.before && current !== change.after)
    throw new StateConflict("Planning edit groups changed during recovery");
  if (current === change.after) return [];
  return change.after
    ? [`update ${planningPaths.groups} ${change.after} ${current ?? "0".repeat(change.after.length)}`]
    : current
      ? [`delete ${planningPaths.groups} ${current}`]
      : [];
}
