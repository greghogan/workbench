import { Option, type Command } from "commander";
import { finalizationPlan, finalizeHistory } from "../core/git/finalization.js";
import { pendingCommitReviews } from "../core/review/review-units.js";
import { terminalTable } from "../core/diagnostics/terminal-table.js";
import { resolve } from "node:path";
import { provisionalEnvironment } from "../core/git/commit-history.js";
import { checkCommit } from "../core/git/commit.js";
import { gitBytes, stagedReviewTree } from "../core/git/git-snapshot.js";
import { collect, registerCommand } from "./commands.js";
import { checkCommitReview, createCommit } from "./commit-workflow.js";

export function registerCommitCommands(program: Command, root: string): void {
  const commit = registerCommand(program, "commit")
    .description("Commit staged files, optionally preserving unreviewed work provisionally")
    .option("-m, --message <text>", "Commit text; repeat for separate paragraphs", collect, [])
    .option("-F, --file <path>", "Read commit text from a file, or - for standard input")
    .option("--provisional", "Defer human record review and mark this local commit as unpublishable")
    .option("--amend", "Replace the current commit using the supplied message")
    .action((options: { message: string[]; file?: string; provisional?: boolean; amend?: boolean }) =>
      createCommit(root, options),
    );
  commit
    .command("reviews")
    .description("List retained commit review units in parent order")
    .option("--json", "Print machine-readable review units")
    .action((options: { json?: boolean }) => {
      if (options.json) {
        console.log(
          JSON.stringify(
            pendingCommitReviews(root).map((unit) => ({
              revision: unit.revision,
              parent: unit.parents[0],
              subject: unit.message.split("\n")[0],
              pending: unit.pending,
              files: unit.changes.length,
            })),
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        terminalTable(
          ["COMMIT", "PENDING", "FILES", "SUBJECT"],
          pendingCommitReviews(root).map((unit) => [
            unit.revision.slice(0, 12),
            String(unit.pending),
            String(unit.changes.length),
            unit.message.split("\n")[0] ?? "",
          ]),
        ),
      );
    });
  commit
    .command("finalize")
    .description("Inspect or finalize reviewed provisional history")
    .option("--apply", "Activate the reviewed replacement history")
    .option("--expected <digest>", "Identity of the inspected finalization plan")
    .option("--recover", "Resume prepared finalization")
    .option("--json", "Print the complete plan or activated result")
    .action((options: { apply?: boolean; expected?: string; recover?: boolean; json?: boolean }) => {
      if (options.recover || options.apply) {
        if (!options.recover && !options.expected)
          throw new Error("Inspect finalization, then supply --expected with --apply");
        const result = finalizeHistory(root, options.expected ?? "", options.recover);
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : `Finalized ${String(result.replacements.length)} commits.\nRecovery: ${result.recovery}`,
        );
      } else {
        const plan = finalizationPlan(root);
        if (options.json) {
          console.log(JSON.stringify(plan, null, 2));
          return;
        }
        if (!plan.units.length) {
          console.log("No provisional commits.");
          return;
        }
        console.log(
          terminalTable(
            ["COMMIT", "PENDING", "FILES", "SUBJECT"],
            plan.units.map((unit) => [
              unit.revision.slice(0, 12),
              String(unit.pending),
              String(unit.files),
              unit.subject,
            ]),
          ),
        );
        console.log(plan.problems.length ? `\n${plan.problems.join("\n\n")}` : "\nReady to finalize.");
        console.log(`\nFinalization digest:\n${plan.digest}`);
      }
    });
  commit
    .command("check")
    .description("Check a proposed commit message against project conventions before running gates")
    .argument("<message>")
    .addOption(new Option("--hook", "Validate the commit hook's review boundary").hideHelp())
    .action((message: string, options: { hook?: boolean }) => {
      const text = checkCommit(root, message);
      if (options.hook || process.env[provisionalEnvironment] !== undefined) {
        const owner = resolve(process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root);
        checkCommitReview(owner, message, process.env.WORKBENCH_REVIEW_TREE ?? stagedReviewTree(owner), text);
      }
    });
}
