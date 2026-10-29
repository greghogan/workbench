import { Option, type Command } from "commander";
import { resolve } from "node:path";
import { checkCommit } from "../commit.js";
import { checkCommitReview, createCommit } from "../commit-workflow.js";
import { gitBytes } from "../git-snapshot.js";
import { collect, registerCommand } from "./commands.js";
import { provisionalEnvironment } from "../commit-history.js";

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
    .command("check")
    .description("Check a proposed commit message against project conventions before running gates")
    .argument("<message>")
    .addOption(new Option("--hook", "Validate the commit hook's review boundary").hideHelp())
    .action((message: string, options: { hook?: boolean }) => {
      const text = checkCommit(root, message);
      if (options.hook || process.env[provisionalEnvironment] !== undefined) {
        const owner = resolve(process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root);
        checkCommitReview(
          owner,
          message,
          process.env.WORKBENCH_REVIEW_TREE ?? gitBytes(owner, ["write-tree"]).toString().trim(),
          text,
        );
      }
    });
}
