import { indexPlanningRevision } from "./planning-index.js";

import { existsSync } from "node:fs";

import { gitBytes, writeReviewBlobs, type GitEntry } from "../../git/git-snapshot.js";
import { integrationTarget } from "../../git/integration-target.js";
import { validateBranch } from "../../git/refs.js";
import { repositoryStatePath, withRepositoryOperation } from "../../git/repository-state.js";

import { editToml } from "../../configuration/toml-edit.js";
import { readBoundedFile } from "../../runtime/file-reads.js";
import { writeAtomic } from "../../runtime/file-publication.mjs";
import { InvalidInput, StateConflict } from "../../runtime/input-errors.js";

import { readConfig } from "../../projects/project-configuration.js";

import {
  parsePlan,
  planIdentity,
  planContent,
  planDraftRef,
  planBaseRef,
  planningPaths,
  safePlanFile,
  type PlanIdentity,
} from "./plan-model.js";
import {
  planningSettings,
  planningRevision,
  planningScopes,
  readPlan,
  savedPlanTrees,
  draftPlanIdentities,
  type PlanningSettings,
  type PlanView,
} from "./planning-store.js";

import { treeFromEntries, transaction } from "./plan-git.js";
import { replaceRecordStatus } from "../../records/record-document.js";
import { planningOperation, checkpointPlans } from "./planning-checkpoint.js";
export { planningOperation, checkpointPlans, recoverPlanningCheckpoint } from "./planning-checkpoint.js";
function setDraft(
  root: string,
  identity: PlanIdentity,
  entries: ReadonlyMap<string, GitEntry>,
  current: PlanView | undefined,
): PlanView {
  const tree = treeFromEntries(root, entries),
    ref = planDraftRef(identity),
    before = current?.draft ? current.tree : undefined;
  const updates = [`update ${ref} ${tree} ${before ?? "0".repeat(tree.length)}`];
  if (!before && current?.branchTree) updates.push(`create ${planBaseRef(identity)} ${current.branchTree}`);
  transaction(root, updates);
  return readPlan(root, identity);
}
function currentPlan(root: string, identity: PlanIdentity, expected: string | undefined): PlanView | undefined {
  const saved = savedPlanTrees(root),
    exists = saved.has(identity.reference) || !!planningRevision(root, planDraftRef(identity));
  const view = exists ? readPlan(root, identity, saved) : undefined;
  if (view ? expected !== view.digest : expected !== undefined)
    throw new StateConflict("Plan changed; inspect its current version before saving");
  return view;
}
function mutable(root: string, action: () => PlanView): PlanView {
  return withRepositoryOperation(
    root,
    () => {
      if (planningOperation(root)?.completed === false)
        throw new StateConflict("Recover the planning checkpoint before editing plans");
      return action();
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
        if (
          settings.remote === target.remote &&
          (settings.remote_branch === target.branch || settings.remote_branch === archive)
        )
          throw new InvalidInput("The planning destination cannot be the integration or archive destination");
      }
      const previous = planningSettings(root);
      if (
        previous.branch &&
        previous.branch !== settings.branch &&
        (draftPlanIdentities(root).length || savedPlanTrees(root).size)
      )
        throw new StateConflict("Preserve or transfer existing plans before changing their branch");
      const path = repositoryStatePath(root, planningPaths.settings),
        before = existsSync(path) ? readBoundedFile(path, 64 * 1024, "planning settings").toString() : "";
      const data: Record<string, unknown> = {
        auto_prune: settings.auto_prune,
        branch: settings.branch,
        ...(settings.remote ? { remote: settings.remote, remote_branch: settings.remote_branch } : {}),
      };
      const prior = planningRevision(root, `refs/heads/${settings.branch}`);
      if (prior) {
        for (const revision of gitBytes(root, ["rev-list", prior]).toString().trim().split("\n").filter(Boolean))
          indexPlanningRevision(root, revision);
      }
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
  return mutable(root, () => {
    planIdentity(identity.scope, identity.name);
    if (!planningScopes(root).some((scope) => scope.id === identity.scope))
      throw new InvalidInput("Unknown project scope for this plan");
    const current = currentPlan(root, identity, options.expected);
    return setDraft(
      root,
      identity,
      editedPlanEntries(root, current?.entries ?? new Map(), contents, options.files),
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
  return mutable(root, () => {
    const current = currentPlan(root, identity, expected);
    if (!current?.draft || !current.conflict) throw new InvalidInput("No conflicting draft needs resolution");
    const entries = editedPlanEntries(root, current.entries, contents, files);
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
  mutable(root, () => {
    if (!humanReviewed) throw new InvalidInput("Human confirmation is required for plan approval");
    const current = currentPlan(root, identity, expected);
    if (!current) throw new InvalidInput("Plan not found");
    if (current.approval?.current) return current;
    return setDraft(root, identity, approvedEntries(root, current), current);
  });
  if (planningSettings(root).branch) checkpointPlans(root, [identity]);
  return readPlan(root, identity);
}
