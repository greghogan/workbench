import { projectPaths } from "../core/projects/project-paths.js";
import { Command, CommanderError, Help, Option } from "commander";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { hasCollectionProject } from "../core/collections/collections.js";
import { checkPolicyCompatibility } from "../core/collections/policy-compatibility.js";
import { readUserConfig, userConfigValues } from "../core/configuration/user-config.js";
import { diagnosticOptions } from "../core/diagnostics/diagnostic-contract.mjs";
import { resolveDiagnosticOptions } from "../core/diagnostics/diagnostic-options.js";
import { startDiagnosticSession } from "../core/diagnostics/diagnostic-session.js";
import {
  configureDiagnostics,
  diagnostic,
  DiagnosticOperation,
  DiagnosticOutcome,
  formatDiagnosticSections,
  LogLevel,
  setDiagnosticTextWidth,
  minimumLogLevel,
  LogScope,
  settleCleanup,
  UserFacingError,
} from "../core/diagnostics/diagnostics.mjs";
import { configurePresentation } from "../core/diagnostics/presentation.js";
import { terminalColumns } from "../core/diagnostics/terminal-text.js";
import { executableIdentity } from "../core/distribution/executable-identity.js";
import { prepareUpdate } from "../core/distribution/update-prepare.js";
import { updateWorkbench } from "../core/distribution/update.js";
import { checkAdvisories } from "../core/execution/checks/advisories.js";
import { ChecksCancelled } from "../core/execution/checks/check-cancellation.js";
import { observeCommand } from "../core/execution/checks/test-timing.js";
import { inspectCICache, type CacheInspectionRequest } from "../core/execution/ci/ci-cache-inspection.js";
import { readConfig } from "../core/projects/project-configuration.js";
import { distributionRoot, projectRoot } from "../core/projects/project-context.js";
import { registrationRoot } from "../core/projects/project-registration.js";
import { projectRegistration, Registration } from "../core/projects/project-registry.js";
import { checkDocExamples } from "../core/records/doc-examples.js";
import { formatFiles } from "../core/records/formatting.js";
import { syncMaps } from "../core/records/maps.js";
import { checkRecordRetention } from "../core/records/record-retention.js";
import { syncRecordSequences } from "../core/records/record-sequences.js";
import { syncReleaseIndexes } from "../core/records/releases.js";
import { synchronize } from "../core/records/sync.js";
import { validate } from "../core/records/validation.js";
import { checkAgentCommit } from "../core/review/agent-review.js";
import { checkReview } from "../core/review/review-check.js";
import { checkSecrets } from "../core/runtime/secrets.js";
import { withMicrosoftSDKOperation } from "../core/toolchains/mvsc.js";
import { registerAgentReviewCommands } from "./agent-review.js";
import { registerCacheCommands } from "./cache.js";
import { registerCheckCommands } from "./checks.js";
import { registerCollectionCommands } from "./collections.js";
import { commandAdmission, commandPath, registerCommand, validateCommandAdmissions } from "./commands.js";
import { registerCommitCommands } from "./commits.js";
import { completionCandidates, completionScript, installCompletion } from "./completion.js";
import { registerConfigurationCommands } from "./configuration.js";
import { registerDevelopmentCommands } from "./development.js";
import { registerEnvironmentInternals } from "./environment-internals.js";
import { registerExperimentCommands } from "./experiments.js";
import { registerFeedbackCommands } from "./feedback-commands.js";
import { configureCommandHelp } from "./help.js";
import { registerInstallationCommands } from "./installation.js";
import { registerLogCommands } from "./logs.js";
import { pageHelp } from "./pager.js";
import { requireProjectRegistration } from "./project-admission.js";
import { setupProject } from "./project-setup.js";
import { registerProjectCommands } from "./projects.js";
import { registerRecordCommands } from "./records.js";
import { registerReleaseCommands } from "./releases.js";
import { reviewInteractively } from "./review.js";
import { registerServerCommands } from "./server.js";
import { registerSetupCommands } from "./setup.js";
import { registerSkillCommands } from "./skills.js";
import { registerTaskCommands } from "./tasks.js";
import { registerToolInternals } from "./tool-internals.js";
import { registerToolCommands } from "./tools.js";

export function createCLI(root: string = projectRoot()) {
  let diagnosticSession: Awaited<ReturnType<typeof startDiagnosticSession>> | undefined;
  let activeCommand = "workbench";
  let preferences: ReturnType<typeof readUserConfig> | undefined;
  const userPreferences = () => {
    preferences ??= readUserConfig();
    return preferences;
  };
  const recordCommand = (outcome: DiagnosticOutcome, error?: unknown) => {
    if (diagnosticSession) diagnosticSession.recordCommand(activeCommand, outcome, error);
    else if (outcome !== DiagnosticOutcome.Failed)
      diagnostic(LogLevel.Debug, DiagnosticOperation.Command, outcome, { command: activeCommand });
  };
  const reportFailure = (error: unknown) => {
    diagnostic(
      LogLevel.Error,
      DiagnosticOperation.Command,
      DiagnosticOutcome.Failed,
      { command: activeCommand, ...(diagnosticSession ? { diagnostics: diagnosticSession.directory } : {}) },
      error,
    );
    process.exitCode = error instanceof ChecksCancelled ? 130 : 1;
  };
  let failedParseCommand: Command | undefined;
  setDiagnosticTextWidth(terminalColumns);
  const program = new Command();
  const helpOutput: string[] = [];
  program.configureOutput({
    writeOut: (text) => {
      helpOutput.push(text);
    },
    // The final diagnostic presenter reports parse errors once, including structured causes.
    outputError: () => undefined,
  });
  registerCommand(program, "ci-cache-inspect", { hidden: true })
    .argument("<request>")
    .action((request: string) => {
      console.log(JSON.stringify(inspectCICache(root, JSON.parse(request) as CacheInspectionRequest)));
    });
  program.name("workbench").description("Shared agentic software-development context and workflows");
  program.helpCommand(false).enablePositionalOptions();
  function isGateCommand(command: Command): boolean {
    return command.parent === program && ["check", "pre-commit", "pre-push"].includes(command.name());
  }
  program.option("--help-all", "Print help for every public command").action((options: { helpAll?: boolean }) => {
    if (options.helpAll) printAllHelp();
    else program.outputHelp();
  });
  program.option("--no-pager", "Print help directly without interactive paging");
  // Accept shared options before or after an action, but never silently discard a browse-only option.
  program.hook("preAction", async (_program, action) => {
    activeCommand = commandPath(action) || program.name();
    // Snapshot checks validate their explicit tree, not the launcher's working checkout.
    const suppliedRoot = commandAdmission(commandPath(action)).explicitRoot;
    for (let ancestor = action.parent; ancestor; ancestor = ancestor.parent) {
      for (const option of ancestor.options) {
        const key = option.attributeName();
        if (key === "pager") continue;
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
    const cli = {
      ...(typeof action.getOptionValue("logLevel") === "string"
        ? { logLevel: action.getOptionValue("logLevel") as string }
        : {}),
      ...(typeof action.getOptionValue("logFileLevel") === "string"
        ? { logFileLevel: action.getOptionValue("logFileLevel") as string }
        : {}),
      ...(typeof action.getOptionValue("logFormat") === "string"
        ? { logFormat: action.getOptionValue("logFormat") as string }
        : {}),
    };
    let preferences: ReturnType<typeof readUserConfig>;
    try {
      preferences = userPreferences();
    } catch (error) {
      configureDiagnostics(resolveDiagnosticOptions(cli, process.env));
      throw error;
    }
    configurePresentation(
      action.getOptionValue("plain") as boolean | undefined,
      preferences["terminal.plain"] === true,
    );
    const { level, fileLevel, format, persist } = resolveDiagnosticOptions(
      cli,
      process.env,
      preferences,
      action.name() === "serve" ? "server" : "cli",
    );
    configureDiagnostics({ level, format });
    process.env.WORKBENCH_LOG_LEVEL = persist ? minimumLogLevel(level, fileLevel) : level;
    process.env.WORKBENCH_LOG_FILE_LEVEL = fileLevel;
    process.env.WORKBENCH_LOG_FORMAT = format;
    if (
      persist &&
      !diagnosticSession &&
      !commandAdmission(commandPath(action)).internal &&
      !["completion", "help"].includes(commandPath(action).split(" ")[0] ?? "")
    )
      diagnosticSession = await startDiagnosticSession(
        fileLevel,
        action.name() === "serve" ? LogScope.Server : LogScope.Cli,
        userConfigValues(preferences),
      ).catch((error: unknown) => {
        diagnostic(
          LogLevel.Warn,
          DiagnosticOperation.PersistentDiagnostics,
          DiagnosticOutcome.Unavailable,
          {},
          error,
          "persistent diagnostics unavailable; command continues with stderr diagnostics",
        );
        return undefined;
      });
    if (diagnosticSession && action.name() === "serve") console.log(`Server logs: ${diagnosticSession.directory}`);
    recordCommand(DiagnosticOutcome.Started);
    if (
      !suppliedRoot &&
      existsSync(join(root, projectPaths.config)) &&
      !["workbench", "help", "update", "update-prepare"].includes(action.name())
    )
      readConfig(root);
  });
  registerProjectCommands(program);
  registerCommand(program, "registration-check", { hidden: true }).action(() => {
    if (projectRegistration(registrationRoot(root)) !== Registration.Registered)
      throw new Error("The selected Workbench release cannot find this checkout's registration");
  });
  registerSkillCommands(program, root);
  registerCommand(program, "executable")
    .description("Inspect the running Workbench repository, revision, installation directory, and Node runtime")
    .option("--json", "Print the versioned executable identity as JSON")
    .action((options: { json?: boolean }) => {
      const identity = executableIdentity(distributionRoot(root));
      if (options.json) console.log(JSON.stringify(identity, null, 2));
      else {
        console.log(`Repository: ${identity.repository ?? "unrecorded development source"}`);
        console.log(`Revision: ${identity.revision ?? "unrecorded development revision"}`);
        console.log(`Directory: ${identity.directory}`);
        console.log(`Node: ${identity.node.version} (${identity.node.executable})`);
      }
    });
  const completion = registerCommand(program, "completion")
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
  registerCommand(program, "complete", { hidden: true })
    .option("--empty")
    .argument("[words...]")
    .action((words: string[], options: { empty?: boolean }) => {
      const candidates = completionCandidates(program, options.empty ? [...words, ""] : words);
      if (candidates.length) console.log(candidates.join("\n"));
    });
  registerConfigurationCommands(program, root);
  registerCommand(program, "secrets [path]")
    .description("Check project source files for recognized credentials")
    .action((path?: string) => {
      checkSecrets(resolve(path ?? root));
    });
  registerCommand(program, "advisories <language>")
    .description("Check this language root's locked dependencies against OSV (network required)")
    .action(async (language: string) => {
      await checkAdvisories(process.cwd(), language);
    });
  registerCacheCommands(program, root);
  registerLogCommands(program);
  registerCollectionCommands(program, root);
  registerInstallationCommands(program, root);
  registerSetupCommands(program, root, sync);
  registerRecordCommands(program, root, sync);
  registerTaskCommands(program, root);
  registerExperimentCommands(program, root);
  registerReleaseCommands(program, root);
  registerFeedbackCommands(program, root);
  registerServerCommands(program, root);
  const review = registerCommand(program, "review")
    .description("Review protected records or record agent change and task review")
    .action(() => reviewInteractively(root));
  registerAgentReviewCommands(review, root);
  review
    .command("check", { hidden: true })
    .argument("<repository>", "Owning checkout for the staged review receipt")
    .action((repository: string) => {
      checkRecordRetention(resolve(repository));
      checkReview(resolve(repository));
      checkAgentCommit(resolve(repository), process.env.WORKBENCH_REVIEW_TREE);
    });
  registerCommand(program, "update")
    .description("Prepare and validate an executable-pin update; collection updates are separate")
    .argument("<revision>", "Full Git commit for the executable; collection updates are separate")
    .action((revision?: string) => {
      return updateWorkbench(root, revision);
    });
  registerCommand(program, "update-prepare", { hidden: true }).action(async () => {
    if (!process.env.WORKBENCH_UPDATE_PREPARATION || realpathSync(process.env.WORKBENCH_UPDATE_PREPARATION) !== root)
      throw new Error("update-prepare is an internal operation; use 'workbench update REVISION'");
    await prepareUpdate(root);
  });
  registerCommand(program, "sync")
    .description("Refresh maps, agent context, record sequences, indexes, and skill discovery")
    .action(() => {
      if (!sync()) console.log("Already up to date.");
    });
  registerCommand(program, "format")
    .description("Format Markdown, JSON, or YAML; print a file, or use --write / --check")
    .argument("[path]", "Markdown, JSON, or YAML file path")
    .option("--all", "Format records across all registered project scopes")
    .option("--project <id>", "Limit --all to one registered scope")
    .addOption(new Option("--write", "Update the file in place").conflicts("check"))
    .addOption(new Option("--check", "Fail if formatting would change the file").conflicts("write"))
    .action(
      (path: string | undefined, options: { all?: boolean; project?: string; write?: boolean; check?: boolean }) =>
        formatFiles(root, path, options),
    );
  registerCommand(program, "validate")
    .description("Validate structure and generated files without running project check commands")
    .argument("[root]", "Project tree", undefined)
    .action((requested?: string) => validate(requested ? resolve(requested) : root));
  registerEnvironmentInternals(program, root);
  registerDevelopmentCommands(program, root);
  registerToolCommands(program, root);
  registerToolInternals(program, root);
  registerCheckCommands(program, root);
  registerCommand(program, "setup-project", { hidden: true })
    .argument("<root>")
    .action(async (requested: string) => {
      await setupProject(resolve(requested));
      for (const path of syncRecordSequences(resolve(requested))) console.log(`Updated ${path}.`);
      for (const path of syncMaps(resolve(requested))) console.log(`Updated ${path}.`);
      for (const path of syncReleaseIndexes(resolve(requested))) console.log(`Updated ${path}.`);
    });
  registerCommitCommands(program, root);
  registerCommand(program, "observe", { hidden: true })
    .argument("<warning>")
    .argument("<command...>")
    .action((warning: string, command: string[]) => observeCommand(command, Number(warning)));
  registerCommand(program, "docs")
    .description("Verify executable console examples")
    .argument("<file>")
    .action((file: string) => {
      checkDocExamples(file);
    });
  registerCommand(program, "help")
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
  configureCommandHelp(program, (command, visible) => {
    if (
      showFullHelp ||
      activeCommand === "complete" ||
      (hasCollectionProject(root) && projectRegistration(registrationRoot(root)) === Registration.Registered)
    )
      return visible;
    return visible.filter((child) => !commandAdmission(commandPath(child)).project);
  });
  function printAllHelp(): void {
    showFullHelp = true;
    try {
      program.outputHelp();
      function visit(command: Command, path: string[]): void {
        for (const child of command.createHelp().visibleCommands(command)) {
          const childPath = [...path, child.name()];
          helpOutput.push(`\nCOMMAND: ${childPath.join(" ")}\n\n`);
          child.outputHelp();
          visit(child, childPath);
        }
      }
      visit(program, ["workbench"]);
    } finally {
      showFullHelp = false;
    }
  }
  function sync(): number {
    return synchronize(root);
  }
  // Inspection and reconciliation remain available while compatibility review is stale.
  program.hook("preAction", async (_program, action) => {
    activeCommand = commandPath(action) || program.name();
    const path = commandPath(action);
    const explicitTree = action.name() === "validate" || isGateCommand(action) ? action.args[0] : undefined;
    if (!hasCollectionProject(explicitTree ? resolve(explicitTree) : root) && commandAdmission(path).project)
      throw new Error(
        "this command requires a configured Workbench project; enter a project directory or run workbench init",
      );
    const inspection =
      (isGateCommand(action) && action.getOptionValue("list") === true) ||
      (action.name() === "ci" && (action.getOptionValue("plan") === true || action.getOptionValue("json") === true)) ||
      (action.name() === "compatibility-exec" && action.getOptionValue("plan") === true);
    if (commandAdmission(path).project && !inspection)
      await requireProjectRegistration(explicitTree ? resolve(explicitTree) : root);
    if (!inspection && commandAdmission(path).policy) {
      const requested = isGateCommand(action) || action.name() === "devcontainer-exec" ? action.args[0] : undefined;
      checkPolicyCompatibility(requested ? resolve(requested) : root);
    }
  });
  async function start(argv: string[]): Promise<void> {
    process.env.WORKBENCH_DISTRIBUTION_ROOT ??= resolve(__dirname, "..");
    validateCommandAdmissions(program);
    function presentationOptions(command: Command): void {
      command.exitOverride((error) => {
        failedParseCommand = command;
        throw error;
      });
      for (const specification of diagnosticOptions) {
        const option = new Option(`${specification.flag} <${specification.argument}>`, specification.description);
        option.choices([...specification.choices]);
        command.addOption(option);
      }
      command.option("--plain", "Use stable plain text and line-oriented prompts");
      command.option("--no-plain", "Override a saved or inherited plain presentation preference");
      for (const child of command.commands) presentationOptions(child);
    }
    presentationOptions(program);
    configureDiagnostics(resolveDiagnosticOptions({}, {}));
    let failure: unknown;
    try {
      await withMicrosoftSDKOperation(() => program.parseAsync(argv));
      recordCommand(DiagnosticOutcome.Completed);
    } catch (error) {
      if (error instanceof CommanderError) {
        if (!["commander.helpDisplayed", "commander.help"].includes(error.code)) {
          const command = failedParseCommand ?? program;
          const path = commandPath(command);
          activeCommand = path || program.name();
          // Parsing fails before preAction configures diagnostics. Honor valid parsed flags
          // without allowing broken preferences to replace the original usage error.
          try {
            configureDiagnostics(resolveDiagnosticOptions(command.optsWithGlobals(), process.env, userPreferences()));
          } catch {
            configureDiagnostics(resolveDiagnosticOptions(command.optsWithGlobals(), {}));
          }
          failure = new UserFacingError(
            formatDiagnosticSections({
              summary: error.message.replace(/^error:\s*/, ""),
              next: `Run 'workbench help${path ? ` ${path}` : ""}' for usage.`,
            }),
            { cause: error },
          );
        }
      } else failure = error;
    }
    if (helpOutput.length) {
      let requestedPlain: boolean | undefined;
      const inspectPresentation = (command: Command) => {
        if (command.getOptionValueSource("plain") === "cli")
          requestedPlain = command.getOptionValue("plain") as boolean;
        for (const child of command.commands) inspectPresentation(child);
      };
      inspectPresentation(program);
      configurePresentation(requestedPlain, userPreferences()["terminal.plain"] === true);
      await pageHelp(helpOutput.join(""), program.opts<{ pager?: boolean }>().pager === false);
    }
    if (failure !== undefined && activeCommand === "serve" && diagnosticSession) {
      reportFailure(failure);
      failure = undefined;
    }
    if (failure !== undefined) recordCommand(DiagnosticOutcome.Failed, failure);
    await settleCleanup([() => diagnosticSession?.close()], failure);
  }
  return {
    program,
    run: (argv: string[] = process.argv): Promise<void> => start(argv).catch(reportFailure),
  };
}
export function runCLI(): void {
  void createCLI().run();
}
