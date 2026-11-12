import { Command } from "commander";
import { prepareReleases } from "../core/artifacts/release-profiles.js";
import { required } from "../core/runtime/invariants.js";
import { listReleaseProfiles } from "./release-output.js";

export function registerReleaseCommands(program: Command, root: string): void {
  const releaseCommand = required(
    program.commands.find((command) => command.name() === "release"),
    "release record command",
  );
  releaseCommand
    .command("profiles")
    .description("List configured release recipes, target platforms, and artifact formats")
    .option("--json", "Print configured release recipes and output paths as JSON")
    .action((options: { json?: boolean }) => {
      listReleaseProfiles(root, undefined, false, options.json);
    });
  releaseCommand
    .command("prepare")
    .description("Prepare and verify one, several, or all configured local releases")
    .argument("[profiles...]")
    .option("--all", "Select all configured profiles (the default)")
    .option("--plan", "Inspect without building")
    .option("--json", "Print the plan as JSON without building")
    .action((profiles: string[], options: { all?: boolean; plan?: boolean; json?: boolean }) => {
      if (options.plan || options.json) listReleaseProfiles(root, profiles, options.all, options.json);
      else prepareReleases(root, profiles, options.all);
    });
}
