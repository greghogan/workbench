import { readPlanOperations } from "../tasks/planning/plan-operation-store.js";
import { existsSync } from "node:fs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { record } from "../runtime/values.mjs";
import { join } from "node:path";
import { gitBytes } from "./git-snapshot.js";
import { withCacheLockSync } from "../storage/cache-lock.js";

export function repositoryStatePath(root: string, ...parts: string[]): string {
  return join(
    gitBytes(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim(),
    "workbench",
    ...parts,
  );
}
export function withRepositoryOperation<T>(
  root: string,
  action: () => T,
  kind: "archive" | "integration" | "acquire" | "planning" | "plan-operation" = "archive",
): T {
  return withCacheLockSync(
    repositoryStatePath(root, "record-operation"),
    () => {
      if (kind !== "plan-operation" && kind !== "acquire") {
        const pending = readPlanOperations(root).find((entry) => !entry.operation.completed);
        if (pending)
          throw new StateConflict(
            `The planning ${pending.operation.kind} requires recovery in ${pending.operation.checkout}`,
          );
      }
      for (const other of ["archive", "integration", "planning"] as const) {
        if (other === kind || kind === "acquire") continue;
        const path = repositoryStatePath(root, `${other}-operation.json`);
        if (existsSync(path)) {
          const pending = record(
            JSON.parse(readBoundedFile(path, 16 * 1024 * 1024, "repository operation").toString()) as unknown,
            "Invalid repository operation",
          );
          if (pending.version !== 1 || typeof pending.completed !== "boolean")
            throw new InvalidInput("Invalid repository operation");
          if (!pending.completed)
            throw new StateConflict(
              `The ${other} operation requires recovery${typeof pending.checkout === "string" ? ` in ${pending.checkout}` : " in this repository"}`,
            );
        }
      }
      return action();
    },
    0,
  );
}
