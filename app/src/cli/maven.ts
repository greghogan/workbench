import type { Command } from "commander";
import { relative, resolve } from "node:path";
import { readLanguageRoots } from "../core/projects/project-configuration.js";
import { safeRelative } from "../core/runtime/files.js";
import { prepareMavenDependencies } from "../core/toolchains/maven/maven-acquisition.js";
import { acceptMavenDependencies } from "../core/toolchains/maven/maven-proposal.js";
import { assertNativeToolSelection } from "../core/toolchains/native/native-assets.js";
import { quote } from "../core/toolchains/toolchains.js";
import { developmentShell } from "../core/execution/environments/shell.js";

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
    .description("Prepare authenticated Java dependencies or diagnose a selected test");
  maven
    .command("test")
    .description("Run selected tests in one Java root with current sibling sources; does not satisfy the full gate")
    .option("--path <path>", "Java root relative to the project; defaults to the current directory")
    .requiredOption("--tests <selector>", "Surefire class or method selector for the selected root")
    .action(async (options: { path?: string; tests: string }) => {
      const directory = target(options.path);
      await developmentShell(root, relative(root, directory).replaceAll("\\", "/") || ".", undefined, [
        "node",
        "{workbench}/scripts/java-check.mjs",
        "diagnostic",
        options.tests,
      ]);
    });
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
