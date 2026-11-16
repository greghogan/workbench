import { maintainPlanning } from "./planning-retention.js";
import { gitRevision, validateBranch } from "../../git/refs.js";

import {
  readDraftGroups,
  expandDraftSelection,
  prepareDraftGroups,
  draftGroupCommands,
  decodeDraftGroups,
  type DraftGroups,
} from "./planning-draft-groups.js";
import { indexPlanningRevision, decodePlanScopes } from "./planning-index.js";
import { workspaceSchemaVersion } from "../../projects/project-model.js";
import { combineFailures } from "../../diagnostics/diagnostic-errors.mjs";

import { randomUUID } from "node:crypto";
import { gitBytes, readGitTree, readGitObjects, writeReviewBlobs, type GitEntry } from "../../git/git-snapshot.js";

import { repositoryStatePath, withRepositoryOperation } from "../../git/repository-state.js";
import { publishGitTree, sameGitEntry, type TreeUpdate } from "../../git/tree-publication.js";

import { InvalidInput, StateConflict } from "../../runtime/input-errors.js";
import { record, records, string } from "../../runtime/values.mjs";
import { BoundedState } from "../../storage/bounded-state.js";

import {
  planIdentity,
  parsePlanReference,
  planPrefix,
  planDraftRef,
  planBaseRef,
  planRemovalRef,
  planningPaths,
  safePlanFile,
  type PlanIdentity,
} from "./plan-model.js";
import { planningScopes, readPlan, savedPlanTrees, draftPlanIdentities } from "./planning-store.js";
import { planningSettings } from "./planning-settings.js";

import { oid, treeFromEntries, transaction } from "./plan-git.js";
interface PlanningOperation {
  version: 1;
  id: string;
  branch: string;
  before?: string;
  after: string;
  checkout?: string;
  updates: TreeUpdate[];
  drafts: { reference: string; tree: string; base?: string }[];
  removals: { reference: string; tree: string }[];
  groups: DraftGroups;
  completed: boolean;
}
function operationStore(root: string) {
  return new BoundedState<PlanningOperation | undefined>(
    () => repositoryStatePath(root, planningPaths.operation),
    4 * 1024 * 1024,
    (input) => {
      if (input === undefined) return undefined;
      const data = record(input, "Invalid planning recovery state"),
        branch = string(data.branch, "Missing planning branch");
      validateBranch(root, branch);
      const id = string(data.id, "Missing planning operation ID");
      if (
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
        data.version !== 1 ||
        typeof data.completed !== "boolean" ||
        !Array.isArray(data.updates)
      )
        throw new InvalidInput("Invalid planning recovery state");
      const entry = (value: unknown): GitEntry | undefined => {
        if (value === undefined) return undefined;
        const e = record(value, "Invalid planning file");
        if (!["100644", "100755"].includes(String(e.mode))) throw new InvalidInput("Invalid planning mode");
        return { mode: string(e.mode, "Missing mode"), oid: oid(e.oid) };
      };
      return {
        version: 1,
        id,
        branch,
        ...(data.before === undefined ? {} : { before: oid(data.before) }),
        after: oid(data.after),
        ...(data.checkout === undefined ? {} : { checkout: string(data.checkout, "Invalid planning checkout") }),
        updates: records(data.updates, "Invalid planning files").map((file) => {
          const path = string(file.path, "Missing planning path");
          if (!safePlanFile(path)) throw new InvalidInput("Invalid planning path");
          return { path, before: entry(file.before), after: entry(file.after) };
        }),
        drafts: records(data.drafts, "Invalid planning drafts").map((draft) => {
          const reference = string(draft.reference, "Missing plan reference");
          const identity = /^([^:]+):plan\/(.+)$/.exec(reference);
          if (!identity?.[1] || !identity[2]) throw new InvalidInput("Invalid plan reference");
          planIdentity(identity[1], identity[2]);
          return { reference, tree: oid(draft.tree), ...(draft.base === undefined ? {} : { base: oid(draft.base) }) };
        }),
        groups: (() => {
          const groups = record(data.groups, "Invalid planning edit-group recovery");
          return {
            ...(groups.before === undefined ? {} : { before: oid(groups.before) }),
            ...(groups.after === undefined ? {} : { after: oid(groups.after) }),
            groups: decodeDraftGroups(groups.groups),
          };
        })(),
        removals: records(data.removals, "Invalid planning removals").map((removed) => {
          const reference = string(removed.reference, "Missing removed plan reference");
          const match = /^([^:]+):plan\/(.+)$/.exec(reference);
          if (!match?.[1] || !match[2]) throw new InvalidInput("Invalid removed plan reference");
          planIdentity(match[1], match[2]);
          return { reference, tree: oid(removed.tree) };
        }),
        completed: data.completed,
      };
    },
    () => undefined,
  );
}
export const planningOperation = (root: string): PlanningOperation | undefined => operationStore(root).read();
function checkedOutPlanning(root: string, branch: string): string | undefined {
  const rows = gitBytes(root, ["worktree", "list", "--porcelain", "-z"]).toString().split("\0");
  let checkout: string | undefined;
  for (const row of rows) {
    if (row.startsWith("worktree ")) checkout = row.slice(9);
    if (row === `branch refs/heads/${branch}`) return checkout;
  }
  return undefined;
}
function resumeCheckpoint(root: string, operation: PlanningOperation): string {
  const ref = `refs/heads/${operation.branch}`,
    actual = gitRevision(root, ref);
  if (planningSettings(root).branch !== operation.branch)
    throw new StateConflict("Restore the selected planning branch before recovering its checkpoint");
  const parents = gitBytes(root, ["rev-list", "--parents", "-n", "1", operation.after])
    .toString()
    .trim()
    .split(" ")
    .slice(1);
  if (
    operation.before !== operation.after &&
    JSON.stringify(parents) !== JSON.stringify(operation.before ? [operation.before] : [])
  )
    throw new InvalidInput("Planning recovery history differs from its recorded baseline");
  indexPlanningRevision(root, operation.after);
  if (operation.before) indexPlanningRevision(root, operation.before);
  const before = operation.before ? readGitTree(root, operation.before) : new Map<string, GitEntry>(),
    after = readGitTree(root, operation.after),
    paths = new Set<string>();
  for (const update of operation.updates) {
    if (
      paths.has(update.path) ||
      !sameGitEntry(before.get(update.path), update.before) ||
      !sameGitEntry(after.get(update.path), update.after)
    )
      throw new InvalidInput("Planning recovery files differ from their prepared trees");
    paths.add(update.path);
  }
  for (const path of new Set([...before.keys(), ...after.keys()]))
    if (!sameGitEntry(before.get(path), after.get(path)) && !paths.has(path))
      throw new InvalidInput("Planning recovery omits a changed file");
  if (actual !== operation.before && actual !== operation.after)
    throw new StateConflict("Planning branch changed during checkpoint; preserve both histories before recovery");
  if (actual !== operation.after) {
    if (checkedOutPlanning(root, operation.branch) !== operation.checkout)
      throw new StateConflict(
        "Planning checkouts changed during the checkpoint; restore the recorded checkout arrangement before recovery",
      );
    if (operation.checkout) {
      if (!operation.before) throw new InvalidInput("Cannot replace an unborn planning checkout");
      publishGitTree(operation.checkout, operation.branch, operation.before, operation.after, operation.updates);
    } else
      transaction(root, [`update ${ref} ${operation.after} ${operation.before ?? "0".repeat(operation.after.length)}`]);
  }
  const cleanup = [`verify ${ref} ${operation.after}`];
  for (const draft of operation.drafts) {
    const identity = /^([^:]+):plan\/(.+)$/.exec(draft.reference);
    if (!identity?.[1] || !identity[2]) throw new InvalidInput("Invalid saved draft reference");
    const plan = planIdentity(identity[1], identity[2]);
    const current = gitRevision(root, planDraftRef(plan)),
      base = gitRevision(root, planBaseRef(plan));
    if (current !== undefined && current !== draft.tree)
      throw new StateConflict("A draft changed during checkpoint recovery; preserve the newer edit");
    if (base !== undefined && base !== draft.base)
      throw new StateConflict("The draft baseline changed during checkpoint recovery");
    if (current) cleanup.push(`delete ${planDraftRef(plan)} ${current}`);
    if (base) cleanup.push(`delete ${planBaseRef(plan)} ${base}`);
  }
  for (const removed of operation.removals) {
    const match = /^([^:]+):plan\/(.+)$/.exec(removed.reference);
    if (!match?.[1] || !match[2]) throw new InvalidInput("Invalid removed plan reference");
    const marker = planRemovalRef(planIdentity(match[1], match[2])),
      current = gitRevision(root, marker);
    if (current && current !== removed.tree)
      throw new StateConflict("The removed plan changed during checkpoint recovery");
    if (current) cleanup.push(`delete ${marker} ${current}`);
  }
  transaction(root, [...cleanup, ...draftGroupCommands(root, operation.groups)]);
  operation.completed = true;
  operationStore(root).write(operation);
  releaseCheckpoint(root, operation);
  return operation.after;
}
function releaseCheckpoint(root: string, operation: PlanningOperation): void {
  const anchor = planningPaths.checkpoints + operation.id;
  if (gitRevision(root, anchor)) gitBytes(root, ["update-ref", "-d", anchor, operation.after]);
}
export function recoverPlanningCheckpoint(root: string): string {
  return withRepositoryOperation(
    root,
    () => {
      const operation = planningOperation(root);
      if (!operation) throw new InvalidInput("No planning checkpoint requires recovery");
      if (operation.completed) {
        releaseCheckpoint(root, operation);
        return operation.after;
      }
      return resumeCheckpoint(root, operation);
    },
    "planning",
  );
}
export function checkpointPlans(
  root: string,
  references?: readonly PlanIdentity[],
  options: { message?: string; onRecorded?: () => void } = {},
): string | undefined {
  const result = withRepositoryOperation(
    root,
    () => {
      const pending = planningOperation(root);
      if (pending && !pending.completed)
        throw new StateConflict("Recover the planning checkpoint before creating another");
      if (pending?.completed) releaseCheckpoint(root, pending);
      const settings = planningSettings(root);
      if (!settings.branch) throw new InvalidInput("Enable planning storage before checkpointing");
      const checkout = checkedOutPlanning(root, settings.branch);
      if (checkout && gitBytes(checkout, ["status", "--porcelain=v1", "--untracked-files=all"]).length)
        throw new StateConflict(
          "The planning checkout has uncommitted editor changes; commit or reconcile them with Git before checkpointing CLI/browser drafts",
        );
      const before = gitRevision(root, `refs/heads/${settings.branch}`),
        saved = savedPlanTrees(root),
        requested = references ?? [
          ...new Map(
            [
              ...draftPlanIdentities(root),
              ...draftPlanIdentities(root, planningPaths.removals),
              ...readDraftGroups(root).groups.flat().map(parsePlanReference),
            ].map((identity) => [identity.reference, identity]),
          ).values(),
        ],
        selected = [...expandDraftSelection(root, new Set(requested.map((identity) => identity.reference)))].map(
          (reference) => {
            const match = /^([^:]+):plan\/(.+)$/.exec(reference);
            if (!match?.[1] || !match[2]) throw new InvalidInput("Invalid selected plan");
            return planIdentity(match[1], match[2]);
          },
        ),
        removals = selected.flatMap((identity) => {
          const tree = gitRevision(root, planRemovalRef(identity));
          if (!tree) return [];
          if (saved.get(identity.reference)?.tree !== tree)
            throw new StateConflict(
              `${identity.reference}: the removed plan changed on the planning branch; reconcile its current contents before checkpointing`,
            );
          return [{ reference: identity.reference, tree, identity }];
        }),
        removed = new Set(removals.map((item) => item.reference)),
        draftIds = new Set(draftPlanIdentities(root).map((identity) => identity.reference)),
        grouped = new Set(readDraftGroups(root).groups.flat()),
        views = selected
          .filter((identity) => {
            if (removed.has(identity.reference)) return false;
            if (saved.has(identity.reference) || draftIds.has(identity.reference)) return true;
            if (!grouped.has(identity.reference)) throw new InvalidInput(`Plan not found: ${identity.reference}`);
            return false;
          })
          .map((identity) => readPlan(root, identity, saved))
          .filter((view) => view.draft);
      if (new Set(requested.map((identity) => identity.reference)).size !== requested.length)
        throw new InvalidInput("Select each plan only once");
      if (!views.length && !removals.length) {
        transaction(
          root,
          draftGroupCommands(
            root,
            prepareDraftGroups(
              root,
              selected.map((identity) => identity.reference),
              true,
            ),
          ),
        );
        return before;
      }
      if (views.some((view) => view.problem !== undefined || view.conflict))
        throw new StateConflict(
          views
            .map(
              (view) =>
                view.problem ?? (view.conflict ? `${view.reference}: concurrent planning edits need resolution` : ""),
            )
            .filter(Boolean)
            .join("\n"),
        );
      const original = before ? readGitTree(root, before) : new Map<string, GitEntry>(),
        files = new Map(original);

      for (const removal of removals) {
        const prefix = planPrefix(removal.identity);
        for (const path of files.keys()) if (path.startsWith(prefix)) files.delete(path);
      }
      for (const view of views) {
        const prefix = planPrefix(view);
        for (const path of files.keys()) if (path.startsWith(prefix)) files.delete(path);
        for (const [path, entry] of view.entries) files.set(prefix + path, entry);
      }
      const knownScopes = new Map(planningScopes(root).map((scope) => [scope.id, scope])),
        previousScopes = original.get(planningPaths.scopes);
      if (previousScopes) {
        const bytes = readGitObjects(root, [previousScopes.oid]).get(previousScopes.oid);
        if (!bytes) throw new InvalidInput("Previous planning scopes are unavailable");
        for (const scope of decodePlanScopes(JSON.parse(bytes.toString()) as unknown))
          if (
            !knownScopes.has(scope.id) &&
            [...files.keys()].some((path) => path.startsWith(`${planningPaths.records}${scope.id}/`))
          )
            knownScopes.set(scope.id, scope);
      }
      const scopes = writeReviewBlobs(root, [
        Buffer.from(
          JSON.stringify({ schema_version: workspaceSchemaVersion, scopes: [...knownScopes.values()] }) + "\n",
        ),
      ])[0];
      if (!scopes) throw new Error("Missing planning scopes");
      files.set(planningPaths.scopes, { mode: "100644", oid: scopes });
      const updates = [...new Set([...original.keys(), ...files.keys()])]
        .filter((path) => !sameGitEntry(original.get(path), files.get(path)))
        .map((path) => ({ path, before: original.get(path), after: files.get(path) }));
      const tree = treeFromEntries(root, files),
        after = updates.length
          ? gitBytes(
              root,
              ["commit-tree", tree, ...(before ? ["-p", before] : []), "-F", "-"],
              options.message ?? "chore: checkpoint future plans\n",
            )
              .toString()
              .trim()
          : before;
      if (!after) return undefined;
      const operation: PlanningOperation = {
        version: 1,
        id: randomUUID(),
        branch: settings.branch,
        ...(before ? { before } : {}),
        after,
        ...(checkout ? { checkout } : {}),
        updates,
        drafts: views.map((view) => ({
          reference: view.reference,
          tree: view.tree,
          ...(view.baseTree ? { base: view.baseTree } : {}),
        })),
        removals: removals.map(({ reference, tree }) => ({ reference, tree })),
        groups: prepareDraftGroups(
          root,
          selected.map((identity) => identity.reference),
          true,
        ),
        completed: false,
      };
      const anchor = planningPaths.checkpoints + operation.id;
      gitBytes(root, ["update-ref", anchor, after, "0".repeat(after.length)]);
      try {
        operationStore(root).write(operation);
      } catch (failure) {
        let recorded: PlanningOperation | undefined;
        try {
          recorded = planningOperation(root);
        } catch (verification) {
          throw combineFailures(
            failure,
            verification,
            "Checkpoint publication is uncertain; its recovery reference was retained",
          );
        }
        if (recorded?.id !== operation.id) {
          try {
            gitBytes(root, ["update-ref", "-d", anchor, after]);
          } catch (cleanup) {
            throw combineFailures(failure, cleanup, "Checkpoint recording and recovery-reference cleanup failed");
          }
        }
        throw failure;
      }
      options.onRecorded?.();
      return resumeCheckpoint(root, operation);
    },
    "planning",
  );
  maintainPlanning(root);
  return result;
}
