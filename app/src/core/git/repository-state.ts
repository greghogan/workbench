import { readPlanOperations, type StoredPlanOperation } from "../tasks/planning/plan-operation-store.js";
import { existsSync } from "node:fs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { record } from "../runtime/values.mjs";
import { join } from "node:path";
import { gitBytes } from "./git-snapshot.js";
import { repositoryLocation, withRepositoryReads } from "./repository-reads.js";
import {
  CacheBusy,
  CacheLockState,
  inspectCacheMetadataLock,
  recoverCacheMetadataLock,
  withCacheLockSync,
} from "../storage/cache-lock.js";

export function repositoryStatePath(root: string, ...parts: string[]): string {
  const common = repositoryLocation(root, "--git-common-dir", () =>
    gitBytes(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim(),
  );
  return join(common, "workbench", ...parts);
}
const operationKinds = ["archive", "integration", "planning", "finalization", "disposition", "signing"] as const;
export function repositoryOperations(
  root: string,
): { kind: (typeof operationKinds)[number]; completed: boolean; checkout?: string }[] {
  const directory = repositoryStatePath(root);
  return operationKinds.flatMap((kind) => {
    const path = join(directory, `${kind}-operation.json`);
    if (!existsSync(path)) return [];
    const pending = record(
      JSON.parse(readBoundedFile(path, 16 * 1024 * 1024, "repository operation").toString()) as unknown,
      "Invalid repository operation",
    );
    if (
      pending.version !== 1 ||
      typeof pending.completed !== "boolean" ||
      (pending.checkout !== undefined && typeof pending.checkout !== "string")
    )
      throw new InvalidInput("Invalid repository operation");
    return [
      {
        kind,
        completed: pending.completed,
        ...(typeof pending.checkout === "string" ? { checkout: pending.checkout } : {}),
      },
    ];
  });
}
export function withRepositoryOperation<T>(
  root: string,
  action: (planning?: readonly StoredPlanOperation[]) => T,
  kind:
    | "archive"
    | "integration"
    | "acquire"
    | "planning"
    | "plan-operation"
    | "finalization"
    | "disposition"
    | "signing" = "archive",
): T {
  return withRepositoryReads(() => {
    const path = repositoryStatePath(root, "record-operation");
    const admission = { entered: false };
    try {
      const owner = inspectCacheMetadataLock(path);
      if (owner.state === CacheLockState.Abandoned) {
        try {
          recoverCacheMetadataLock(path, { expected: owner.digest });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return withCacheLockSync(
        path,
        () => {
          admission.entered = true;
          const planning = kind === "plan-operation" || kind === "acquire" ? undefined : readPlanOperations(root);
          const incomplete = planning?.find((entry) => !entry.operation.completed);
          if (incomplete)
            throw new StateConflict(
              `The planning ${incomplete.operation.kind} requires recovery in ${incomplete.operation.checkout}`,
            );
          if (kind !== "acquire")
            for (const pending of repositoryOperations(root))
              if (pending.kind !== kind && !pending.completed)
                throw new StateConflict(
                  `The ${pending.kind} operation requires recovery${pending.checkout ? ` in ${pending.checkout}` : " in this repository"}`,
                );
          return action(planning);
        },
        0,
      );
    } catch (error) {
      if (admission.entered || !(error instanceof CacheBusy)) throw error;
      const { state } = inspectCacheMetadataLock(path);
      const message =
        state === CacheLockState.Active || state === CacheLockState.Unlocked
          ? "Another Workbench history operation is running. Try again in a moment."
          : "Workbench could not recover the repository history lock. Check diagnostics before retrying.";
      throw new StateConflict(message, { cause: error });
    }
  });
}
