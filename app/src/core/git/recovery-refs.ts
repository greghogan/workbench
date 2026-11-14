import { gitBytes } from "./git-snapshot.js";
import { withRepositoryOperation, repositoryOperations } from "./repository-state.js";
import { readPlanOperations } from "../tasks/planning/plan-operation-store.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";

const prefix = "refs/workbench/recovery/";
export function recoveryReferences(root: string): { reference: string; object: string; type: string }[] {
  return gitBytes(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)", prefix])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [reference, object, type] = row.split("\0");
      if (!reference?.startsWith(prefix) || !object || !type) throw new InvalidInput("Invalid recovery reference");
      return { reference, object, type };
    });
}

/** Explicitly release one inspected backup, never an active operation's recovery evidence. */
export function removeRecoveryReference(root: string, reference: string, expected: string): void {
  withRepositoryOperation(
    root,
    () => {
      if (
        repositoryOperations(root).some((operation) => !operation.completed) ||
        readPlanOperations(root).some((entry) => !entry.operation.completed)
      )
        throw new StateConflict("Finish pending repository recovery before removing backups");
      const selected = recoveryReferences(root).find((entry) => entry.reference === reference);
      if (selected?.object !== expected) throw new StateConflict("Recovery reference changed; inspect it again");
      gitBytes(root, ["update-ref", "-d", reference, expected]);
    },
    "acquire",
  );
}
