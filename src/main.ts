import { finalizeImage } from "./image-finalization.js";
import { buildProjectImage } from "./buildkit.js";
import { checkPolicyCompatibility } from "./policy-compatibility.js";
import { checkSecrets } from "./secrets.js";
import { checkAdvisories } from "./advisories.js";
import { required } from "./invariants.js";
import { checkDocExamples } from "./doc-examples.js";
import { checkReview, reviewInteractively } from "./review.js";
import { checkRecordRetention } from "./record-retention.js";
import { observeCommand } from "./test-timing.js";
import { Command, Help, Option } from "commander";
import { configureCommandHelp } from "./cli-help.js";
import { registerSkillCommands } from "./skill-commands.js";
import { hasCollectionProject } from "./collections.js";
import { relative, resolve } from "node:path";
import { withToolCacheUse } from "./tool-cache-lock.js";
import { recordResultTools, selectedToolRequirements } from "./tool-references.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { projectRoot, distributionRoot, readConfig, readLanguageRoots } from "./core.js";
import { syncMaps } from "./maps.js";
import { registerRecordCommands } from "./record-commands.js";
import { QueryCommand } from "./query-command.js";
import { syncRecordSequences } from "./record-sequences.js";
import { syncReleaseIndexes } from "./releases.js";
import { initLanguage, listLanguages, reportLanguages } from "./languages.js";
import { runCheckSession } from "./checks.js";
import { runGate, type GateOptions } from "./check-gates.js";
import { ChecksCancelled } from "./check-cancellation.js";
import { managedImageRoots, prepareHostManagedImage } from "./managed-image.js";
import { recordBuilderVolumes } from "./builder-cache.js";
import type { CheckSelection } from "./check-plan.js";
import { developmentShell } from "./shell.js";
import { shellSession, decodeShellSession } from "./shell-session.js";
import { ciMatrix } from "./ci.js";
import { compatibilityRuntimePlan, executeCompatibilityRuntime, runCompatibilityChecks } from "./ci-runtime.js";
import { groupedCIMatrix, ciTargets } from "./ci-targets.js";
import { listLocalCI, runLocalCI, type LocalCIOptions } from "./local-ci.js";
import { nativeCheckEnvironment } from "./check-environment.js";
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
import { guardToolchains, quote, resolveCheckCommand } from "./toolchains.js";
import { configScopes, showConfiguration, setConfiguration, type ConfigScope } from "./config-command.js";
import { completionCandidates, completionScript, installCompletion } from "./completion.js";
import { listDevelopment, useDevelopment } from "./development.js";
import { developmentImages, runOfflineOperation, type ImageOptions } from "./development-images.js";
import {
  prepareOfflineProfile,
  verifyOfflineProfile,
  publishOfflineProfile,
  executePreparedProfile,
  offlineProfile,
  offlineImageReference,
} from "./offline-profiles.js";
import { listToolProfiles } from "./tool-profiles.js";
import { listReleaseProfiles, prepareReleases } from "./release-profiles.js";
import { dependencySetup, pnpmStorageConfiguration } from "./dependencies.js";
import { executePhpCoverage } from "./php-coverage.js";
import { executeComposer, composerBootstrap } from "./php-manager.js";
import { executeBundler } from "./ruby-manager.js";
import { executeManagedCommand } from "./managed-input-environment.js";
import { packageManagerCommand, packageManagerInstallationPlan } from "./package-manager.js";
import { nativeAssetPruningPlan, pruneNativeAssets, publishNativeAssets } from "./native-asset-maintenance.js";
import { registerCollectionCommands } from "./collection-commands.js";
import { registerInstallationCommands } from "./installation-commands.js";
import { configureDirenv, direnvWatchPaths } from "./direnv.js";
import { registerCacheCommands } from "./build-cache.js";
import { configurePresentation } from "./presentation.js";
import { readUserConfig } from "./user-config.js";

import { inspectCICache, type CacheInspectionRequest } from "./ci-cache-inspection.js";

const program = new Command();
program
  .command("ci-cache-inspect", { hidden: true })
  .argument("<request>")
  .action((request: string) => {
    console.log(JSON.stringify(inspectCICache(root, JSON.parse(request) as CacheInspectionRequest)));
  });
program.name("workbench").description("Shared agentic software-development context and workflows");
program.helpCommand(false).enablePositionalOptions().showHelpAfterError();
function isGateCommand(command: Command): boolean {
  return command.parent === program && ["check", "pre-commit", "pre-push"].includes(command.name());
}
program.option("--help-all", "Print help for every public command").action((options: { helpAll?: boolean }) => {
  if (options.helpAll) printAllHelp();
  else program.outputHelp();
});
// Accept shared options before or after an action, but never silently discard a browse-only option.
program.hook("preAction", (_program, action) => {
  // Snapshot checks validate their explicit tree, not the launcher's working checkout.
  const suppliedRoot =
    [action.name(), action.parent?.name(), action.parent?.parent?.name()].some((name) =>
      ["config", "cache", "completion", "complete", "install"].includes(name ?? ""),
    ) ||
    action.name() === "review" ||
    action.parent?.name() === "review" ||
    action.name() === "observe" ||
    ["validate", "setup-project", "secrets"].includes(action.name()) ||
    isGateCommand(action);
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
  // Resolve after shared-option inheritance, before any command emits user-facing output.
  configurePresentation(
    action.getOptionValue("plain") as boolean | undefined,
    readUserConfig()["terminal.plain"] === true,
  );
});
process.env.WORKBENCH_DISTRIBUTION_ROOT ??= resolve(__dirname, "..");
const root = projectRoot();
registerSkillCommands(program, root);
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
registerCacheCommands(program, root);
registerCollectionCommands(program, root);
registerInstallationCommands(program, root);
program
  .command("setup")
  .description("Configure the root project and Git change gates")
  .option("--id <id>", "Root project ID (default: existing ID or directory name)")
  .option("--direnv", "Create or compose direnv hooks for registered build roots")
  .action(async (options: { id?: string; direnv?: boolean }) => {
    await setupProject(root, options.id);
    if (options.direnv) configureDirenv(root);
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
const review = program
  .command("review")
  .description("Review and approve protected staged records in an interactive terminal")
  .action(() => reviewInteractively(root));
review
  .command("check", { hidden: true })
  .argument("<repository>", "Owning checkout for the staged review receipt")
  .action((repository: string) => {
    checkRecordRetention(resolve(repository));
    checkReview(resolve(repository));
  });
program
  .command("update")
  .description("Update the pinned Workbench dependency, migrate records, and validate before applying")
  .argument("<revision>", "Full Git commit for the executable; collection updates are separate")
  .action((revision?: string) => {
    return updateWorkbench(root, revision);
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
  .description("Format Markdown, JSON, or YAML; print a file, or use --write / --check")
  .argument("[path]", "Markdown, JSON, or YAML file path")
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
  .description("Show build, prepared artifact, and dependency locations, or emit shell/direnv integration")
  .option("--path <path>", "Language root relative to the repository (default: current directory)")
  .option("--environment <environment>", "Select the execution environment")
  .option("--toolchain <name>", "Select a named native compiler/runtime profile")
  .option("--shell", "Prepare build storage and print shell exports")
  .option("--direnv", "Print shell exports and direnv watches for selected settings and tool inputs")
  .action((options: { path?: string; environment?: string; toolchain?: string; shell?: boolean; direnv?: boolean }) => {
    if (options.shell && options.direnv) throw new Error("select --shell or --direnv, not both");
    const paths = buildPaths(
      root,
      options.path === undefined ? process.cwd() : resolve(root, options.path),
      options.environment === undefined ? undefined : checkEnvironment(options.environment, "--environment"),
      options.toolchain === undefined ? {} : { toolchain: options.toolchain },
    );
    if (options.shell || options.direnv) {
      prepareBuild(paths);
      for (const [key, value] of Object.entries(buildEnvironment(paths))) console.log(`export ${key}=${quote(value)}`);
      if (options.direnv) console.log(`watch_file ${direnvWatchPaths(root, paths).map(quote).join(" ")}`);
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
program
  .command("ci-image-exec", { hidden: true })
  .argument("<profile>")
  .argument("[command...]")
  .option("--image <id>")
  .option("--reports <path>")
  .option("--env-json <json>")
  .action(
    async (profile: string, command: string[], options: { image?: string; reports?: string; envJson?: string }) => {
      if (!command.length) throw new Error("ci-image-exec needs a command");
      const env: unknown = options.envJson ? JSON.parse(options.envJson) : {};
      if (
        !env ||
        typeof env !== "object" ||
        Array.isArray(env) ||
        Object.entries(env).some(
          ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"),
        )
      )
        throw new Error("Invalid container environment");
      await executePreparedProfile(root, profile, command, {
        ...(options.image ? { image: options.image } : {}),
        ...(options.reports ? { reports: resolve(options.reports) } : {}),
        env: env as Record<string, string>,
      });
    },
  );
const development = program
  .command("development")
  .description("Inspect named development profiles and local selection")
  .option("--json")
  .action((options: { json?: boolean }) => {
    listDevelopment(root, options.json);
  });
development
  .command("images")
  .description("Inspect development images and select preparation and publication in a terminal")
  .argument("[profiles...]", "Configured prepared profiles; defaults to all")
  .option("--list", "Show image status without preparation or publication prompts")
  .option("--require", "Check registry availability without prompts; fail if any selected image is unavailable")
  .option("--json", "Print image references and availability as JSON without prompts")
  .action(async (profiles: string[], options: ImageOptions) => developmentImages(root, profiles, options));
for (const operation of ["prepare", "verify", "publish"] as const) {
  const command = development
    .command(operation)
    .description(
      operation === "publish"
        ? "Push a verified development image and verify its registry digest"
        : operation === "prepare"
          ? "Build an image online, then verify offline without host dependency caches"
          : "Verify a prepared image without networking or host dependency caches",
    )
    .argument("<profile>");
  if (operation === "publish")
    command.option("--image <reference>", "Override the configured registry repository and input tag");
  if (operation === "prepare")
    command
      .option("--build", "Build locally without reusing a registry image")
      .option("--fresh", "Execute offline verification even when matching local evidence exists")
      .option("--pull-only", "Require the configured registry image; never build locally");
  command.action(
    (profile: string, options: { image?: string; build?: boolean; pullOnly?: boolean; fresh?: boolean }) => {
      runOfflineOperation(root, operation, profile, options);
    },
  );
}
program
  .command("offline-exec", { hidden: true })
  .argument("<operation>")
  .argument("<profile>")
  .argument("[image]")
  .option("--build")
  .option("--fresh")
  .option("--pull-only")
  .action(
    async (
      operation: string,
      profile: string,
      image: string | undefined,
      options: { build?: boolean; pullOnly?: boolean; fresh?: boolean },
    ) => {
      if (operation === "prepare" || operation === "publish") {
        offlineProfile(root, profile);
        await installContainerTools(root);
      }
      if (operation === "prepare") await prepareOfflineProfile(root, profile, options);
      else if (operation === "verify") await verifyOfflineProfile(root, profile);
      else if (operation === "publish")
        await publishOfflineProfile(root, profile, image ?? offlineImageReference(root, profile));
      else throw new Error("Unknown offline image operation");
    },
  );
development
  .command("use")
  .description("Select an ignored local development profile; prompt when omitted")
  .argument("[profile]")
  .addOption(
    new Option("--workspace <workspace>", "Select the local execution workspace independently of the builder").choices([
      "host",
      "devcontainer",
    ]),
  )
  .action(async (profile: string | undefined, options: { workspace?: string }) => {
    await useDevelopment(root, profile, options.workspace);
  });
program
  .command("shell")
  .description("Use the selected environment and platform shell, or run a literal command")
  .option("--path <path>", "Registered language root relative to the repository", ".")
  .option("--profile <profile>", "Select a named development profile")
  .addOption(
    new Option("--workspace <workspace>", "Override the profile's workspace").choices(["host", "devcontainer"]),
  )
  .option("--toolchain <name>", "Select a named native compiler/runtime profile")
  .addOption(
    new Option("--environment <environment>", "Override the local selection").choices([
      "native",
      "nix",
      "guix",
      "devcontainer",
    ]),
  )
  .argument("[command...]", "Command and literal arguments after --; omit for an interactive shell")
  .action(
    (
      command: string[],
      options: { path: string; environment?: string; profile?: string; toolchain?: string; workspace?: string },
    ) =>
      developmentShell(
        root,
        options.path,
        options.environment,
        command,
        options.profile,
        options.toolchain,
        options.workspace,
      ),
  );
program
  .command("shell-session", { hidden: true })
  .argument("<context>")
  .action(async (text: string) => {
    const value = decodeShellSession(
      text,
      readLanguageRoots(root).map((entry) => entry.path),
    );
    const command = resolveCheckCommand(resolve(root, value.path), value.command, distributionRoot(root));
    configurePresentation(value.plain, false);
    if (value.noColor) process.env.NO_COLOR = "1";
    process.exitCode = await shellSession(root, distributionRoot(root), value, command);
  });
const tools = program
  .command("tools")
  .description("Show native tool pins and installation locations")
  .option("--toolchain <name>", "Select a named native compiler/runtime profile")
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
program
  .command("tools-install", { hidden: true })
  .argument("[path]")
  .option("--devcontainer")
  .option("--compiler <family>")
  .option("--compiler-version <version>")
  .option("--toolchain <name>")
  .option("--tool <name>")
  .option("--exclude-tool <name>", "", collect, [])
  .action((path: string | undefined, options: NativeToolSelection & { devcontainer?: boolean; tool?: string }) =>
    options.devcontainer ? installContainerTools(root) : installNativeTools(root, path, options, options.tool),
  );
program.command("managed-image-roots", { hidden: true }).action(() => {
  console.log(
    JSON.stringify(
      managedImageRoots(
        root,
        process.env.WORKBENCH_MANAGED_ROOTS ? (JSON.parse(process.env.WORKBENCH_MANAGED_ROOTS) as unknown) : undefined,
      ),
    ),
  );
});
program
  .command("managed-builder-record", { hidden: true })
  .argument("<builder>")
  .argument("<cache>")
  .action((builder: string, cache: string) => {
    recordBuilderVolumes(root, builder, cache);
  });
program
  .command("image-finalize", { hidden: true })
  .argument("<source>")
  .argument("<target>")
  .option("--materialize <files...>", "Materialize declared container account files")
  .action((source: string, target: string, options: { materialize?: string[] }) =>
    finalizeImage(source, target, {}, options.materialize ?? []),
  );
program
  .command("buildkit-build", { hidden: true })
  .allowUnknownOption()
  .argument("<arguments...>")
  .action((args: string[]) => buildProjectImage(root, args));
program
  .command("managed-image-prepare", { hidden: true })
  .argument("<builder>")
  .argument("<image>")
  .argument("<roots-file>")
  .argument("<output>")
  .action((builder: string, image: string, rootsFile: string, output: string) =>
    prepareHostManagedImage(root, builder, image, rootsFile, output),
  );
program
  .command("managed-inputs-exec", { hidden: true })
  .argument("<command...>")
  .action((command: string[]) => executeManagedCommand(process.cwd(), command));
program
  .command("package-manager-exec", { hidden: true })
  .option("--plan", "Print the verified bootstrap selection without installing it")
  .argument("[command...]")
  .action(async (command: string[], options: { plan?: boolean }) => {
    if (options.plan) {
      if (command.length) throw new Error("package-manager --plan does not execute a command");
      console.log(JSON.stringify(packageManagerInstallationPlan(process.cwd(), distributionRoot(root))));
      return;
    }
    if (!command.length) throw new Error("package-manager execution requires a command");
    const invocation = await packageManagerCommand(process.cwd(), distributionRoot(root));
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
    withToolCacheUse(
      () => {
        const paths = buildPaths(
          root,
          directory,
          process.env.WORKBENCH_DEVCONTAINER === "1" ? "devcontainer" : "native",
        );
        prepareBuild(paths);
        if (paths.external && paths.identity.environment === "native") {
          const tools = selectedToolRequirements(root, relative(root, directory).replaceAll("\\", "/") || ".");
          recordResultTools({
            directory: paths.directory,
            storageRoot: paths.storageRoot,
            identity: paths.identity,
            kind: "builds",
            tools,
          });
        }
        const guarded = guardToolchains(directory, command);
        execute(required(guarded[0], "expected guarded[0]"), guarded.slice(1), {
          cwd: directory,
          env: nativeCheckEnvironment(root, paths.projectDirectory, {}, undefined, paths),
        });
      },
      selectedToolRequirements(root, relative(root, directory).replaceAll("\\", "/") || "."),
    );
  });
program
  .command("managed-exec", { hidden: true })
  .argument("<builder>")
  .argument("<directory>")
  .argument("<command...>")
  .action((builder: string, directory: string, command: string[]) => {
    if (builder !== "nix" && builder !== "guix") throw new Error("managed-exec requires nix or guix");
    runCommand(directory, "managed container command", command, builder, root);
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
function gateCommand(name: "check" | "pre-commit" | "pre-push"): Command {
  const command = program
    .command(name)
    .description(
      name === "check"
        ? "Run the commit gate, then online checks when connectivity is available"
        : name === "pre-commit"
          ? "Run the complete offline commit gate"
          : "Run required online checks fresh before pushing",
    )
    .option("--list", "List selected checks without executing them")
    .addOption(new Option("--json", "Print the check plan as JSON (implies --list)").implies({ list: true }))
    .option("--verbose", "Stream full command output (also WORKBENCH_VERBOSE=1)")
    .option("--project <id>", "Select a project and descendant check roots")
    .option("--path <path>", "Select one registered language root")
    .option("--environment <environment>", "Override the selected execution environment")
    .option("--profile <profile>", "Use a named development profile")
    .addOption(
      new Option("--workspace <workspace>", "Override the profile's workspace").choices(["host", "devcontainer"]),
    )
    .argument("[root]", "Project tree (default: current project root)");
  if (name !== "pre-push")
    command
      .option("--no-cache", "Run checks fresh instead of reusing a matching successful gate")
      .addOption(new Option("--all", "Include excluded checks in the plan (implies --list)").implies({ list: true }))
      .addOption(new Option("--compiler <family>", "Select a supported C/C++ compiler").choices(["clang", "gcc"]))
      .option("--compiler-version <version>", "Select an exact C/C++ compiler version")
      .option("--toolchain <name>", "Use a named compiler/runtime profile");
  if (name === "check")
    command
      .option("--stage <stage>", "Run only the commit or ci stage")
      .option(
        "--role <role>",
        "Include a role (repeatable); includes setup and skips structural validation",
        collect,
        [],
      )
      .option("--exclude-role <role>", "Exclude a role (repeatable); required setup cannot be excluded", collect, [])
      .option("--report <path>", "Write a versioned JSON execution report")
      .option(
        "--connectivity-url <url>",
        "HTTP(S) connectivity probe for the combined gate (default: https://api.osv.dev/)",
      );
  return command.action(async (requested: string | undefined, options: GateOptions) => {
    await runGate(requested ? resolve(requested) : root, name, options);
  });
}
const checks = gateCommand("check");
gateCommand("pre-commit");
gateCommand("pre-push");
program
  .command("checks-session", { hidden: true })
  .argument("<directory>")
  .argument("<environment>")
  .argument("<selection>")
  .argument("<control>")
  .action(async (directory: string, environment: string, selection: string, control: string) => {
    try {
      await runCheckSession(root, JSON.parse(selection) as CheckSelection, directory, environment, control);
    } finally {
      if (process.connected) process.disconnect();
    }
  });
program
  .command("ci")
  .description("Rehearse configured Linux x64 CI targets and release verification")
  .option("--path <path>", "Select one configured Linux CI root")
  .option("--target <ids...>", "Select target IDs from the rehearsal plan")
  .option("--json", "Print the structured rehearsal plan without execution")
  .option("--no-release", "Run CI checks without preparing and verifying release artifacts")
  .option("--plan", "Print the rehearsal plan without building or running containers")
  .action(async (options: LocalCIOptions & { plan?: boolean; json?: boolean }) => {
    if (options.plan || options.json) listLocalCI(root, options, options.json);
    else await runLocalCI(root, options);
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
checks
  .command("matrix")
  .description("Print configured CI matrices as JSON")
  .addOption(new Option("--grouped", "Group roots sharing CI setup").conflicts("targets"))
  .option("--targets", "Print exact per-root tool and environment selections")
  .action((options: { grouped?: boolean; targets?: boolean }) => {
    if (options.targets) console.log(JSON.stringify(ciTargets(root)));
    else {
      const matrix = ciMatrix(root);
      console.log(JSON.stringify(options.grouped ? groupedCIMatrix(matrix) : matrix));
    }
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
program
  .command("help")
  .description("Print help for the root or a command path")
  .argument("[path...]", "Command path, such as record add")
  .option("--all", "Print help for every public command")
  .action((path: string[], options: { all?: boolean }) => {
    if (options.all) {
      if (path.length) throw new Error("help --all cannot be combined with a command path");
      printAllHelp();
    } else {
      let command = program;
      for (const name of path) {
        const next = command.commands.find((candidate) => candidate.name() === name);
        if (!next || !new Help().visibleCommands(command).includes(next))
          throw new Error(`unknown command in help path: ${name}`);
        command = next;
      }
      command.outputHelp();
    }
  });
let showFullHelp = false;
const projectCommands = new Set([
  "shell-session",
  "project",
  "format",
  "advisories",
  "record",
  "citation",
  "release",
  "review",
  "update",
  "sync",
  "validate",
  "paths",
  "development",
  "shell",
  "tools",
  "check",
  "pre-commit",
  "pre-push",
  "checks-session",
  "ci",
  "docs",
]);
configureCommandHelp(program, (command, visible) => {
  if (showFullHelp || hasCollectionProject(root)) return visible;
  return visible.filter((child) =>
    command === program
      ? !projectCommands.has(child.name())
      : command.name() === "language"
        ? !["roots", "init"].includes(child.name())
        : true,
  );
});
function printAllHelp(): void {
  showFullHelp = true;
  try {
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
  } finally {
    showFullHelp = false;
  }
}
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
function sync(): number {
  return synchronize(root);
}
// Inspection and reconciliation remain available while compatibility review is stale.
const policyExecutionCommands = new Set([
  "shell-session",
  "shell",
  "ci",
  "check",
  "pre-commit",
  "pre-push",
  "checks-session",
  "release prepare",
  "development prepare",
  "development verify",
  "development publish",
  "development use",
  "tools install",
  "commit check",
  "ci-image-exec",
  "devcontainer-exec",
  "offline-exec",
  "tools-install",
  "package-manager-exec",
  "managed-inputs-exec",
  "managed-image-prepare",
  "buildkit-build",
  "image-finalize",
  "managed-builder-record",
  "managed-image-roots",
  "php-coverage-exec",
  "php-package-manager-exec",
  "ruby-package-manager-exec",
  "native-exec",
  "managed-exec",
  "vcpkg-prepare",
  "miri-exec",
  "compatibility-exec",
  "dependency-setup",
  "update",
  "update-prepare",
  "docs",
]);
program.hook("preAction", (_program, action) => {
  const lineage: string[] = [];
  for (let command: Command | null = action; command; command = command.parent) lineage.unshift(command.name());
  const path = lineage.slice(1).join(" ");
  const explicitTree = action.name() === "validate" || isGateCommand(action) ? action.args[0] : undefined;
  if (
    !hasCollectionProject(explicitTree ? resolve(explicitTree) : root) &&
    (projectCommands.has(lineage[1] ?? "") || ["language roots", "language init"].includes(path))
  )
    throw new Error(
      "this command requires a configured Workbench project; enter a project directory or run workbench setup",
    );
  const inspection =
    (isGateCommand(action) && action.getOptionValue("list") === true) ||
    (action.name() === "ci" && (action.getOptionValue("plan") === true || action.getOptionValue("json") === true)) ||
    (action.name() === "compatibility-exec" && action.getOptionValue("plan") === true);
  if (!inspection && policyExecutionCommands.has(path)) {
    const requested = isGateCommand(action) || action.name() === "devcontainer-exec" ? action.args[0] : undefined;
    checkPolicyCompatibility(requested ? resolve(requested) : root);
  }
});
async function start(): Promise<void> {
  function presentationOptions(command: Command): void {
    command.option("--plain", "Use stable plain text and line-oriented prompts");
    command.option("--no-plain", "Override a saved or inherited plain presentation preference");
    for (const child of command.commands) presentationOptions(child);
  }
  presentationOptions(program);
  await program.parseAsync(process.argv);
}
start().catch((error: unknown) => {
  console.error(`workbench: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof ChecksCancelled ? 130 : 1;
});
