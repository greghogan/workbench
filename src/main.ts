import { checkSecrets } from "./secrets.js";
import { checkAdvisories } from "./advisories.js";
import { required } from "./invariants.js";
import { checkDocExamples } from "./doc-examples.js";
import { approveReview, checkReview, reviewStatus } from "./review.js";
import { observeCommand } from "./test-timing.js";
import { Command, Option } from "commander";
import { resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { projectRoot, distributionRoot, readConfig } from "./core.js";
import { syncMaps } from "./maps.js";
import { registerRecordCommands } from "./record-commands.js";
import { QueryCommand } from "./query-command.js";
import { syncRecordSequences } from "./record-sequences.js";
import { syncReleaseIndexes } from "./releases.js";
import { checkLanguages, initLanguage, listLanguages, reportLanguages } from "./languages.js";
import { listChecks, runChecks } from "./checks.js";
import { type CheckSelection } from "./check-plan.js";
import { developmentShell } from "./shell.js";
import { ciMatrix } from "./ci.js";
import { addProject, configureGitHooks, setupProject } from "./projects.js";
import { addFeedback, queryFeedback, showFeedback, resolveFeedback } from "./feedback.js";
import { checkCommit } from "./commit.js";
import { validate } from "./validation.js";
import { formatFiles } from "./formatting.js";
import { readProjects } from "./core.js";
import { synchronize } from "./sync.js";
import { prepareUpdate } from "./update-prepare.js";
import { updateWorkbench } from "./update.js";
import { installNativeTools, listNativeTools, nativeEnvironment, installContainerTools } from "./native-tools.js";
import { runCommand } from "./checks.js";
import { prepareVcpkg } from "./vcpkg.js";
import { executeDevcontainer } from "./devcontainers.js";
import { execute } from "./tool-downloads.js";
import { runMiri } from "./miri.js";
import { buildPaths, buildEnvironment, prepareBuild, cleanBuilds } from "./builds.js";
import { checkEnvironment } from "./environments.js";
import { quote } from "./toolchains.js";
import { configScopes, showConfiguration, setConfiguration, type ConfigScope } from "./config-command.js";
import { completionCandidates, completionScript } from "./completion.js";
import { dependencySetup } from "./dependencies.js";
import { type CompilerSelection } from "./compilers.js";

const program = new Command();
program.name("workbench").description("Shared agentic software-development context and workflows");
program.helpCommand(false).enablePositionalOptions().showHelpAfterError();
program.option("--help-all", "Print help for every public command").action((options: { helpAll?: boolean }) => {
  if (options.helpAll) printAllHelp();
  else program.outputHelp();
});
// Accept shared options before or after an action, but never silently discard a browse-only option.
program.hook("preAction", (_program, action) => {
  // Snapshot checks validate their explicit tree, not the launcher's working checkout.
  const suppliedRoot =
    [action.name(), action.parent?.name()].some((name) => ["config", "completion", "complete"].includes(name ?? "")) ||
    action.name() === "review" ||
    action.parent?.name() === "review" ||
    action.name() === "observe" ||
    ["validate", "setup-project", "secrets"].includes(action.name()) ||
    (action.name() === "run" && action.parent?.name() === "checks");
  if (
    !suppliedRoot &&
    existsSync(join(root, "workbench/config.toml")) &&
    !["workbench", "help", "update", "update-prepare"].includes(action.name())
  )
    readConfig(root);
  for (let ancestor = action.parent; ancestor; ancestor = ancestor.parent) {
    for (const option of ancestor.options) {
      const key = option.attributeName();
      if (ancestor.getOptionValueSource(key) !== "cli") continue;
      if (!action.options.some((candidate) => candidate.attributeName() === key))
        throw new Error(`${String(option.long)} does not apply to '${action.name()}'`);
      const inherited: unknown = ancestor.getOptionValue(key);
      if (action.getOptionValueSource(key) === "cli" && action.getOptionValue(key) !== inherited)
        throw new Error(`conflicting values for ${String(option.long)}; supply it once`);
      action.setOptionValueWithSource(key, inherited, "cli");
    }
  }
});
const root = projectRoot();
program
  .command("completion")
  .description("Print shell completion for bash, zsh, fish, or powershell")
  .argument("<shell>")
  .action((shell: string) => {
    process.stdout.write(completionScript(shell));
  });
program
  .command("complete", { hidden: true })
  .option("--empty")
  .argument("[words...]")
  .action((words: string[], options: { empty?: boolean }) => {
    const candidates = completionCandidates(program, options.empty ? [...words, ""] : words);
    if (candidates.length) console.log(candidates.join("\n"));
  });
const scopeOption = () => new Option("--scope <scope>", "Select the owning configuration file").choices(configScopes);
const configuration = program
  .command("config")
  .description("Inspect global settings, project choices, and local overrides")
  .addOption(scopeOption())
  .action((options: { scope?: ConfigScope }) => {
    showConfiguration(root, options.scope);
  });
configuration
  .command("get")
  .description("Print one option value")
  .argument("<key>")
  .addOption(scopeOption())
  .action((key: string, options: { scope?: ConfigScope }) => {
    showConfiguration(root, options.scope, key);
  });
configuration
  .command("set")
  .description("Validate and save an option in its owning scope")
  .argument("<key>")
  .argument("<value>")
  .addOption(scopeOption())
  .action((key: string, value: string, options: { scope?: ConfigScope }) => {
    setConfiguration(root, key, value, options.scope);
  });
configuration
  .command("unset")
  .description("Remove an optional setting or restore a global default")
  .argument("<key>")
  .addOption(scopeOption())
  .action((key: string, options: { scope?: ConfigScope }) => {
    setConfiguration(root, key, undefined, options.scope);
  });

program
  .command("secrets [path]")
  .description("Check project source files for recognized credentials")
  .action((path?: string) => {
    checkSecrets(resolve(path ?? root));
  });
program
  .command("advisories <language>")
  .description("Check this language root's locked dependencies against OSV (network required)")
  .action(async (language: string) => {
    await checkAdvisories(process.cwd(), language);
  });
program.commandsGroup("Workspace:");
program
  .command("setup")
  .description("Configure the root project and Git change gates")
  .option("--id <id>", "Root project ID (default: existing ID or directory name)")
  .action(async (options: { id?: string }) => {
    await setupProject(root, options.id);
    sync();
    configureGitHooks(root, distributionRoot(root));
  });
const project = program
  .command("project")
  .description("List registered project scopes")
  .option("--json", "Print project IDs and paths as JSON")
  .action((options: { json?: boolean }) => {
    const projects = readProjects(root);
    if (options.json) console.log(JSON.stringify(projects, null, 2));
    else for (const entry of projects) console.log(`${entry.id}: ${entry.path}`);
  });
project
  .command("add")
  .description("Register a subproject; prompt when ID and path are omitted")
  .argument("[id]", "Unique project ID")
  .argument("[path]", "Directory relative to the repository root")
  .action(async (id?: string, path?: string) => {
    await addProject(root, id, path);
    sync();
  });
const language = program
  .command("language")
  .description("List supported languages and executable references")
  .action(() => {
    listLanguages(root);
  });
language
  .command("roots")
  .description("Show configured language roots and detected manifests by project")
  .option("--project <id>", "Limit to a registered project scope")
  .action((options: { project?: string }) => {
    reportLanguages(root, options.project);
  });
language
  .command("init")
  .description("Seed a TypeScript root and configure checks without overwriting files")
  .argument("<language>", "Starter language (currently typescript)")
  .argument("[path]", "Existing directory relative to the repository root", ".")
  .action((selected: string, path: string) => {
    initLanguage(root, selected, path);
    sync();
  });
language
  .command("check")
  .description("Run checks for bundled reference projects")
  .argument("[language]", "Supported language ID")
  .option("--all", "Check every bundled language reference")
  .addOption(
    new Option("--environment <environment>", "Run in a separately pinned check environment").choices([
      "native",
      "guix",
      "nix",
      "nix-docker",
      "devcontainer",
    ]),
  )
  .action(
    (
      selected: string | undefined,
      options: { all?: boolean; environment?: "native" | "guix" | "nix" | "nix-docker" | "devcontainer" },
    ) => {
      checkLanguages(root, selected, !!options.all, options.environment);
    },
  );
program.commandsGroup("Records:");
registerRecordCommands(program, root, sync);
program.commandsGroup("Local feedback:");
const feedback = new QueryCommand("feedback").copyInheritedSettings(program);
program.addCommand(feedback);
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
program.commandsGroup("Maintenance:");
const review = program
  .command("review")
  .description("Show protected staged changes and their review digest")
  .action(() => {
    reviewStatus(root);
  });
review
  .command("approve")
  .description("Record explicit human approval of the displayed digest")
  .requiredOption("--digest <sha256>", "Digest displayed by workbench review")
  .option("--human-written-charters", "Attest that changed charter text was written by a human")
  .action((options: { digest: string; humanWrittenCharters?: boolean }) => {
    approveReview(root, options.digest, !!options.humanWrittenCharters);
  });
const reviewCheck = review
  .command("check", { hidden: true })
  .argument("<repository>", "Owning checkout for the staged review receipt")
  .action((repository: string) => {
    checkReview(resolve(repository));
  });
program
  .command("update")
  .description("Update the pinned Workbench submodule, migrate records, and validate before applying")
  .argument("[revision]", "Branch, tag, or commit (default: update.revision in config)")
  .action((revision?: string) => {
    updateWorkbench(root, revision);
  });
program.command("update-prepare", { hidden: true }).action(async () => {
  if (!process.env.WORKBENCH_UPDATE_PREPARATION || realpathSync(process.env.WORKBENCH_UPDATE_PREPARATION) !== root)
    throw new Error("update-prepare is an internal operation; use 'workbench update REVISION'");
  await prepareUpdate(root);
});
program
  .command("sync")
  .description("Refresh maps, agent context, record sequences, indexes, and skill discovery")
  .action(() => {
    if (!sync()) console.log("Already up to date.");
  });
program
  .command("format")
  .description("Format Markdown or YAML; print a file, or use --write / --check")
  .argument("[path]", "Markdown or YAML file path")
  .option("--all", "Format records across all registered project scopes")
  .option("--project <id>", "Limit --all to one registered scope")
  .addOption(new Option("--write", "Update the file in place").conflicts("check"))
  .addOption(new Option("--check", "Fail if formatting would change the file").conflicts("write"))
  .action((path: string | undefined, options: { all?: boolean; project?: string; write?: boolean; check?: boolean }) =>
    formatFiles(root, path, options),
  );
program
  .command("validate")
  .description("Validate structure and generated files without running project check commands")
  .argument("[root]", "Project tree", undefined)
  .action((requested?: string) => validate(requested ? resolve(requested) : root));
program
  .command("paths")
  .description("Show selected build and dependency locations; export native controls with --shell")
  .option("--path <path>", "Language root relative to the repository (default: current directory)")
  .option("--environment <environment>", "Select the execution environment")
  .option("--shell", "Prepare build storage and print shell exports for eval/direnv")
  .action((options: { path?: string; environment?: string; shell?: boolean }) => {
    const paths = buildPaths(
      root,
      options.path === undefined ? process.cwd() : resolve(root, options.path),
      options.environment === undefined ? undefined : checkEnvironment(options.environment, "--environment"),
    );
    if (options.shell) {
      prepareBuild(paths);
      for (const [key, value] of Object.entries(buildEnvironment(paths))) console.log(`export ${key}=${quote(value)}`);
    } else console.log(JSON.stringify({ ...paths, variables: buildEnvironment(paths) }, null, 2));
  });
program
  .command("build-clean", { hidden: true })
  .argument("<repository>")
  .option("--dependencies")
  .action((repository: string, options: { dependencies?: boolean }) => {
    cleanBuilds(buildPaths(resolve(repository), process.cwd(), "native", {}, false), options.dependencies);
  });
program
  .command("dependency-setup", { hidden: true })
  .argument("<command...>")
  .action((command: string[]) => {
    dependencySetup(command);
  });
program
  .command("shell")
  .description("Use the selected local development environment (interactive Bash or a command)")
  .option("--path <path>", "Registered language root relative to the repository", ".")
  .addOption(
    new Option("--environment <environment>", "Override the local selection").choices([
      "native",
      "nix",
      "guix",
      "devcontainer",
    ]),
  )
  .argument("[command...]", "Command and literal arguments after --; omit for an interactive shell")
  .action((command: string[], options: { path: string; environment?: string }) => {
    developmentShell(root, options.path, options.environment, command);
  });
const tools = program
  .command("tools")
  .description("Show native tool pins and installation locations")
  .option("--path <path>", "Select one registered language root; default: all roots")
  .action((options: { path?: string }) => {
    listNativeTools(root, options.path);
  });
tools
  .command("install")
  .description("Explicitly install and verify pinned native tools in user storage")
  .option("--path <path>", "Select one registered language root; default: all roots")
  .addOption(new Option("--compiler <family>", "Select a supported C/C++ compiler").choices(["clang", "gcc"]))
  .option("--compiler-version <version>", "Install an exact compiler compatibility target")
  .option("--devcontainer", "Install only the host Node runtime and locked Dev Container CLI")
  .addOption(
    new Option("--environment <environment>", "Install native tools on the host or inside its Dev Container").choices([
      "native",
      "devcontainer",
    ]),
  )
  .action(
    (
      options: CompilerSelection & { path?: string; devcontainer?: boolean; environment?: "native" | "devcontainer" },
    ) => {
      if ((options.compiler || options.compilerVersion) && (options.path === undefined || options.devcontainer))
        throw new Error("compiler installation overrides require --path");
      if (options.devcontainer && options.path !== undefined) throw new Error("select --devcontainer or --path");
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
        ],
        true,
        options.environment ?? "native",
        root,
        undefined,
        false,
      );
    },
  );
program
  .command("tools-install", { hidden: true })
  .argument("[path]")
  .option("--devcontainer")
  .option("--compiler <family>")
  .option("--compiler-version <version>")
  .action((path: string | undefined, options: CompilerSelection & { devcontainer?: boolean }) =>
    options.devcontainer ? installContainerTools(root) : installNativeTools(root, path, options),
  );
program
  .command("native-exec", { hidden: true })
  .argument("<directory>")
  .argument("<command...>")
  .action((directory: string, command: string[]) => {
    const paths = buildPaths(root, directory, process.env.WORKBENCH_DEVCONTAINER === "1" ? "devcontainer" : "native");
    prepareBuild(paths);
    execute(required(command[0], "expected command[0]"), command.slice(1), {
      cwd: directory,
      env: { ...nativeEnvironment(directory, distributionRoot(root)), ...buildEnvironment(paths) },
    });
  });
program
  .command("devcontainer-exec", { hidden: true })
  .argument("<repository>")
  .argument("<directory>")
  .argument("<command...>")
  .action((repository: string, directory: string, command: string[]) =>
    executeDevcontainer(repository, directory, command),
  );
program
  .command("vcpkg-prepare", { hidden: true })
  .argument("<directory>")
  .argument("<build>")
  .addOption(new Option("--compiler <family>").choices(["clang", "gcc"]))
  .action((directory: string, build: string, options: { compiler?: "clang" | "gcc" }) => {
    prepareVcpkg(directory, build, options.compiler);
  });
program
  .command("miri-exec", { hidden: true })
  .argument("<arguments...>")
  .action((args: string[]) => {
    runMiri(process.cwd(), args);
  });
const checks = program
  .command("checks")
  .description("List configured check roles and language recommendations")
  .option("--stage <stage>", "Inspect the commit or ci execution plan")
  .option("--role <role>", "Inspect a role, including manual coverage")
  .option("--project <id>", "Select a project and descendant check roots")
  .option("--path <path>", "Select one registered language root")
  .option("--environment <environment>", "Inspect an explicit execution environment")
  .action((options: CheckSelection) => {
    listChecks(root, options);
  });
checks
  .command("matrix")
  .description("Print configured CI matrices as JSON")
  .action(() => {
    console.log(JSON.stringify(ciMatrix(root)));
  });
checks
  .command("run")
  .description("Run commit checks by default; select a stage or an explicit role with its setup")
  .addOption(
    new Option("--compiler <family>", "Select a supported C/C++ compiler for this run").choices(["clang", "gcc"]),
  )
  .option("--compiler-version <version>", "Verify an exact compiler compatibility target")
  .option("--stage <stage>", "Run checks assigned to commit or ci")
  .option("--role <role>", "Run a role with setup; coverage selects instrumented tests; skips structural validation")
  .option("--project <id>", "Run commands for a project and its descendant roots")
  .option("--path <path>", "Run commands for one registered language root")
  .option("--environment <environment>", "Override the local selection: native, guix, nix, nix-docker, devcontainer")
  .argument("[root]", "Project tree (default: current project root)")
  .action(async (requested: string | undefined, options: CheckSelection) => {
    const tree = requested ? resolve(requested) : root;
    if (!options.role) await validate(tree);
    runChecks(tree, options);
  });
program
  .command("setup-project", { hidden: true })
  .argument("<root>")
  .action(async (requested: string) => {
    await setupProject(resolve(requested));
    for (const path of syncRecordSequences(resolve(requested))) console.log(`Updated ${path}.`);
    for (const path of syncMaps(resolve(requested))) console.log(`Updated ${path}.`);
    for (const path of syncReleaseIndexes(resolve(requested))) console.log(`Updated ${path}.`);
  });
program
  .command("commit", { hidden: true })
  .command("check")
  .argument("<message>")
  .action((message: string) => {
    checkCommit(root, message);
  });
program
  .command("observe", { hidden: true })
  .argument("<warning>")
  .argument("<command...>")
  .action((warning: string, command: string[]) => observeCommand(command, Number(warning)));
program
  .command("docs")
  .description("Verify executable console examples")
  .argument("<file>")
  .action((file: string) => {
    checkDocExamples(file);
  });
program.commandsGroup("Help:");
program
  .command("help")
  .description("Print help for the root or a command path")
  .argument("[path...]", "Command path, such as task add")
  .option("--all", "Print help for every public command")
  .action((path: string[], options: { all?: boolean }) => {
    if (options.all) {
      if (path.length) throw new Error("help --all cannot be combined with a command path");
      printAllHelp();
    } else {
      let command = program;
      for (const name of path) {
        const next = command.commands.find((candidate) => candidate.name() === name);
        if (
          !next ||
          next === reviewCheck ||
          [
            "setup-project",
            "commit",
            "update-prepare",
            "observe",
            "tools-install",
            "native-exec",
            "devcontainer-exec",
            "vcpkg-prepare",
            "miri-exec",
            "build-clean",
            "dependency-setup",
            "complete",
          ].includes(name)
        )
          throw new Error(`unknown command in help path: ${name}`);
        command = next;
      }
      command.outputHelp();
    }
  });
function printAllHelp(): void {
  program.outputHelp();
  function visit(command: Command, path: string[]): void {
    for (const child of command.commands) {
      if (
        child === reviewCheck ||
        [
          "setup-project",
          "commit",
          "update-prepare",
          "observe",
          "tools-install",
          "native-exec",
          "devcontainer-exec",
          "vcpkg-prepare",
          "miri-exec",
          "build-clean",
          "dependency-setup",
          "complete",
        ].includes(child.name())
      )
        continue;
      const childPath = [...path, child.name()];
      process.stdout.write(`\nCOMMAND: ${childPath.join(" ")}\n\n`);
      child.outputHelp();
      visit(child, childPath);
    }
  }
  visit(program, ["workbench"]);
}
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
function sync(): number {
  return synchronize(root);
}
program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`workbench: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
