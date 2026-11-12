import { Command } from "commander";
import { collect, registerCommand } from "./commands.js";
import { addFeedback, queryFeedback, resolveFeedback, showFeedback } from "./feedback.js";
import { QueryCommand } from "./query-command.js";

export function registerFeedbackCommands(program: Command, root: string): void {
  const feedback = new QueryCommand("feedback").copyInheritedSettings(program);
  registerCommand(program, feedback);
  feedback
    .description("List or search unresolved local feedback")
    .argument("[query...]", "Literal text to find; omit to list feedback")
    .option("--all", "Include accepted and rejected feedback")
    .option("--json", "Print structured results")
    .action((words: string[], options: { all?: boolean; json?: boolean }) => {
      queryFeedback(options, feedback.query(words));
    });
  feedback.addHelpText(
    "after",
    "\nAfter '--', all arguments are literal search text. Example: workbench feedback -- add",
  );
  feedback
    .command("show")
    .description("Print one local feedback file's path and full contents")
    .argument("<id>", "Feedback ID")
    .option("--json", "Print ID, path, and contents as JSON")
    .action((id: string, options: { json?: boolean }) => {
      showFeedback(id, !!options.json);
    });
  feedback
    .command("add")
    .description("Create a local feedback draft")
    .argument("<title>", "Feedback title")
    .action((title: string) => {
      addFeedback(title);
    });
  feedback
    .command("resolve")
    .description("Record acceptance or rejection and the reason")
    .argument("<id>", "Feedback ID")
    .argument("<disposition>", "accepted or rejected")
    .argument("<explanation>", "One-line resolution reason")
    .option("--record <reference>", "Resulting record", collect, [])
    .action((id: string, disposition: string, explanation: string, options: { record: string[] }) => {
      resolveFeedback(root, id, disposition, explanation, options.record);
    });
}
