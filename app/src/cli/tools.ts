import { Command, Option } from "commander";
import { runCommand } from "../core/execution/checks/check-command.js";
import { compilerFamilies } from "../core/toolchains/compiler-catalog.mjs";
import type { NativeToolSelection } from "../core/toolchains/native/native-tools.js";
import { collect, registerCommand } from "./commands.js";
import { registerMavenCommands } from "./maven.js";
import { listNativeTools } from "./native-tool-output.js";
import { listToolProfiles } from "./tool-profile-output.js";

export function registerToolCommands(program: Command, root: string): void {
  const tools = registerCommand(program, "tools")
    .description("Show native tool pins and installation locations")
    .option("--toolchain <name>", "Select a named native compiler/runtime profile")
    .option("--path <path>", "Select one registered language root; default: all roots")
    .option(
      "--json",
      "Show native pins, receipt state, SDK executable paths, and acquisition policies without running tools",
    )
    .option("--exclude-tool <name>", "Omit a declared tool from this plan; repeat to omit several", collect, [])
    .addOption(new Option("--compiler <family>", "Inspect a supported C/C++ compiler").choices(compilerFamilies))
    .option("--compiler-version <version>", "Inspect an exact compiler compatibility target")
    .action((options: NativeToolSelection & { path?: string; json?: boolean }) => {
      if ((options.compiler || options.compilerVersion) && options.path === undefined)
        throw new Error("compiler overrides require --path");
      listNativeTools(root, options.path, options.json, options);
    });
  registerMavenCommands(tools, root);
  tools
    .command("profiles")
    .description("List named compiler/runtime selections shared by local execution and CI")
    .option("--json", "Print configured profiles as JSON")
    .action((options: { json?: boolean }) => {
      listToolProfiles(root, options.json);
    });
  tools
    .command("install")
    .description("Explicitly install and verify pinned native tools")
    .option("--path <path>", "Select one registered language root; default: all roots")
    .option("--toolchain <name>", "Install a named native compiler/runtime profile")
    .option("--tool <name>", "Install only one declared native tool in the selected roots")
    .option("--exclude-tool <name>", "Skip installing a tool; existing toolchain checks still apply", collect, [])
    .addOption(new Option("--compiler <family>", "Select a supported C/C++ compiler").choices(compilerFamilies))
    .option("--compiler-version <version>", "Install an exact compiler compatibility target")
    .option("--devcontainer", "Install only the host Node runtime and locked Dev Container CLI")
    .addOption(
      new Option("--environment <environment>", "Install native tools on the host or inside its Dev Container").choices(
        ["native", "devcontainer"],
      ),
    )
    .action(
      (
        options: NativeToolSelection & {
          path?: string;
          tool?: string;
          devcontainer?: boolean;
          environment?: "native" | "devcontainer";
        },
      ) => {
        if ((options.compiler || options.compilerVersion) && (options.path === undefined || options.devcontainer))
          throw new Error("compiler installation overrides require --path");
        if (options.devcontainer && options.path !== undefined) throw new Error("select --devcontainer or --path");
        if (options.devcontainer && options.tool !== undefined) throw new Error("select --devcontainer or --tool");
        if (options.devcontainer && options.excludeTool?.length)
          throw new Error("select --devcontainer or --exclude-tool");
        if (options.tool !== undefined && options.excludeTool?.length)
          throw new Error("select --tool or --exclude-tool");
        if (options.tool === "") throw new Error("--tool requires a nonempty declared tool name");
        if (options.devcontainer && options.environment === "devcontainer")
          throw new Error(
            "--devcontainer installs the host CLI; select --environment devcontainer to install tools inside the container",
          );
        runCommand(
          root,
          "native tool installation",
          [
            "node",
            "{workbench}/bin/workbench.mjs",
            "tools-install",
            ...(options.devcontainer ? ["--devcontainer"] : options.path === undefined ? [] : [options.path]),
            ...(options.compiler ? ["--compiler", options.compiler] : []),
            ...(options.compilerVersion ? ["--compiler-version", options.compilerVersion] : []),
            ...(options.toolchain ? ["--toolchain", options.toolchain] : []),
            ...(options.tool ? ["--tool", options.tool] : []),
            ...(options.excludeTool ?? []).flatMap((tool) => ["--exclude-tool", tool]),
          ],
          options.environment ?? "native",
          root,
          undefined,
          false,
        );
      },
    );
}
