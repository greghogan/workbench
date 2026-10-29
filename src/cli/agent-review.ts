import type { Command } from "commander";
import {
  AgentReviewKind,
  proposedAgentReview,
  reviewIdentity,
  recordAgentReview,
  checkAgentPush,
  finishAgentCommit,
} from "../agent-review.js";
import { taskReference } from "../task-model.js";

export function registerAgentReviewCommands(review: Command, root: string): void {
  for (const kind of Object.values(AgentReviewKind))
    review
      .command(kind)
      .description(
        kind === AgentReviewKind.Changes
          ? "Inspect or record agent review of current project files"
          : "Inspect or record accumulated task review of current project files",
      )
      .option("--base <revision>", "Start of the reviewed accumulated work")
      .option("--staged", "Review the Git index instead, for a partial commit")
      .option("--amend", "Review the proposed amended commit")
      .option(
        "--task <reference>",
        "Associate a task with this review (repeatable)",
        (value: string, previous: string[]) => [...previous, value],
        [],
      )
      .option("--record", "Record the completed agent review")
      .option("--expected <digest>", "Identity of the inspected review snapshot")
      .option("--summary <text>", "Review scope, findings resolved, and remaining limitations")
      .option("--verification <text>", "Verification performed and its result")
      .action(
        (options: {
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
            );
            console.log(`Recorded ${kind} review for ${pending.tree}.`);
          } else
            console.log(
              JSON.stringify({ kind, base: pending.base, tree: pending.tree, tasks: pending.tasks, digest }, null, 2),
            );
        },
      );
  review.command("finish-commit", { hidden: true }).action(() => {
    finishAgentCommit(root);
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
