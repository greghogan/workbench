import { installRepositoryHooks } from "../../git/archive-protection.js";
import { changeTaskQueue } from "../task-queue.js";
import { readWorkGraph } from "./work-plans.js";

import { gitRevision, validateBranch } from "../../git/refs.js";
import { planClaim, readPlanOperations, type StoredPlanOperation } from "./plan-operation-store.js";
import { readDraftGroups, prepareDraftGroups, draftGroupCommands } from "./planning-draft-groups.js";
import { indexPlanningRevision, validatePlanEntries } from "./planning-index.js";

import { existsSync } from "node:fs";

import { gitBytes, writeReviewBlobs, type GitEntry } from "../../git/git-snapshot.js";
import { integrationTarget } from "../../git/integration-target.js";

import { repositoryStatePath, withRepositoryOperation } from "../../git/repository-state.js";

import { editToml } from "../../configuration/toml-edit.js";
import { readBoundedFile } from "../../runtime/file-reads.js";
import { writeAtomic } from "../../runtime/file-publication.mjs";
import { InvalidInput, StateConflict } from "../../runtime/input-errors.js";

import { readConfig } from "../../projects/project-configuration.js";
import { replaceRecordStatus } from "../../records/record-document.js";
import {
  parsePlan,
  withPlanAddedAt,
  planIdentity,
  planContent,
  planDraftRef,
  planBaseRef,
  planRemovalRef,
  planningPaths,
  safePlanFile,
  type PlanIdentity,
} from "./plan-model.js";
import { planningScopes, readPlan, savedPlanTrees, draftPlanIdentities, type PlanView } from "./planning-store.js";
import { planningSettings, type PlanningSettings } from "./planning-settings.js";

import { treeFromEntries, transaction } from "./plan-git.js";
import { planningOperation, checkpointPlans } from "./planning-checkpoint.js";
export { planningOperation, checkpointPlans, recoverPlanningCheckpoint } from "./planning-checkpoint.js";
function draftCommands(
  root: string,
  identity: PlanIdentity,
  entries: ReadonlyMap<string, GitEntry> | undefined,
  current: PlanView | undefined,
): string[] {
  if (!entries) {
    if (!current) throw new InvalidInput("Plan not found");
    return [
      ...(current.draft ? [`delete ${planDraftRef(identity)} ${current.tree}`] : []),
      ...(current.baseTree ? [`delete ${planBaseRef(identity)} ${current.baseTree}`] : []),
      ...(current.branchTree ? [`create ${planRemovalRef(identity)} ${current.branchTree}`] : []),
    ];
  }
  validatePlanEntries(entries);
  const tree = treeFromEntries(root, entries),
    before = current?.draft ? current.tree : undefined,
    updates = [`update ${planDraftRef(identity)} ${tree} ${before ?? "0".repeat(tree.length)}`];
  if (!before && current?.branchTree) updates.push(`create ${planBaseRef(identity)} ${current.branchTree}`);
  return updates;
}
function setDraft(
  root: string,
  identity: PlanIdentity,
  entries: ReadonlyMap<string, GitEntry>,
  current: PlanView | undefined,
): PlanView {
  transaction(root, draftCommands(root, identity, entries, current));
  return readPlan(root, identity);
}
export interface PlanDraftUpdate {
  identity: PlanIdentity;
  expected?: string;
  entries?: ReadonlyMap<string, GitEntry>;
}
/** The caller holds the repository-operation lock until the prepared reference transaction is applied. */
export function preparePlanDraftUpdates(
  root: string,
  changes: readonly PlanDraftUpdate[],
  operation?: string,
  planning?: readonly StoredPlanOperation[],
): string[] {
  if (new Set(changes.map((change) => change.identity.reference)).size !== changes.length)
    throw new InvalidInput("Change each plan only once");
  const scopes = new Set(planningScopes(root).map((scope) => scope.id));
  const operations = planning ?? (changes.length ? readPlanOperations(root) : []);
  const commands = changes.flatMap((change) => {
    const identity = planIdentity(change.identity.scope, change.identity.name);
    if (!scopes.has(identity.scope)) throw new InvalidInput("Unknown plan scope");
    const current = currentPlan(root, identity, change.expected, operation, operations);
    if (current?.conflict)
      throw new StateConflict("Resolve concurrent planning edits before changing their identities");
    return draftCommands(root, identity, change.entries, current);
  });
  return [
    ...commands,
    ...draftGroupCommands(
      root,
      prepareDraftGroups(
        root,
        changes.map((change) => change.identity.reference),
        false,
      ),
    ),
  ];
}
export function publishPlanDraftUpdates(root: string, changes: readonly PlanDraftUpdate[], operation?: string): void {
  mutable(root, (planning) => {
    transaction(root, preparePlanDraftUpdates(root, changes, operation, planning));
  });
}
function currentPlan(
  root: string,
  identity: PlanIdentity,
  expected: string | undefined,
  operation?: string,
  planning?: readonly StoredPlanOperation[],
): PlanView | undefined {
  const claim = planClaim(root, identity.reference, planning);
  if (claim && claim.operation.ref !== operation)
    throw new StateConflict(
      `The implementation copy is authoritative: ${claim.task} in ${claim.operation.operation.checkout}`,
    );
  const saved = savedPlanTrees(root),
    exists = saved.has(identity.reference) || !!gitRevision(root, planDraftRef(identity));
  const view = exists ? readPlan(root, identity, saved) : undefined;
  if (view ? expected !== view.digest : expected !== undefined)
    throw new StateConflict("Plan changed; inspect its current version before saving");
  return view;
}
function mutable<T>(root: string, action: (planning?: readonly StoredPlanOperation[]) => T): T {
  return withRepositoryOperation(
    root,
    (planning) => {
      if (planningOperation(root)?.completed === false)
        throw new StateConflict("Recover the planning checkpoint before editing plans");
      return action(planning);
    },
    "planning",
  );
}
export function configurePlanning(root: string, settings: PlanningSettings): void {
  withRepositoryOperation(
    root,
    () => {
      if (planningOperation(root)?.completed === false)
        throw new StateConflict("Recover the planning checkpoint before changing its settings");
      if (typeof settings.auto_prune !== "boolean") throw new InvalidInput("Planning auto_prune must be boolean");
      if (typeof settings.branch !== "string" || !settings.branch) throw new InvalidInput("Select a planning branch");
      validateBranch(root, settings.branch);
      const target = integrationTarget(root),
        archive = readConfig(root).records?.archive_branch;
      if (settings.branch === target.branch || settings.branch === archive)
        throw new InvalidInput("Planning storage needs a branch separate from integration and archives");
      if (!!settings.remote !== !!settings.remote_branch)
        throw new InvalidInput("Select both the planning remote and its destination branch");
      if (settings.remote) {
        if (!gitBytes(root, ["remote"]).toString().trim().split("\n").includes(settings.remote))
          throw new InvalidInput("Planning remote not found");
        validateBranch(root, settings.remote_branch ?? "");
        if (settings.remote_branch === target.branch || settings.remote_branch === archive)
          throw new InvalidInput("The planning destination cannot be the integration or archive destination");
      }
      const previous = planningSettings(root);
      if (
        previous.branch &&
        previous.branch !== settings.branch &&
        (draftPlanIdentities(root).length ||
          draftPlanIdentities(root, planningPaths.removals).length ||
          savedPlanTrees(root).size)
      )
        throw new StateConflict("Preserve or transfer existing plans before changing their branch");
      const path = repositoryStatePath(root, planningPaths.settings),
        before = existsSync(path) ? readBoundedFile(path, 64 * 1024, "planning settings").toString() : "";
      const data: Record<string, unknown> = {
        auto_prune: settings.auto_prune,
        branch: settings.branch,
        ...(settings.remote ? { remote: settings.remote, remote_branch: settings.remote_branch } : {}),
      };
      const prior = gitRevision(root, `refs/heads/${settings.branch}`);
      if (prior) {
        for (const revision of gitBytes(root, ["rev-list", prior]).toString().trim().split("\n").filter(Boolean))
          indexPlanningRevision(root, revision);
      }
      installRepositoryHooks(root);
      writeAtomic(path, editToml(before, data), 0o600);
    },
    "planning",
  );
}
export interface PlanFile {
  contents: Buffer;
  executable?: boolean;
}
function editedPlanEntries(
  root: string,
  existing: ReadonlyMap<string, GitEntry>,
  contents: string,
  files?: ReadonlyMap<string, PlanFile>,
): Map<string, GitEntry> {
  if (Buffer.byteLength(contents) > 2 * 1024 * 1024) throw new InvalidInput("Plan exceeds the 2 MiB document limit");
  const entries = new Map(existing),
    requests: [string, PlanFile][] = [[planningPaths.document, { contents: Buffer.from(contents) }]];
  if (files) {
    for (const path of entries.keys()) if (path.startsWith(planningPaths.files)) entries.delete(path);
    for (const [path, file] of files) {
      if (!safePlanFile(path)) throw new InvalidInput("Invalid plan supporting-file path");
      requests.push([planningPaths.files + path, file]);
    }
  }
  const objects = writeReviewBlobs(
    root,
    requests.map(([, file]) => file.contents),
  );
  requests.forEach(([path, file], index) => {
    const object = objects[index];
    if (!object) throw new Error("Missing plan object");
    entries.set(path, { mode: file.executable ? "100755" : "100644", oid: object });
  });
  return entries;
}
export function savePlanDraft(
  root: string,
  identity: PlanIdentity,
  contents: string,
  options: { expected?: string; files?: ReadonlyMap<string, PlanFile> } = {},
): PlanView {
  return mutable(root, (planning) => {
    planIdentity(identity.scope, identity.name);
    if (!planningScopes(root).some((scope) => scope.id === identity.scope))
      throw new InvalidInput("Unknown project scope for this plan");
    const current = currentPlan(root, identity, options.expected, undefined, planning);
    return setDraft(
      root,
      identity,
      editedPlanEntries(
        root,
        current?.entries ?? new Map(),
        withPlanAddedAt(contents, current?.contents),
        options.files,
      ),
      current,
    );
  });
}
export function resolvePlanDraft(
  root: string,
  identity: PlanIdentity,
  contents: string,
  expected: string,
  files?: ReadonlyMap<string, PlanFile>,
): PlanView {
  return mutable(root, (planning) => {
    const current = currentPlan(root, identity, expected, undefined, planning);
    if (!current?.draft || !current.conflict) throw new InvalidInput("No conflicting draft needs resolution");
    const entries = editedPlanEntries(root, current.entries, withPlanAddedAt(contents, current.contents), files);
    const tree = treeFromEntries(root, entries),
      updates = [`update ${planDraftRef(identity)} ${tree} ${current.tree}`],
      baseRef = planBaseRef(identity);
    if (current.branchTree)
      updates.push(
        `${current.baseTree ? "update" : "create"} ${baseRef} ${current.branchTree}${current.baseTree ? " " + current.baseTree : ""}`,
      );
    else if (current.baseTree) updates.push(`delete ${baseRef} ${current.baseTree}`);
    transaction(root, updates);
    return readPlan(root, identity);
  });
}
function approvedEntries(root: string, current: PlanView): Map<string, GitEntry> {
  if (current.problem || current.conflict)
    throw new StateConflict(current.problem ?? "Resolve concurrent planning edits before approval");
  const document = parsePlan(current.contents, current.reference);
  if (document.metadata.status === "Canceled")
    throw new InvalidInput("Return the canceled plan to planning before approval");
  const contents = replaceRecordStatus(current.contents, "Approved");
  const objects = writeReviewBlobs(root, [
      Buffer.from(contents),
      Buffer.from(JSON.stringify({ at: new Date().toISOString() }) + "\n"),
    ]),
    body = objects[0],
    receipt = objects[1];
  if (!body || !receipt) throw new Error("Missing approval objects");
  const entries = planContent(current.entries);
  entries.set(planningPaths.document, { mode: "100644", oid: body });
  for (const [path, entry] of [...entries]) entries.set(planningPaths.approved + path, entry);
  entries.set(planningPaths.approval, { mode: "100644", oid: receipt });
  return entries;
}
export function approvePlanDraft(
  root: string,
  identity: PlanIdentity,
  expected: string,
  humanReviewed: boolean,
): PlanView {
  mutable(root, (planning) => {
    if (!humanReviewed) throw new InvalidInput("Human confirmation is required for plan approval");
    const current = currentPlan(root, identity, expected, undefined, planning);
    if (!current) throw new InvalidInput("Plan not found");
    const problem = readWorkGraph(root).byReference.get(identity.reference)?.planning?.problem;
    if (problem) throw new StateConflict(problem);
    if (!current.approval?.current)
      transaction(root, draftCommands(root, identity, approvedEntries(root, current), current));
  });
  if (planningSettings(root).branch) checkpointPlans(root, [identity]);
  changeTaskQueue(root, { action: "add", references: [identity.reference] });
  return readPlan(root, identity);
}

export function disablePlanning(root: string): void {
  withRepositoryOperation(
    root,
    (planning) => {
      if (
        savedPlanTrees(root).size ||
        draftPlanIdentities(root).length ||
        draftPlanIdentities(root, planningPaths.removals).length ||
        readDraftGroups(root).groups.length ||
        (planning ?? readPlanOperations(root)).length
      )
        throw new StateConflict("Checkpoint and preserve existing plans before disabling their storage");
      const settings = planningSettings(root),
        path = repositoryStatePath(root, planningPaths.settings),
        original = existsSync(path) ? readBoundedFile(path, 64 * 1024, "planning settings").toString() : "";
      writeAtomic(path, editToml(original, { auto_prune: settings.auto_prune }), 0o600);
    },
    "planning",
  );
}
