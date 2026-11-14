import type { Command } from "commander";
import {
  AgentReviewKind,
  checkAgentPush,
  finishAgentCommit,
  proposedAgentReview,
  recordAgentReview,
  reviewIdentity,
} from "../core/review/agent-review.js";
import { taskReference } from "../core/tasks/task-model.js";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../core/diagnostics/diagnostics.mjs";

export function registerAgentReviewCommands(review: Command, root: string): void {
  for (const kind of Object.values(AgentReviewKind))
    review
      .command(kind)
      .description(
        kind === AgentReviewKind.Changes
          ? "Inspect or record agent review of current project files"
          : "Inspect or record accumulated work review (task records are optional)",
      )
      .option("--base <revision>", "Start of the reviewed accumulated work")
      .option("--staged", "Review the Git index instead, for a partial commit")
      .option("--amend", "Review the proposed amended commit")
      .option("--commit <revision>", "Review one retained commit against its own parent")
      .option(
        "--task <reference>",
        "Optionally associate a task record with this review (repeatable)",
        (value: string, previous: string[]) => [...previous, value],
        [],
      )
      .option("--record", "Record the completed agent review")
      .option("--expected <digest>", "Identity of the inspected review snapshot")
      .option("--summary <text>", "Review scope, findings resolved, and remaining limitations")
      .option("--verification <text>", "Verification performed and its result")
      .action(
        (options: {
          commit?: string;
          base?: string;
          amend?: boolean;
          staged?: boolean;
          task: string[];
          record?: boolean;
          expected?: string;
          summary?: string;
          verification?: string;
        }) => {
          const pending = proposedAgentReview(root, kind, {
            ...options,
            tasks: options.task.map((value) => taskReference(root, value)),
          });
          const digest = reviewIdentity(pending);
          if (options.record) {
            if (!options.expected || !options.summary?.trim() || !options.verification?.trim())
              throw new Error(
                "Recording review requires --expected, --summary, and --verification after inspecting the snapshot",
              );
            recordAgentReview(
              root,
              { ...pending, summary: options.summary, verification: options.verification },
              options.expected,
              options.staged,
              options.commit,
            );
            console.log(`Recorded ${kind} review for ${pending.tree}.`);
          } else
            console.log(
              JSON.stringify({ kind, base: pending.base, tree: pending.tree, tasks: pending.tasks, digest }, null, 2),
            );
        },
      );
  review.command("finish-commit", { hidden: true }).action(async () => {
    finishAgentCommit(root);
    try {
      const { finishPlanTransfers } = await import("../core/tasks/planning/plan-retirement.js");
      finishPlanTransfers(root);
    } catch (error) {
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.Command,
        DiagnosticOutcome.Degraded,
        {},
        error,
        "Commit saved; finish the planning handoff with workbench task plan recover",
      );
    }
  });
  review
    .command("check-push", { hidden: true })
    .argument("<repository>")
    .argument("<tip>")
    .argument("<remote>")
    .action((repository: string, tip: string, remote: string) => {
      checkAgentPush(repository, tip, remote);
    });
}
