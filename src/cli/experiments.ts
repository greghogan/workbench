import type { Command } from "commander";
import { registerCommand } from "./commands.js";
import { terminalAvailable } from "../terminal-choice.js";
import { currentProject, readProjects, selectProject } from "../project-configuration.js";
import { rootOf } from "../project-context.js";
import { scan } from "../record-files.js";
import {
  readExperiment,
  experimentReference,
  changeExperimentStatus,
  experimentResults,
} from "../experiment-workflow.js";
import { reviewInteractively } from "../review.js";

export function registerExperimentCommands(program: Command, root: string): void {
  const command = registerCommand(program, "experiment")
    .description("Track experiment execution and review completed results")
    .option("--project <id>", "Owning project scope")
    .option("--json", "Print experiment records as JSON");
  const reference = (value: string, action: Command) =>
    experimentReference(
      root,
      value,
      action.optsWithGlobals<{ project?: string }>().project ??
        (value.includes(":") ? undefined : currentProject(root)),
    );
  command.action(() => {
    const requested = command.opts<{ project?: string }>().project;
    const project = requested ? selectProject(root, requested).id : undefined;
    const records = readProjects(root)
      .filter((item) => !project || item.id === project)
      .flatMap((item) =>
        scan(rootOf(root, item), "EXP").map((file) => readExperiment(root, `${item.id}:EXP-${file.number}`)),
      );
    if (command.opts<{ json?: boolean }>().json) console.log(JSON.stringify(records, null, 2));
    else for (const record of records) console.log(`${record.reference} ${record.metadata.status}`);
  });
  command
    .command("show")
    .description("Read an experiment and its metadata")
    .argument("<reference>")
    .option("--json", "Print the record and metadata as JSON")
    .action((value: string, _options: unknown, action: Command) => {
      const record = readExperiment(root, reference(value, action));
      console.log(
        action.optsWithGlobals<{ json?: boolean }>().json ? JSON.stringify(record, null, 2) : record.contents,
      );
    });
  for (const [name, status] of [
    ["start", "Running"],
    ["replan", "Planned"],
  ] as const)
    command
      .command(name)
      .description(name === "start" ? "Start or resume an experiment" : "Return an experiment to planning")
      .argument("<reference>")
      .action((value: string, _options: unknown, action: Command) => {
        changeExperimentStatus(root, reference(value, action), status);
      });
  command
    .command("finish")
    .description("Record a completed experiment's conclusion and retain it for human review")
    .argument("<reference>")
    .requiredOption("--result <result>", "Accepted, Rejected or Inconclusive")
    .action((value: string, options: { result: string }, action: Command) => {
      const result = experimentResults.find((item) => item.toLowerCase() === options.result.toLowerCase());
      if (!result) throw new Error("Choose Accepted, Rejected or Inconclusive");
      changeExperimentStatus(root, reference(value, action), result);
    });
  command
    .command("accept")
    .argument("<reference>")
    .description("Review completed results and supporting files, independently of the candidate conclusion")
    .action(async (value: string, _options: unknown, action: Command) => {
      if (!terminalAvailable())
        throw new Error("Human outcome review requires an interactive terminal or the experiment page");
      const experiment = readExperiment(root, reference(value, action));
      if (!experimentResults.some((result) => result === experiment.metadata.status))
        throw new Error("Finish the experiment before reviewing its outcome");
      await reviewInteractively(root, experiment.path);
    });
  for (const action of command.commands) action.option("--project <id>", "Owning project scope");
}
