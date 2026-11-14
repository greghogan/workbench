import type { Command } from "commander";
import { branchIntegration, integrateBranch } from "../core/git/branch-integration.js";
import { validate } from "../core/records/validation.js";
import { InvalidInput } from "../core/runtime/input-errors.js";
import { registerCommand } from "./commands.js";

export function registerIntegrationCommands(program: Command, root: string): void {
  for (const kind of ["rebase", "merge"] as const) {
    registerCommand(program, kind)
      .description(
        kind === "rebase"
          ? "Rebase onto a pinned target, preserving archive access and recovery"
          : "Merge a pinned source and reconcile record storage",
      )
      .argument(
        "[target]",
        kind === "rebase" ? "Target (default: configured integration branch)" : "Branch or revision to merge",
      )
      .option("--status", "Inspect the recorded integration and recovery reference")
      .option("--continue", "Continue after resolving the stopped integration")
      .option("--abort", "Restore the original branch while retaining recovery references")
      .action(
        async (target: string | undefined, options: { continue?: boolean; abort?: boolean; status?: boolean }) => {
          if (
            [options.continue, options.abort, options.status].filter(Boolean).length > 1 ||
            (target && (options.continue || options.abort || options.status))
          )
            throw new InvalidInput("Select a target, --status, --continue, or --abort");
          if (options.status) {
            const operation = branchIntegration(root);
            console.log(
              operation
                ? `${operation.kind} ${operation.completed ? "completed" : "pending"}: ${operation.branch}\nTarget: ${operation.target}\nCheckout: ${operation.checkout}\nRecovery: ${operation.recovery}`
                : "No integration is recorded.",
            );
            return;
          }
          const result = integrateBranch(root, kind, {
            ...(target ? { target } : {}),
            ...(options.abort ? { action: "abort" as const } : options.continue ? { action: "continue" as const } : {}),
          });
          console.log(`${options.abort ? "Restored" : "Integrated"} ${result.branch}. Recovery: ${result.recovery}`);
          if (!options.abort) await validate(root);
        },
      );
  }
}
