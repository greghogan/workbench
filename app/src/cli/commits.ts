import { historyBranches, historyCommits, historyFiles } from "../core/git/history.js";
import { Option, type Command } from "commander";
import { finalizationPlan, finalizeHistory, resumePreparedFinalization } from "../core/git/finalization.js";
import { pendingFinalizationStatus } from "../core/git/finalization-requests.js";
import { pendingCommitReviews } from "../core/review/review-units.js";
import { terminalTable } from "../core/diagnostics/terminal-table.js";
import { resolve } from "node:path";
import { provisionalEnvironment } from "../core/git/commit-history.js";
import { checkCommit } from "../core/git/commit.js";
import { gitBytes, stagedReviewTree } from "../core/git/git-snapshot.js";
import { collect, registerCommand } from "./commands.js";
import { checkCommitReview, createCommit } from "./commit-workflow.js";
import { recoveryReferences, removeRecoveryReference } from "../core/git/recovery-refs.js";
import { InvalidInput } from "../core/runtime/input-errors.js";
import { resumePreparedSigning, signHistory } from "../core/git/sign-history.js";

export function registerCommitCommands(program: Command, root: string): void {
  registerCommand(program, "sign")
    .description("Sign unpublished commits using Git's configured signer")
    .argument("[branch-or-tag]", "Local branch or tag (default: current branch)")
    .action((selected: string | undefined) => {
      resumePreparedFinalization(root);
      const result = signHistory(root, selected);
      if (!result.recovery) console.log("No unsigned unpublished commits by your configured Git author.");
      else console.log(`Signed ${String(result.signed)} ${result.signed === 1 ? "commit" : "commits"}.`);
      if (result.otherAuthors)
        console.log(
          `${String(result.otherAuthors)} unsigned ${result.otherAuthors === 1 ? "commit belongs" : "commits belong"} to other authors.`,
        );
    });
  const commit = registerCommand(program, "commit")
    .description("Commit staged files, optionally preserving unreviewed work provisionally")
    .option("-m, --message <text>", "Commit text; repeat for separate paragraphs", collect, [])
    .option("-F, --file <path>", "Read commit text from a file, or - for standard input")
    .option("--provisional", "Defer human record review and mark this local commit as unpublishable")
    .option("--amend", "Replace the current commit using the supplied message")
    .action((options: { message: string[]; file?: string; provisional?: boolean; amend?: boolean }) => {
      resumePreparedSigning(root);
      resumePreparedFinalization(root);
      return createCommit(root, options);
    });
  commit
    .command("recovery")
    .description("Inspect retained Git recovery references or explicitly release an inspected backup")
    .option("--json", "Print recovery references and object identities")
    .option("--delete <reference>", "Release one recovery reference without changing project branches")
    .option("--expected <object>", "Require the inspected object identity before deletion")
    .option("--yes", "Confirm removal of the selected recovery reference")
    .action((options: { json?: boolean; delete?: string; expected?: string; yes?: boolean }) => {
      if (options.delete) {
        if (!options.expected || !options.yes)
          throw new InvalidInput("Inspect the backup, then supply --expected OBJECT --yes to release it");
        removeRecoveryReference(root, options.delete, options.expected);
      } else if (options.expected || options.yes) throw new InvalidInput("Select a recovery reference with --delete");
      const references = recoveryReferences(root);
      console.log(
        options.json
          ? JSON.stringify(references, null, 2)
          : terminalTable(
              ["REFERENCE", "OBJECT", "TYPE"],
              references.map((entry) => [entry.reference, entry.object, entry.type]),
            ),
      );
    });
  commit
    .command("history")
    .description("Inspect local branches, commits and their diffs without checking them out")
    .argument("[revision]", "Branch or revision (default: HEAD)")
    .option("--branches", "List local branches")
    .option("--from <revision>", "Continue the selected first-parent history")
    .option("--diff", "Show the selected commit's patch")
    .option("--file <path>", "Restrict the patch to a file")
    .option("--json", "Print immutable history metadata")
    .action(
      (
        selected: string | undefined,
        options: { branches?: boolean; from?: string; diff?: boolean; file?: string; json?: boolean },
      ) => {
        if (options.branches) {
          const branches = historyBranches(root);
          console.log(
            options.json
              ? JSON.stringify(branches, null, 2)
              : terminalTable(
                  ["BRANCH", "COMMIT", "CONTENT"],
                  branches.map((branch) => [
                    branch.name,
                    branch.revision.slice(0, 12),
                    branch.planning ? "Planning" : "Implementation",
                  ]),
                ),
          );
          return;
        }
        if (options.diff || options.file) {
          const { unit } = historyFiles(root, selected ?? "HEAD");
          console.log(
            gitBytes(root, [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              unit.parents[0] ?? gitBytes(root, ["mktree"], "").toString().trim(),
              unit.revision,
              "--",
              ...(options.file ? [options.file] : []),
            ]).toString(),
          );
          return;
        }
        const history = historyCommits(root, selected, options.from);
        console.log(
          options.json
            ? JSON.stringify(history, null, 2)
            : terminalTable(
                ["COMMIT", "STATE", "SUBJECT"],
                history.commits.map((unit) => [
                  unit.revision.slice(0, 12),
                  unit.provisional ? "Provisional" : "Final",
                  unit.subject,
                ]),
              ),
        );
        if (history.next && !options.json) console.log(`\nContinue with --from ${history.next}`);
      },
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
      resumePreparedSigning(root);
      if (options.recover || options.apply) {
        if (!options.recover && !options.expected)
          throw new Error("Inspect finalization, then supply --expected with --apply");
        const result = finalizeHistory(root, options.expected ?? "", options.recover);
        const count = result.finalized ?? result.replacements.length;
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : `Finalized ${String(count)} ${count === 1 ? "commit" : "commits"}.`,
        );
      } else {
        resumePreparedFinalization(root);
        const plan = finalizationPlan(root);
        const waiting = pendingFinalizationStatus(root);
        if (options.json) {
          console.log(JSON.stringify({ ...plan, ...(waiting ? { automatic: { waiting } } : {}) }, null, 2));
          return;
        }
        if (waiting) console.log(`Automatic finalization is pending. ${waiting}\n`);
        if (!plan.units.length) {
          console.log("No provisional commits.");
          return;
        }
        console.log(
          terminalTable(
            ["COMMIT", "STATUS", "PENDING", "FILES", "SUBJECT"],
            plan.units.map((unit) => [
              unit.revision.slice(0, 12),
              unit.ready ? "Ready" : "Waiting",
              String(unit.pending),
              String(unit.files),
              unit.subject,
            ]),
          ),
        );
        console.log(`\n${String(plan.eligible.length)} of ${String(plan.units.length)} commits ready to finalize.`);
        if (plan.problems.length) console.log(`\n${plan.problems.join("\n\n")}`);
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
