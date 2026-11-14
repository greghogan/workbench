import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../../diagnostics/diagnostics.mjs";
import { spawnSync } from "node:child_process";
import { readPlanOperations } from "./plan-operation-store.js";
import { readDraftGroups } from "./planning-draft-groups.js";
import { planningSettings, savedPlanTrees, draftPlanIdentities } from "./planning-store.js";
import { planningPaths } from "./plan-model.js";
import { gitBytes } from "../../git/git-snapshot.js";
import { gitAncestor, gitRevision } from "../../git/refs.js";
import { withRepositoryOperation } from "../../git/repository-state.js";
import { withCacheLocksSync } from "../../storage/cache-lock.js";
import { readTaskQueue, taskQueuePath } from "../task-queue.js";

export function planningCheckouts(root: string): string[] {
  return gitBytes(root, ["worktree", "list", "--porcelain", "-z"])
    .toString()
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice(9));
}
/** Uncertainty retains history. Cleanup never contacts or deletes a remote branch. */
export function pruneEmptyPlanning(root: string): boolean {
  return withRepositoryOperation(
    root,
    () => {
      const settings = planningSettings(root);
      if (!settings.branch || !settings.auto_prune) return false;
      const ref = `refs/heads/${settings.branch}`,
        tip = gitRevision(root, ref);
      if (
        !tip ||
        savedPlanTrees(root).size ||
        draftPlanIdentities(root).length ||
        draftPlanIdentities(root, planningPaths.removals).length ||
        readDraftGroups(root).groups.length ||
        readPlanOperations(root).length
      )
        return false;
      const checkouts = planningCheckouts(root);
      for (const checkout of checkouts) {
        const head = spawnSync("git", ["-C", checkout, "symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8" });
        if (head.error || (head.status !== 0 && head.status !== 1) || head.stdout.trim() === ref) return false;
      }
      if (settings.remote) {
        const specs = spawnSync("git", ["-C", root, "config", "--get-all", `remote.${settings.remote}.fetch`], {
          encoding: "utf8",
        });
        if (specs.error || specs.status !== 0) return false;
        const remoteRef = `refs/heads/${settings.remote_branch ?? ""}`,
          targets = specs.stdout
            .trim()
            .split("\n")
            .flatMap((spec) => {
              const [source, target] = spec.replace(/^\+/, "").split(":");
              if (!source || !target || source.startsWith("^")) return [];
              if (source === remoteRef) return [target];
              const star = source.indexOf("*");
              if (
                star < 0 ||
                !target.includes("*") ||
                !remoteRef.startsWith(source.slice(0, star)) ||
                !remoteRef.endsWith(source.slice(star + 1))
              )
                return [];
              return [target.replace("*", remoteRef.slice(star, remoteRef.length - source.slice(star + 1).length))];
            });
        if (
          !targets.some((target) => {
            const backedUp = gitRevision(root, target);
            return !!backedUp && gitAncestor(root, tip, backedUp);
          })
        )
          return false;
      }
      return withCacheLocksSync(checkouts.map(taskQueuePath), () => {
        if (checkouts.some((checkout) => readTaskQueue(checkout).entries.length)) return false;
        gitBytes(root, ["update-ref", "-d", ref, tip]);
        return true;
      });
    },
    "planning",
  );
}

export function maintainPlanning(root: string): void {
  try {
    pruneEmptyPlanning(root);
  } catch (error) {
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.Command,
      DiagnosticOutcome.Failed,
      { command: "planning retention" },
      error,
    );
  }
}
