import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { gitBytes, readGitTree, type GitEntry } from "../../git/git-snapshot.js";
import { withRepositoryOperation } from "../../git/repository-state.js";
import { InvalidInput, StateConflict } from "../../runtime/input-errors.js";
import { parsePlanReference, type PlanIdentity } from "./plan-model.js";
import { preparePlanDraftUpdates, type PlanDraftUpdate } from "./planning-operations.js";
import { readPlan, readPlans, type PlanView } from "./planning-store.js";
import { planClaim, readPlanOperations, removePlanOperation, writePlanOperation } from "./plan-operation-store.js";
import { rewrittenPlanEntries, updatePlanQueueReferences } from "./plan-updates.js";

export function renamePlan(
  root: string,
  before: PlanIdentity,
  after: PlanIdentity,
  expected: string,
  options: { onRecorded?: () => void; onApplied?: () => void } = {},
): PlanView {
  const stored = withRepositoryOperation(
    root,
    () => {
      if (before.scope !== after.scope || before.reference === after.reference)
        throw new InvalidInput("Rename to a different plan name in the same project scope");
      const views = readPlans(root),
        selected = views.find((view) => view.reference === before.reference);
      if (selected?.digest !== expected) throw new StateConflict("Plan changed; inspect it before renaming");
      if (selected.conflict) throw new StateConflict("Resolve concurrent plan edits before renaming");
      if (views.some((view) => view.reference === after.reference) || planClaim(root, after.reference))
        throw new StateConflict("The new plan name is already in use");
      const mapping = new Map([[before.reference, after.reference]]),
        attachments = new Map<string, GitEntry>(),
        changes: { reference: string; expected?: string; content?: string }[] = [];
      const record = (identity: PlanIdentity, view?: PlanView, entries?: ReadonlyMap<string, GitEntry>) => {
        if (view?.conflict) throw new StateConflict(`Resolve concurrent edits to ${view.reference} before renaming`);
        if (planClaim(root, identity.reference))
          throw new StateConflict(`Edit the implementation task for ${identity.reference}`);
        const index = changes.length;
        if (entries) for (const [path, entry] of entries) attachments.set(`changes/${String(index)}/${path}`, entry);
        changes.push({
          reference: identity.reference,
          ...(view ? { expected: view.digest } : {}),
          ...(entries ? { content: `changes/${String(index)}/` } : {}),
        });
      };
      record(before, selected);
      record(after, undefined, rewrittenPlanEntries(root, selected.entries, mapping) ?? selected.entries);
      for (const view of views) {
        if (view.reference === before.reference) continue;
        const entries = rewrittenPlanEntries(root, view.entries, mapping);
        if (entries) record(view, view, entries);
      }
      return writePlanOperation(
        root,
        {
          version: 1,
          id: randomUUID(),
          kind: "rename",
          checkout: realpathSync.native(root),
          completed: false,
          payload: { before: before.reference, after: after.reference, changes },
        },
        attachments,
      );
    },
    "planning",
  );
  options.onRecorded?.();
  resumePlanRename(root, stored.operation.id, options);
  return readPlan(root, after);
}

export function resumePlanRename(root: string, id: string, options: { onApplied?: () => void } = {}): string {
  return withRepositoryOperation(
    root,
    () => {
      const stored = readPlanOperations(root).find((entry) => entry.operation.id === id);
      if (stored?.operation.kind !== "rename") throw new InvalidInput("Plan rename not found");
      const before = parsePlanReference(stored.operation.payload.before),
        after = parsePlanReference(stored.operation.payload.after);
      const files = readGitTree(root, stored.tree),
        changes = stored.operation.payload.changes.map((change): PlanDraftUpdate => {
          const content = change.content;
          const entries = content
            ? new Map(
                [...files]
                  .filter(([path]) => path.startsWith(content))
                  .map(([path, entry]) => [path.slice(content.length), entry]),
              )
            : undefined;
          return {
            identity: parsePlanReference(change.reference),
            ...(change.expected ? { expected: change.expected } : {}),
            ...(entries ? { entries } : {}),
          };
        });
      const current = new Map(readPlans(root).map((view) => [view.reference, view])),
        applied = changes.every((change) => {
          const view = current.get(change.identity.reference);
          if (!change.entries) return !view;
          return (
            view?.entries.size === change.entries.size &&
            [...change.entries].every(
              ([path, entry]) =>
                view.entries.get(path)?.oid === entry.oid && view.entries.get(path)?.mode === entry.mode,
            )
          );
        });
      if (!applied) {
        const commands = preparePlanDraftUpdates(root, changes, stored.ref);
        gitBytes(
          root,
          ["update-ref", "--create-reflog", "--stdin"],
          `start\n${commands.join("\n")}\nprepare\ncommit\n`,
        );
      }
      options.onApplied?.();
      updatePlanQueueReferences(root, new Map([[before.reference, after.reference]]));
      removePlanOperation(root, stored);
      return after.reference;
    },
    "plan-operation",
  );
}
