import { relative, resolve } from "node:path";
import { quote } from "../toolchains.js";
import type { Command } from "commander";
import { safeRelative } from "../files.js";
import { readLanguageRoots } from "../project-configuration.js";
import { prepareMavenDependencies } from "../maven-acquisition.js";
import { acceptMavenDependencies } from "../maven-proposal.js";
import { assertNativeToolSelection } from "../native-assets.js";

export function registerMavenCommands(tools: Command, root: string): void {
  const target = (path?: string) => {
    const directory = path === undefined ? process.cwd() : resolve(root, path);
    const relative = safeRelative(root, directory).replaceAll("\\", "/") || ".";
    if (!readLanguageRoots(root).some((entry) => entry.path === relative && entry.language === "java"))
      throw new Error("Select a configured Java language root with --path");
    return directory;
  };
  const maven = tools
    .command("maven")
    .description("Prepare authenticated Java dependencies separately from project execution");
  maven
    .command("prepare")
    .description("Acquire the proposed Maven graph through a verifying mirror; do not run project checks")
    .option("--path <path>", "Java root relative to the project; defaults to the current directory")
    .requiredOption("--output <directory>", "New directory for the reviewable proposal and verified artifacts")
    .action(async (options: { path?: string; output: string }) => {
      const directory = target(options.path);
      assertNativeToolSelection(root, directory);
      const result = await prepareMavenDependencies(directory, options.output);
      console.log(
        `Prepared ${String(result.artifacts)} authenticated Maven inputs: ${result.directory}. Review checksums.sha256 and authentication.json.`,
      );
      console.log(
        `Next: workbench tools maven accept --path ${quote(relative(root, directory) || ".")} --proposal ${quote(result.directory)}`,
      );
    });
  maven
    .command("accept")
    .description("Activate an inspected dependency proposal for subsequent frozen project checks")
    .option("--path <path>", "Java root relative to the project; defaults to the current directory")
    .requiredOption("--proposal <directory>", "Prepared and reviewed Maven proposal")
    .action(async (options: { path?: string; proposal: string }) => {
      await acceptMavenDependencies(target(options.path), options.proposal);
      console.log("Activated reviewed Maven checksums. Run the configured frozen checks before accepting the update.");
    });
}
