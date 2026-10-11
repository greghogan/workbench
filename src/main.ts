import { checkSecrets } from "./secrets.js";
import { checkAdvisories } from "./advisories.js";
import { required } from "./invariants.js";
import { checkDocExamples } from "./doc-examples.js";
import { approveReview, checkReview, reviewStatus } from "./review.js";
import { observeCommand } from "./test-timing.js";
import { Command, Option } from "commander";
import { resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { projectRoot, distributionRoot, readConfig } from "./core.js";
import { syncMaps } from "./maps.js";
import { registerRecordCommands } from "./record-commands.js";
import { QueryCommand } from "./query-command.js";
import { syncRecordSequences } from "./record-sequences.js";
import { syncReleaseIndexes } from "./releases.js";
import { checkLanguages, initLanguage, listLanguages, reportLanguages } from "./languages.js";
import { listChecks, runChecks, type CheckInspectionOptions } from "./checks.js";
import { type CheckSelection } from "./check-plan.js";
import { developmentShell } from "./shell.js";
import { ciMatrix } from "./ci.js";
import { compatibilityRuntimePlan, executeCompatibilityRuntime, runCompatibilityChecks } from "./ci-runtime.js";
import { ciSelection, selectedCIMatrix, type CISelectionOptions } from "./ci-selection.js";
import { addCISelectionOptions, ciSelectionArguments } from "./ci-options.js";
import { groupedCIMatrix } from "./ci-targets.js";
import { listLocalCI, runLocalCI, type LocalCIOptions } from "./local-ci.js";
import { executionEnvironment } from "./execution-resources.js";
import { addProject, configureGitHooks, setupProject } from "./projects.js";
import { addFeedback, queryFeedback, showFeedback, resolveFeedback } from "./feedback.js";
import { checkCommit } from "./commit.js";
import { validate } from "./validation.js";
import { formatFiles } from "./formatting.js";
import { readProjects } from "./core.js";
import { synchronize } from "./sync.js";
import { prepareUpdate } from "./update-prepare.js";
import { updateWorkbench } from "./update.js";
import {
  installNativeTools,
  listNativeTools,
  nativeEnvironment,
  installContainerTools,
  type NativeToolSelection,
} from "./native-tools.js";
import { runCommand } from "./checks.js";
import { prepareVcpkg } from "./vcpkg.js";
import { executeDevcontainer } from "./devcontainers.js";
import { execute } from "./tool-downloads.js";
import { runMiri } from "./miri.js";
import { buildPaths, buildEnvironment, prepareBuild, cleanBuilds } from "./builds.js";
import { checkEnvironment } from "./environments.js";
import { guardToolchains, quote } from "./toolchains.js";
import { configScopes, showConfiguration, setConfiguration, type ConfigScope } from "./config-command.js";
import { completionCandidates, completionScript, installCompletion } from "./completion.js";
import { listDevelopment, useDevelopment } from "./development.js";
import { prepareOfflineProfile, verifyOfflineProfile, publishOfflineProfile } from "./offline-profiles.js";
import { listReleaseProfiles, prepareReleases } from "./release-profiles.js";
import { dependencySetup, pnpmStorageConfiguration } from "./dependencies.js";
import { executePhpCoverage } from "./php-coverage.js";
import { executeComposer, composerBootstrap } from "./php-manager.js";
import { executeBundler } from "./ruby-manager.js";
import { packageManagerCommand, packageManagerInstallationPlan } from "./package-manager.js";
import { nativeAssetPruningPlan, pruneNativeAssets, publishNativeAssets } from "./native-asset-maintenance.js";
import { registerCollectionCommands } from "./collection-commands.js";
import { syncCollectionLinks } from "./collection-links.js";
import { registerInstallationCommands } from "./installation-commands.js";
import { dispatchInstallation } from "./installation-dispatch.js";
import { distributionInputHash } from "./distribution-manifest.js";
import { materializeDistribution } from "./installation-project.js";

const program = new Command();
program
  .command("distribution-inputs", { hidden: true })
  .argument("<paths...>")
  .action((paths: string[]) => {
    console.log(
      JSON.stringify(
        paths.map((path) => [
          path,
          distributionInputHash(process.env.WORKBENCH_DISTRIBUTION_ROOT ?? distributionRoot(root), path),
        ]),
      ),
    );
  });
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
    [action.name(), action.parent?.name(), action.parent?.parent?.name()].some((name) =>
      ["config", "completion", "complete", "installation", "distribution-inputs", "installation-snapshot"].includes(
        name ?? "",
      ),
    ) ||
    action.name() === "review" ||
    action.parent?.name() === "review" ||
    action.name() === "observe" ||
    ["validate", "setup-project", "secrets", "collection-links"].includes(action.name()) ||
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
  .command("installation-snapshot", { hidden: true })
  .argument("<snapshot>")
  .action((snapshot: string) => {
    materializeDistribution(
      root,
      resolve(snapshot),
      process.env.WORKBENCH_DISTRIBUTION_ROOT ?? resolve(__dirname, ".."),
    );
  });
program
  .command("collection-links", { hidden: true })
  .argument("<root>")
  .action((directory: string) => {
    syncCollectionLinks(resolve(directory));
  });
const completion = program
  .command("completion")
  .description("Print shell completion for bash, zsh, fish, or powershell")
  .argument("[shell]")
  .action((shell: string | undefined) => {
    if (!shell) throw new Error("supply a completion shell or use completion install SHELL");
    process.stdout.write(completionScript(shell));
  });
completion
  .command("install")
  .description("Install an owned completion file without editing shell startup files")
  .argument("<shell>")
  .option("--directory <directory>", "Override the completion directory")
  .action((shell: string, options: { directory?: string }) => {
    installCompletion(shell, options.directory);
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
registerCollectionCommands(program, root);
registerInstallationCommands(program, root);
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
  .description("Seed a language root and configure checks without overwriting files")
  .argument("<language>", "Language ID with a starter in its selected definition")
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
const releaseCommand = required(
  program.commands.find((command) => command.name() === "release"),
  "release record command",
);
releaseCommand
  .command("profiles")
  .description("Inspect configured release profiles; preparation defaults to all")
  .option("--json")
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
review
  .command("check", { hidden: true })
  .argument("<repository>", "Owning checkout for the staged review receipt")
  .action((repository: string) => {
    checkReview(resolve(repository));
  });
program
  .command("update")
  .description("Update the pinned Workbench dependency, migrate records, and validate before applying")
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
  .command("pnpm-config", { hidden: true })
  .argument("<directory>")
  .action((directory: string) => {
    console.log(JSON.stringify(pnpmStorageConfiguration(root, resolve(directory))));
  });
program
  .command("dependency-setup", { hidden: true })
  .argument("<command...>")
  .action((command: string[]) => {
    dependencySetup(command);
  });
const development = program
  .command("development")
  .description("Inspect named development profiles and local selection")
  .option("--json")
  .action((options: { json?: boolean }) => {
    listDevelopment(root, options.json);
  });
for (const operation of ["prepare", "verify", "publish"] as const) {
  const command = development
    .command(operation)
    .description(
      operation === "publish"
        ? "Push a verified development image to GHCR and verify its registry digest"
        : operation === "prepare"
          ? "Build an image online, then verify offline without host dependency caches"
          : "Verify a prepared image without networking or host dependency caches",
    )
    .argument("<profile>");
  if (operation === "publish") command.requiredOption("--image <reference>", "Explicit ghcr.io/owner/image:tag");
  command.action((profile: string, options: { image?: string }) => {
    runCommand(
      root,
      `development ${operation}`,
      [
        "node",
        "{workbench}/bin/workbench.mjs",
        "offline-exec",
        operation,
        profile,
        ...(options.image ? [options.image] : []),
      ],
      true,
      "native",
      root,
      undefined,
      false,
    );
  });
}
program
  .command("offline-exec", { hidden: true })
  .argument("<operation>")
  .argument("<profile>")
  .argument("[image]")
  .action(async (operation: string, profile: string, image?: string) => {
    if (operation === "prepare") await prepareOfflineProfile(root, profile);
    else if (operation === "verify") await verifyOfflineProfile(root, profile);
    else if (operation === "publish" && image) await publishOfflineProfile(root, profile, image);
    else throw new Error("Unknown offline image operation");
  });
development
  .command("use")
  .description("Select an ignored local development profile; prompt when omitted")
  .argument("[profile]")
  .action(async (profile?: string) => {
    await useDevelopment(root, profile);
  });
program
  .command("shell")
  .description("Use the selected local development environment (interactive Bash or a command)")
  .option("--path <path>", "Registered language root relative to the repository", ".")
  .option("--profile <profile>", "Select a named development profile")
  .addOption(
    new Option("--environment <environment>", "Override the local selection").choices([
      "native",
      "nix",
      "guix",
      "devcontainer",
    ]),
  )
  .argument("[command...]", "Command and literal arguments after --; omit for an interactive shell")
  .action((command: string[], options: { path: string; environment?: string; profile?: string }) => {
    developmentShell(root, options.path, options.environment, command, options.profile);
  });
const tools = program
  .command("tools")
  .description("Show native tool pins and installation locations")
  .option("--path <path>", "Select one registered language root; default: all roots")
  .option("--json", "Show installation paths and acquisition policy identities as JSON")
  .option("--exclude-tool <name>", "Omit a declared tool from this plan; repeat to omit several", collect, [])
  .addOption(new Option("--compiler <family>", "Inspect a supported C/C++ compiler").choices(["clang", "gcc"]))
  .option("--compiler-version <version>", "Inspect an exact compiler compatibility target")
  .action((options: NativeToolSelection & { path?: string; json?: boolean }) => {
    if ((options.compiler || options.compilerVersion) && options.path === undefined)
      throw new Error("compiler overrides require --path");
    listNativeTools(root, options.path, options.json, options);
  });
tools
  .command("install")
  .description("Explicitly install and verify pinned native tools")
  .option("--path <path>", "Select one registered language root; default: all roots")
  .option("--tool <name>", "Install only one declared native tool in the selected roots")
  .option("--exclude-tool <name>", "Skip installing a tool; existing toolchain checks still apply", collect, [])
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
      if (options.tool !== undefined && options.excludeTool?.length) throw new Error("select --tool or --exclude-tool");
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
          ...(options.tool ? ["--tool", options.tool] : []),
          ...(options.excludeTool ?? []).flatMap((tool) => ["--exclude-tool", tool]),
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
  .option("--tool <name>")
  .option("--exclude-tool <name>", "", collect, [])
  .action((path: string | undefined, options: NativeToolSelection & { devcontainer?: boolean; tool?: string }) =>
    options.devcontainer ? installContainerTools(root) : installNativeTools(root, path, options, options.tool),
  );
program
  .command("package-manager-exec", { hidden: true })
  .option("--plan", "Print the verified bootstrap selection without installing it")
  .argument("[command...]")
  .action((command: string[], options: { plan?: boolean }) => {
    if (options.plan) {
      if (command.length) throw new Error("package-manager --plan does not execute a command");
      console.log(JSON.stringify(packageManagerInstallationPlan(process.cwd(), distributionRoot(root))));
      return;
    }
    if (!command.length) throw new Error("package-manager execution requires a command");
    const invocation = packageManagerCommand(process.cwd(), distributionRoot(root));
    execute(required(invocation[0], "package-manager execution needs a command"), [...invocation.slice(1), ...command]);
  });
program
  .command("php-coverage-exec", { hidden: true })
  .argument("<command...>")
  .action((command: string[]) => executePhpCoverage(process.cwd(), distributionRoot(root), command));

program
  .command("php-package-manager-exec", { hidden: true })
  .option("--bootstrap-path", "Verify and print the Composer PHAR used for API analysis")
  .argument("[command...]")
  .action(async (command: string[], options: { bootstrapPath?: boolean }) => {
    if (options.bootstrapPath) console.log(await composerBootstrap(process.cwd(), distributionRoot(root)));
    else {
      if (!command.length) throw new Error("Composer execution requires a command");
      await executeComposer(process.cwd(), distributionRoot(root), command);
    }
  });

program
  .command("ruby-package-manager-exec", { hidden: true })
  .argument("<command...>")
  .action((command: string[]) => executeBundler(process.cwd(), distributionRoot(root), command));
program
  .command("native-assets-prune", { hidden: true })
  .option("--check", "Reject obsolete entries without changing files")
  .option("--plan", "Emit the read-only replacement plan as JSON")
  .option("--apply", "Publish a formatted replacement received as JSON on stdin")
  .action((options: { check?: boolean; plan?: boolean; apply?: boolean }) => {
    if ([options.check, options.plan, options.apply].filter(Boolean).length > 1)
      throw new Error("native asset pruning modes are mutually exclusive");
    const distribution = distributionRoot(root);
    if (options.plan) {
      console.log(JSON.stringify(nativeAssetPruningPlan(distribution)));
      return;
    }
    const replacement = options.apply
      ? (JSON.parse(readFileSync(0, "utf8")) as { original: string; contents: string })
      : undefined;
    const removed = replacement
      ? publishNativeAssets(distribution, replacement.original, replacement.contents)
      : pruneNativeAssets(distribution, options.check);
    for (const entry of removed) console.log(`Removed obsolete native asset ${entry}.`);
  });
program
  .command("native-exec", { hidden: true })
  .argument("<directory>")
  .argument("<command...>")
  .action((directory: string, command: string[]) => {
    const paths = buildPaths(root, directory, process.env.WORKBENCH_DEVCONTAINER === "1" ? "devcontainer" : "native");
    prepareBuild(paths);
    const guarded = guardToolchains(directory, command);
    execute(required(guarded[0], "expected guarded[0]"), guarded.slice(1), {
      cwd: directory,
      env: {
        ...nativeEnvironment(directory, distributionRoot(root)),
        ...buildEnvironment(paths),
        ...executionEnvironment(root),
      },
    });
  });
program
  .command("managed-exec", { hidden: true })
  .argument("<builder>")
  .argument("<directory>")
  .argument("<command...>")
  .action((builder: string, directory: string, command: string[]) => {
    if (builder !== "nix" && builder !== "guix") throw new Error("managed-exec requires nix or guix");
    runCommand(directory, "managed container command", command, false, builder, root);
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
  .option("--sanitizers", "Match dependency instrumentation where required by the target ABI")
  .action((directory: string, build: string, options: { compiler?: "clang" | "gcc"; sanitizers?: boolean }) => {
    prepareVcpkg(directory, build, options.compiler, options.sanitizers);
  });
program
  .command("miri-exec", { hidden: true })
  .argument("<arguments...>")
  .action((args: string[]) => {
    runMiri(process.cwd(), args);
  });
const checks = program
  .command("checks")
  .description("Inspect the resolved local gate or focused role plan")
  .option("--json", "Print structured check selections, exclusions, commands, and sources")
  .option("--all", "Include excluded checks in the table")
  .option("--stage <stage>", "Inspect the commit or ci execution plan")
  .option("--role <role>", "Inspect a role, including manual coverage")
  .option("--project <id>", "Select a project and descendant check roots")
  .option("--path <path>", "Select one registered language root")
  .option("--environment <environment>", "Inspect an explicit execution environment")
  .option("--profile <profile>", "Inspect a named development profile")
  .action((options: CheckInspectionOptions) => {
    listChecks(root, options);
  });
addCISelectionOptions(
  program.command("ci").description("Rehearse all configured Linux x64 CI targets and local release verification"),
)
  .option("--path <path>", "Select one configured Linux CI root")
  .option("--target <ids...>", "Select target IDs from the rehearsal plan")
  .option("--json", "Print the structured rehearsal plan without execution")
  .option("--no-release", "Run CI checks without preparing and verifying release artifacts")
  .option("--plan", "Print the rehearsal plan without building or running containers")
  .action((options: LocalCIOptions & { plan?: boolean; json?: boolean }) => {
    if (options.plan || options.json) listLocalCI(root, options, options.json);
    else
      runCommand(
        root,
        "local Linux CI",
        [
          "node",
          "{workbench}/bin/workbench.mjs",
          "ci-exec",
          ...ciSelectionArguments(options),
          ...(options.path === undefined ? [] : ["--path", options.path]),
          ...(options.release === false ? ["--no-release"] : []),
          ...(options.target ? ["--target", ...options.target] : []),
        ],
        true,
        "native",
        root,
        undefined,
        false,
      );
  });
program
  .command("compatibility-exec", { hidden: true })
  .argument("<path>")
  .argument("<runtime>")
  .argument("<version>")
  .argument("[command...]")
  .option("--plan")
  .option("--checks", "Run declared compatibility commands")
  .action(
    async (
      path: string,
      runtime: string,
      version: string,
      command: string[],
      options: { plan?: boolean; checks?: boolean },
    ) => {
      if (options.checks && (options.plan || command.length))
        throw new Error("--checks selects configured commands; do not supply --plan or command arguments");
      if (options.plan) {
        if (command.length) throw new Error("compatibility --plan does not execute a command");
        console.log(JSON.stringify(compatibilityRuntimePlan(root, path, runtime, version)));
      } else if (options.checks) await runCompatibilityChecks(root, path, runtime, version);
      else await executeCompatibilityRuntime(root, path, runtime, version, command);
    },
  );
addCISelectionOptions(program.command("ci-exec", { hidden: true }))
  .option("--path <path>")
  .option("--target <ids...>")
  .option("--no-release")
  .action(async (options: LocalCIOptions) => {
    await runLocalCI(root, options);
  });
addCISelectionOptions(checks.command("matrix").description("Print configured CI matrices as JSON"))
  .option("--grouped", "Group roots sharing CI setup")
  .action((options: CISelectionOptions & { grouped?: boolean }) => {
    const selection = ciSelection(root, options);
    const matrix = selectedCIMatrix(ciMatrix(root), selection);
    console.log(JSON.stringify({ ...(options.grouped ? groupedCIMatrix(matrix) : matrix), selection }));
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
  .option("--profile <profile>", "Use a named development profile")
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
        if (!next || !command.createHelp().visibleCommands(command).includes(next))
          throw new Error(`unknown command in help path: ${name}`);
        command = next;
      }
      command.outputHelp();
    }
  });
function printAllHelp(): void {
  program.outputHelp();
  function visit(command: Command, path: string[]): void {
    for (const child of command.createHelp().visibleCommands(command)) {
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
dispatchInstallation(root, process.env.WORKBENCH_DISTRIBUTION_ROOT ?? resolve(__dirname, ".."), async () =>
  program.parseAsync(process.argv),
).catch((error: unknown) => {
  console.error(`workbench: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
