import { maintainPlanning } from "./planning-retention.js";
import { realpathSync } from "node:fs";
import { gitRevision } from "../../git/refs.js";
import { gitBytes, readGitTree, readGitObjects } from "../../git/git-snapshot.js";
import { withRepositoryOperation } from "../../git/repository-state.js";
import { StateConflict } from "../../runtime/input-errors.js";
import { taskPlanDigest } from "../task-plan.js";
import { parsePlanReference, planRemovalRef, planDraftRef } from "./plan-model.js";
import { readPlans, savedPlanTrees } from "./planning-store.js";
import { planningSettings } from "./planning-settings.js";
import {
  readPlanOperations,
  planClaim,
  removePlanOperation,
  type StoredPlanOperation,
} from "./plan-operation-store.js";
import { decodeTransfer, type TransferData } from "./plan-transfer.js";
import {
  checkpointPlans,
  preparePlanDraftUpdates,
  planningOperation,
  recoverPlanningCheckpoint,
  type PlanDraftUpdate,
} from "./planning-operations.js";
import { readDraftGroups, prepareDraftGroups, draftGroupCommands } from "./planning-draft-groups.js";
import { rewrittenPlanEntries, updatePlanQueueReferences } from "./plan-updates.js";

function committedTransfer(root: string, data: TransferData, tip: string): boolean {
  if (data.sourceHead && !gitRevision(root, `${data.sourceHead}^{commit}`))
    throw new StateConflict(
      `${data.plans.map((plan) => plan.task).join(", ")}: the recorded implementation base is unavailable; preserve the saved plan for reconciliation`,
    );
  for (const plan of data.plans) {
    // A rebased delivery need not descend from the original base. Its captured plan and files still have to match.
    const commits = gitBytes(root, [
      "--literal-pathspecs",
      "log",
      "--full-history",
      "--reverse",
      "--format=%H",
      "--diff-filter=A",
      data.sourceHead ? `${data.sourceHead}..${tip}` : tip,
      "--",
      plan.path,
    ])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    const commit = commits[0];
    if (!commit) return false;
    if (commits.length > 1)
      throw new StateConflict(`${plan.task}: multiple implementation commits added the task; reconcile its handoff`);
    const files = readGitTree(root, commit),
      entry = files.get(plan.path),
      contents = entry ? readGitObjects(root, [entry.oid]).get(entry.oid) : undefined;
    if (!contents || taskPlanDigest(contents.toString()) !== plan.planDigest)
      throw new StateConflict(
        `${plan.task}: the first implementation commit differs from the transferred plan; reconcile its approval before retiring the saved plan`,
      );
    for (const file of data.files.filter((file) => file.path.startsWith(plan.path.slice(0, -3) + "/"))) {
      const current = files.get(file.path);
      if (current?.oid !== file.oid)
        throw new StateConflict(`${file.path}: verify the changed supporting file before retiring the saved plan`);
      if (current.mode !== file.mode)
        throw new StateConflict(
          `${file.path}: restore the intended executable permission in the first implementation commit before retiring the saved plan`,
        );
    }
  }
  return true;
}
function prepareRetirement(root: string, stored: StoredPlanOperation, data: TransferData): void {
  withRepositoryOperation(
    root,
    () => {
      const pending = readPlanOperations(root).find((entry) => !entry.operation.completed);
      if (pending)
        throw new StateConflict(`Recover the planning ${pending.operation.kind} in ${pending.operation.checkout}`);
      const live = readPlanOperations(root).find((entry) => entry.ref === stored.ref);
      if (live?.tree !== stored.tree) throw new StateConflict("The plan handoff changed during retirement");
      const mapping = new Map(data.plans.map((plan) => [plan.reference, plan.task])),
        remaining = readPlans(root),
        captured = new Map(data.plans.map((plan) => [plan.reference, plan])),
        changes: PlanDraftUpdate[] = [];
      for (const view of remaining) {
        const source = captured.get(view.reference);
        if (source) {
          if (source.tree !== view.tree)
            throw new StateConflict(`${view.reference}: preserve its concurrent edits before retiring it`);
          changes.push({ identity: view, expected: view.digest });
        } else if (!planClaim(root, view.reference)) {
          const entries = rewrittenPlanEntries(root, view.entries, mapping);
          if (entries) changes.push({ identity: view, expected: view.digest, entries });
        }
      }
      const commands = preparePlanDraftUpdates(root, changes, stored.ref);
      if (commands.length)
        gitBytes(
          root,
          ["update-ref", "--create-reflog", "--stdin"],
          `start\n${commands.join("\n")}\nprepare\ncommit\n`,
        );
    },
    "plan-operation",
  );
}
export function finishPlanTransfers(
  root: string,
  revision = "HEAD",
  options: { onPrepared?: () => void } = {},
): string[] {
  const tip = gitRevision(root, `${revision}^{commit}`);
  if (!tip) return [];
  const finished: string[] = [];
  const blocked: string[] = [];
  for (const stored of readPlanOperations(root).filter(
    (entry) =>
      entry.operation.kind === "transfer" &&
      entry.operation.completed &&
      entry.operation.checkout === realpathSync.native(root),
  )) {
    const data = decodeTransfer(root, stored);
    try {
      if (!committedTransfer(root, data, tip)) continue;
    } catch (error) {
      if (!(error instanceof StateConflict)) throw error;
      blocked.push(error.message);
      continue;
    }
    const pending = planningOperation(root);
    if (pending && !pending.completed) recoverPlanningCheckpoint(root);
    updatePlanQueueReferences(root, new Map(data.plans.map((plan) => [plan.reference, plan.task])));
    prepareRetirement(root, stored, data);
    options.onPrepared?.();
    const references = data.plans.map((plan) => parsePlanReference(plan.reference)),
      selected = new Set(references.map((identity) => identity.reference));
    if (planningSettings(root).branch) {
      const saved = savedPlanTrees(root),
        groups = readDraftGroups(root).groups;
      if (
        references.some(
          (identity) =>
            saved.has(identity.reference) ||
            gitRevision(root, planDraftRef(identity)) !== undefined ||
            gitRevision(root, planRemovalRef(identity)) !== undefined,
        ) ||
        groups.some((group) => group.some((reference) => selected.has(reference)))
      )
        checkpointPlans(root, references);
    } else
      withRepositoryOperation(
        root,
        () => {
          const groups = readDraftGroups(root).groups.filter((group) =>
            group.some((reference) => selected.has(reference)),
          );
          if (groups.every((group) => group.every((reference) => selected.has(reference)))) {
            const commands = draftGroupCommands(root, prepareDraftGroups(root, [...selected], true));
            if (commands.length)
              gitBytes(root, ["update-ref", "--stdin"], `start\n${commands.join("\n")}\nprepare\ncommit\n`);
          }
        },
        "plan-operation",
      );
    withRepositoryOperation(
      root,
      () => {
        if (
          data.plans.some(
            (plan) =>
              savedPlanTrees(root).has(plan.reference) ||
              gitRevision(root, planDraftRef(parsePlanReference(plan.reference))) !== undefined ||
              gitRevision(root, planRemovalRef(parsePlanReference(plan.reference))) !== undefined,
          )
        )
          throw new StateConflict("The saved plan retirement is incomplete; recover it before clearing its handoff");
        removePlanOperation(root, stored);
      },
      "plan-operation",
    );
    finished.push(...data.plans.map((plan) => plan.task));
  }
  maintainPlanning(root);
  if (blocked.length) throw new StateConflict(blocked.join("\n"));
  return finished;
}
