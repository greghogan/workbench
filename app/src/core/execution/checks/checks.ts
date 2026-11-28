import { readBoundedFile } from "../../runtime/file-reads.js";
import { CheckNetwork } from "./check-network.mjs";
import { CheckMessage, CheckWorkerPhase, type CheckWorkerMessage } from "./check-protocol.js";
import { withConfigurationSnapshot } from "../../configuration/configuration-snapshot.js";
import {
  writeDiagnosticText,
  LogLevel,
  DiagnosticOperation,
  DiagnosticOutcome,
  diagnostic,
  diagnosticError,
  settleCleanup,
} from "../../diagnostics/diagnostics.mjs";
import { startLogRun, finishLogRun, logRetention, requireActiveLogRun } from "../../storage/logs/log-storage.js";
import { measureCheckPhase, type CheckPhaseObserver, type CheckRunResult } from "./check-report.js";
import { createHash, randomUUID } from "node:crypto";
import { checkOutput, checkOutputPrelude, parallelCheckOutput } from "./check-output.js";
import { prepareCheckLogs, checkLogDirectory, buildPaths, withBuildLock } from "../../artifacts/builds.js";
import { withCacheLock } from "../../storage/cache-lock.js";
import { runCheckGroups } from "./check-runner.js";
import { CheckCancellation } from "./check-cancellation.js";
import { workerTool, type WorkerTool } from "./native-worker-tools.js";
import { withCheckCoordination } from "./check-coordination.js";
import type { ProcessLock } from "../../storage/process-lock.js";
import { checkStagedSourceUnchanged } from "./check-source-view.js";
import { checkSecrets } from "../../runtime/secrets.js";
import { withCachedChecks } from "./check-cache.js";
import { selectedToolRequirements, verifyBuildResults } from "../../toolchains/tool-references.js";
import { registrationRoot } from "../../projects/project-registration.js";
import { finalizeChecks } from "./check-finalization.js";
import { autoPrune } from "../../storage/auto-prune.js";
import { withToolCacheUseAsync } from "../../toolchains/tool-cache-lock.js";
import { required } from "../../runtime/invariants.js";
import { ownedPath } from "../../runtime/paths.js";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname, basename } from "node:path";
import { distributionRoot } from "../../projects/project-context.js";
import { readConfig } from "../../projects/project-configuration.js";
import { quote, resolveCheckCommand } from "../../toolchains/toolchains.js";
import { checkExecution } from "./check-resources.js";
import { currentExecutionEnvironment } from "../environments/execution-context.js";
import { checkBatches, validateCheckControl } from "./check-control.js";
import {
  checkEnvironment,
  executionPreference,
  inSelectedShell,
  withDevelopmentSelection,
  type CheckEnvironment,
} from "../environments/environments.js";
import { planChecks, type CheckPlan, type CheckSelection } from "./check-plan.js";
import { terminalTable } from "../../diagnostics/terminal-table.js";
import { readChecks, type ConfiguredCheck } from "./check-configuration.js";
import { prepareCheckCommand } from "./check-preparation.js";
import { checkGateInputScope } from "./check-input-scope.js";
import { checkGroupExecution, scopedCheckGroups } from "./check-cache-plan.js";
import {
  checkBackendName,
  linuxOfflineCommand,
  nativeCheckBackend,
  prepareIsolatedChecks,
  usesPreparedCheckModules,
} from "./check-isolation.js";
import { safeOutput } from "../../diagnostics/terminal-output.js";
import { checkBaseEnvironment } from "./check-environment.js";

export interface CheckInspectionOptions extends CheckSelection {
  json?: boolean;
  all?: boolean;
}

function shouldPrepareSource(options: CheckSelection): boolean {
  return (
    options.network !== CheckNetwork.Online && !options.role?.some((role) => role === "setup" || role === "acquire")
  );
}

function isBuiltinCredentialCheck({ role, command }: ConfiguredCheck): boolean {
  return (
    role === "secret" &&
    command.length === 4 &&
    command[0] === "node" &&
    command[1] === "bin/workbench.mjs" &&
    command[2] === "secrets" &&
    command[3] === "."
  );
}

class PrepareSourceForChecks extends Error {}

/** Inspection and execution resolve the same stage, setup, environment, and coverage choices. */
export function inspectChecks(root: string, options: CheckSelection = {}) {
  return withDevelopmentSelection(
    root,
    options.environment,
    options.profile,
    () => inspectConfiguredChecks(root, options),
    options.workspace,
  );
}

function inspectConfiguredChecks(root: string, options: CheckSelection) {
  const configured = readChecks(root);
  const environment = executionPreference(root, options.environment, options.profile);
  const plan = planChecks(root, configured, { ...options, ...(environment ? { environment } : {}) });
  const execution = checkExecution(root, plan);
  const groups = scopedCheckGroups(root, plan, true);
  const isolation = {
    backend: groups?.some(({ scope }) => scope.mode === "scoped") ? nativeCheckBackend(root) : undefined,
  };
  const scopes = groups?.map((group) => {
    const { scope, backend } = checkGroupExecution(root, group, isolation);
    return {
      path: group.path,
      environment: group.session.environment,
      checks: group.session.checks.map((check) => check.name),
      inputScope: scope,
      ...(backend ? { backend: checkBackendName(backend) } : {}),
    };
  });
  const describe = (check: ConfiguredCheck, environment: string) => ({
    name: check.name,
    role: check.role,
    path: relative(root, check.directory).replaceAll("\\", "/") || ".",
    environment,
    command: check.command,
    source: check.source,
    stages: check.stages,
    ...(check.extended ? { extended: true } : {}),
    online: check.online,
    requiresSetup: check.requiresSetup,
    ...(check.requiresBuild ? { requiresBuild: check.requiresBuild } : {}),
    ...(check.inputs ? { inputs: check.inputs } : {}),
  });
  return {
    stage: plan.stage ?? null,
    structuralValidation: (options.role?.length ?? 0) === 0 && (options.excludeRole?.length ?? 0) === 0,
    allowEmpty: !!readConfig(root).checks?.allow_empty,
    inputScope: checkGateInputScope(plan.sessions, readConfig(root).checks?.inputs),
    ...(scopes ? { cacheGroups: scopes } : {}),
    execution: {
      availableCpus: execution.availableCpus,
      maxJobs: execution.maxJobs,
      sessions: plan.sessions.map((session, index) => ({
        path: relative(root, session.directory).replaceAll("\\", "/") || ".",
        environment: session.environment,
        cpus: execution.cpuLimit,
        after: (execution.dependencies[index] ?? []).map((dependency) => {
          const predecessor = required(plan.sessions[dependency.session], "missing check dependency");
          return {
            path: relative(root, predecessor.directory).replaceAll("\\", "/") || ".",
            environment: predecessor.environment,
            phase: dependency.phase,
          };
        }),
      })),
    },
    selected: plan.sessions.flatMap((session) => session.checks.map((check) => describe(check, session.environment))),
    excluded: plan.excluded.map(({ check, reason }) => ({
      ...describe(check, environment ?? check.environment),
      reason,
    })),
  };
}

function checkPlanSubheading(label: string): string {
  return `\n${label}\n${"-".repeat(label.length)}`;
}

export function listChecks(root: string, options: CheckInspectionOptions = {}, heading?: string): void {
  const plan = inspectChecks(root, options);
  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const title = heading ?? `Check plan (${plan.stage ?? "manual selection"})`;
  const rule = "=".repeat(Math.min(process.stdout.columns || 72, 72));
  console.log(`${rule}\n${title}\n${rule}\n`);
  if (!plan.structuralValidation) console.log("Focused role run skips structural validation.\n");
  if (!plan.selected.length) {
    console.log(
      plan.allowEmpty ? "configured: structural checks only (checks.allow_empty = true)" : "configured: none selected",
    );
  } else {
    const sources = [...new Set(plan.selected.map((check) => check.source ?? "unknown"))];
    console.log(
      terminalTable(
        ["ROOT", "ROLE", "ENVIRONMENT", "CHECK", "SOURCE"],
        plan.selected.map((check) => [
          check.path,
          check.role,
          check.environment,
          check.name,
          String(sources.indexOf(check.source ?? "unknown") + 1),
        ]),
      ),
    );
    console.log(checkPlanSubheading("Sources"));
    for (const [index, source] of sources.entries()) console.log(`  ${String(index + 1)}: ${source}`);
    console.log(checkPlanSubheading("Execution"));
    console.log(
      `  Up to ${String(plan.execution.maxJobs)} groups; ${String(plan.execution.availableCpus)} CPUs available.`,
    );
    for (const session of plan.execution.sessions) {
      const after = session.after.map(
        (dependency) => `${dependency.path} (${dependency.environment}) ${dependency.phase}`,
      );
      console.log(
        `  ${session.path} (${session.environment}): ${session.cpus === null ? "tool-default parallelism" : `${String(session.cpus)} workers maximum`}${after.length ? `; after ${after.join(", ")}` : ""}.`,
      );
    }
    const scope = plan.inputScope;
    console.log(checkPlanSubheading("Cache inputs"));
    const showScope = (inputScope: typeof scope, indent: string) => {
      if (inputScope.mode === "scoped") {
        console.log(`${indent}Groups: ${inputScope.groups.join(", ")}`);
        for (const path of inputScope.paths) console.log(`${indent}${safeOutput(path)}`);
      } else console.log(`${indent}Whole project · ${safeOutput(inputScope.reason)}`);
    };
    if (plan.cacheGroups) {
      for (const group of plan.cacheGroups) {
        console.log(`  ${group.path} (${group.environment})`);
        for (const check of group.checks) console.log(`    ${safeOutput(check)}`);
        if (group.backend) console.log(`    ${group.backend}`);
        showScope(group.inputScope, "    ");
      }
    } else showScope(scope, "  ");
  }
  if (options.all && plan.excluded.length) {
    console.log(checkPlanSubheading("Excluded checks"));
    console.log(
      terminalTable(
        ["ROOT", "ROLE", "CHECK", "REASON"],
        plan.excluded.map((check) => [check.path, check.role, check.name, check.reason]),
      ),
    );
  } else if (plan.excluded.length)
    console.log(
      `\n${String(plan.excluded.length)} checks excluded; use ${options.network === CheckNetwork.Online ? "--json" : "--all or --json"} for details.`,
    );
}

export async function runChecks(
  root: string,
  options: CheckSelection = {},
  validate?: () => Promise<void>,
  recordReport?: (report: CheckRunResult) => void,
  observe?: CheckPhaseObserver,
  stagedCommit = false,
): Promise<void> {
  root = realpathSync(root);
  const cancellation = new CheckCancellation();
  let passed = false;
  const execution = { started: false };
  try {
    await withCheckCoordination(root, cancellation, (owner) =>
      withConfigurationSnapshot(async () => {
        if (validate) await measureCheckPhase("Structural validation", validate, observe);
        cancellation.checkpoint();
        await withDevelopmentSelection(
          root,
          options.environment,
          options.profile,
          async () => {
            const plan = configuredCheckPlan(root, options);
            const plannedCredentialScan =
              distributionRoot(root) === root &&
              plan.sessions.some(
                ({ directory, checks }) => directory === root && checks.some(isBuiltinCredentialCheck),
              );
            if (stagedCommit && !plannedCredentialScan) await checkSecrets(root);
            let ranDevelopmentChecks = false;
            const run = async () => {
              const needsPreparation = (selected: CheckPlan) =>
                selected.sessions.some(
                  ({ directory, environment, checks }) =>
                    directory === root &&
                    environment === "native" &&
                    usesPreparedCheckModules(
                      root,
                      checks.filter(({ role }) => role === "setup"),
                    ),
                );
              let workerOptions = options;
              const prepare = async () => {
                const env = {
                  ...checkBaseEnvironment(root, root),
                  WORKBENCH_DISTRIBUTION_ROOT: distributionRoot(root),
                  WORKBENCH_OFFLINE: "1",
                };
                const scratch = mkdtempSync(join(tmpdir(), "workbench-check-preparation-"));
                const proof = join(scratch, "dependencies");
                try {
                  const command = [
                    process.execPath,
                    join(root, "scripts/setup-development.mjs"),
                    "--reuse-prepared",
                    "--prepared-proof-output",
                    proof,
                  ];
                  // Publish generated helpers before admitting any worker that reads them.
                  await measureCheckPhase(
                    "Prepared dependencies and tooling",
                    () =>
                      cancellation.execute(
                        options.offline ? linuxOfflineCommand(command, env) : command,
                        root,
                        env,
                        false,
                        owner,
                      ),
                    observe,
                  );
                  const prepared = readBoundedFile(proof, 64, "prepared dependency proof").toString("utf8");
                  if (!/^[a-f0-9]{64}$/.test(prepared)) throw new Error("Invalid prepared dependency proof");
                  workerOptions = { ...options, preparedSource: prepared };
                } finally {
                  rmSync(scratch, { recursive: true, force: true });
                }
                checkStagedSourceUnchanged(root);
              };
              checkStagedSourceUnchanged(root);
              execution.started = true;
              const canPrepare = needsPreparation(plan) && shouldPrepareSource(options);
              const runSelected = (admit?: (selected: CheckPlan) => void) =>
                withCachedChecks(
                  root,
                  options,
                  plan,
                  (selected, cache, products) => {
                    ranDevelopmentChecks ||= selected.sessions.some(({ checks }) =>
                      checks.some(({ role }) => role !== "secret" && role !== "setup"),
                    );
                    return runCheckGroups(
                      root,
                      workerOptions,
                      selected,
                      cancellation,
                      owner,
                      recordReport,
                      cache,
                      products,
                      observe,
                    );
                  },
                  cancellation.signal,
                  recordReport,
                  {
                    backend: plan.sessions.some((session) => session.checks.some((check) => check.inputs))
                      ? nativeCheckBackend(root)
                      : undefined,
                  },
                  observe,
                  admit,
                );
              if (!canPrepare) return runSelected();
              if (
                options.cache === false ||
                options.stage === "ci" ||
                options.role?.length ||
                options.excludeRole?.length
              ) {
                await prepare();
                return runSelected();
              }
              try {
                await runSelected((selected) => {
                  if (needsPreparation(selected)) throw new PrepareSourceForChecks();
                });
              } catch (error) {
                if (!(error instanceof PrepareSourceForChecks)) throw error;
                await prepare();
                // Preparation can replace generated helpers; bindings are acquired from the prepared tree.
                return runSelected();
              }
            };
            if (!plan.cleanup && plan.sessions.some((session) => session.environment === "native"))
              await withToolCacheUseAsync(
                run,
                selectedToolRequirements(
                  root,
                  plan.sessions
                    .filter((session) => session.environment === "native")
                    .map((session) => relative(root, session.directory).replaceAll("\\", "/") || "."),
                  options,
                ),
              );
            else await run();
            if (
              plan.stage &&
              (plan.stage === "commit" || plan.stage === "ci") &&
              !options.role?.length &&
              !options.excludeRole?.length &&
              !options.checkNames?.length &&
              options.network !== CheckNetwork.Online &&
              !options.compiler &&
              !options.compilerVersion &&
              plan.sessions.every((session) => session.environment === "native")
            ) {
              const original = registrationRoot(root);
              await measureCheckPhase(
                "Cache maintenance",
                () =>
                  finalizeChecks(
                    original,
                    root,
                    {
                      paths: plan.sessions.map(
                        (session) => relative(root, session.directory).replaceAll("\\", "/") || ".",
                      ),
                      profile: typeof options.toolchain === "string" ? options.toolchain : "",
                      browser: plan.sessions.some((session) =>
                        session.checks.some((check) => check.role === "browser"),
                      ),
                      refreshArtifacts: ranDevelopmentChecks,
                    },
                    cancellation.signal,
                  ),
                observe,
              );
            }
          },
          options.workspace,
        );
      }),
    );
    cancellation.checkpoint();
    passed = true;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") cancellation.checkpoint();
    throw error;
  } finally {
    try {
      if (execution.started && !passed && !cancellation.cancelled) await autoPrune(registrationRoot(root));
    } finally {
      cancellation.close();
    }
  }
}

/** Internal worker entry point: a single ordered root/environment session owns its shell and cleanup. */
export async function runCheckSession(
  root: string,
  options: CheckSelection,
  directory: string,
  environment: string,
  control: string,
  retainedDirectory?: string,
): Promise<void> {
  validateCheckControl(control);
  const cancellation = new CheckCancellation();
  try {
    const isolationGroups = await cancellation.waitForStart(options.isolationDigest);
    await withConfigurationSnapshot(() =>
      runConfiguredChecks(
        root,
        { ...options, isolationGroups },
        realpathSync(resolve(root, directory)),
        checkEnvironment(environment, "worker environment"),
        cancellation,
        control,
        retainedDirectory,
      ),
    );
    cancellation.checkpoint();
  } catch (error) {
    if (process.send && process.connected)
      await new Promise<void>((resolve) => {
        process.send?.({ type: CheckMessage.Failure, error: diagnosticError(error) }, () => {
          resolve();
        });
      });
    throw error;
  } finally {
    cancellation.close();
  }
}

function configuredCheckPlan(root: string, options: CheckSelection, directory?: string) {
  return withConfigurationSnapshot(() => configurationPlan(root, options, directory));
}

function configurationPlan(root: string, options: CheckSelection, directory?: string) {
  root = realpathSync(root);
  if (
    (options.compiler !== undefined || options.compilerVersion !== undefined) &&
    options.path === undefined &&
    !directory
  )
    throw new Error("compiler overrides require --path");
  const selectedEnvironment = executionPreference(root, options.environment, options.profile);
  const checks = readChecks(root);
  const plan = planChecks(
    root,
    checks,
    { ...options, ...(selectedEnvironment ? { environment: selectedEnvironment } : {}) },
    directory,
  );
  if (!plan.sessions.length) {
    if (options.role?.length || options.excludeRole?.length || options.path !== undefined || options.project)
      throw new Error(
        `no configured checks ${options.role?.length ? `have roles '${options.role.join(", ")}'` : "selected"} in the selected stage and scope`,
      );
    if (!readConfig(root).checks?.allow_empty)
      throw new Error(
        "no configured check commands for this stage; configure checks or explicitly set checks.allow_empty = true",
      );
    console.log("No configured commands: structural checks only (checks.allow_empty = true).");
  }
  if (!plan.cleanup) for (const session of plan.sessions) inSelectedShell(session.directory, session.environment);
  return plan;
}

async function runConfiguredChecks(
  root: string,
  options: CheckSelection,
  directory: string,
  environment: CheckEnvironment,
  cancellation: CheckCancellation,
  control: string,
  retainedDirectory?: string,
): Promise<void> {
  root = realpathSync(root);
  const observe: CheckPhaseObserver = (phase) => {
    if (process.send && process.connected)
      process.send({ type: CheckMessage.Phase, phase } satisfies CheckWorkerMessage, () => {
        // A cancelled parent can close IPC before the advisory timing is delivered.
      });
  };
  const plan = await measureCheckPhase(
    CheckWorkerPhase.Plan,
    () => configuredCheckPlan(root, options, directory),
    observe,
  );
  plan.sessions = plan.sessions.filter((session) => session.environment === environment);
  if (plan.sessions.length !== 1) throw new Error("check workers require exactly one root/environment group");
  const completeSelection = !options.checkNames || options.checkNames.length === plan.sessions[0]?.checks.length;
  if (options.checkNames) {
    const names = new Set(options.checkNames);
    for (const session of plan.sessions) {
      session.checks = session.checks.filter((check) => names.has(check.name));
      if (session.checks.length !== names.size)
        throw new Error("check worker selection differs from configured checks");
    }
  }
  const total = plan.sessions.reduce((sum, session) => sum + session.checks.length, 0);
  let completed = 0;
  const verbose = options.verbose ?? process.env.WORKBENCH_VERBOSE === "1";
  // Setup and all dependent commands share one session, including disposable environments.
  for (const { directory, environment, checks: group } of plan.sessions) {
    const logID = randomUUID();
    const reusePreparedModules =
      environment === "native" &&
      usesPreparedCheckModules(
        root,
        group.filter(({ role }) => role === "setup").map(({ command }) => ({ directory, command })),
      );
    const distribution = distributionRoot(root);
    const credentialOnly =
      environment === "native" &&
      directory === root &&
      distribution === root &&
      group.length === 1 &&
      group.every(isBuiltinCredentialCheck);
    const node = environment === "native" ? process.execPath.replaceAll("\\", "/") : "node";
    const scopedChecks = new Map(
      options.isolationGroups?.flatMap(({ backend, checks }) => checks.map((name) => [name, backend.kind] as const)),
    );
    const resolveCommand = (command: string[], name?: string) =>
      resolveCheckCommand(directory, command, distribution, name !== undefined && scopedChecks.get(name) === "macos");
    const launcher = resolveCommand([node, "{workbench}/bin/workbench.mjs"]);
    const projectKey = options.machineJobserver
      ? createHash("sha256").update(registrationRoot(root)).digest("hex")
      : undefined;
    const jobserverRuntime = process.platform === "linux" ? process.env.WORKBENCH_SYSTEM_RUNTIME_DIRECTORY : undefined;
    const offline = options.offline ? linuxOfflineCommand([], currentExecutionEnvironment()) : [];
    const admitted = (launcher: string[], command: string[], workers?: WorkerTool) =>
      options.machineJobserver && projectKey
        ? [
            ...(jobserverRuntime ? ["env", `WORKBENCH_SYSTEM_RUNTIME_DIRECTORY=${jobserverRuntime}`] : []),
            ...launcher,
            "admitted-check",
            options.machineJobserver,
            projectKey,
            ...(workers ? ["--workers", workers] : []),
            "--",
            ...command,
          ]
        : command;
    // Authenticate on the host, then run each admitted command with its requested network isolation.
    const checkCommand = (command: string[], workers?: WorkerTool) =>
      environment === "native" && projectKey ? admitted(launcher, [...offline, ...command], workers) : command;
    const script = (
      wrap: (name: string, command: string[], workerPipe?: boolean) => string[] = (_name, command) => command,
    ) =>
      [
        ...checkOutputPrelude(total, verbose, logID, control),
        ...(plan.cleanup
          ? [
              [
                ...launcher,
                "build-clean",
                root,
                ...(group.some((entry) => entry.role === "distclean") ? ["--dependencies"] : []),
              ]
                .map(quote)
                .join(" "),
            ]
          : []),
        checkBatches(
          group,
          options.parallelJobs,
          new Set(options.isolationGroups?.flatMap(({ checks }) => (checks.length === 1 ? checks : []))),
        )
          .flatMap((batch) => {
            const width = Math.min(batch.length, options.parallelJobs ?? 1);
            const steps = batch.map((entry) => {
              const command = resolveCommand(entry.command, entry.name);
              const sourceSetup = entry.role === "setup" && usesPreparedCheckModules(root, [entry]);
              const setup =
                sourceSetup && directory === root && environment === "native" && shouldPrepareSource(options)
                  ? [
                      ...command,
                      "--verify-prepared",
                      ...(options.preparedSource ? ["--prepared-proof", options.preparedSource] : []),
                    ]
                  : entry.role === "setup" &&
                      !sourceSetup &&
                      (existsSync(join(directory, "package.json")) || existsSync(join(directory, "pyproject.toml")))
                    ? [...launcher, "dependency-setup", "--", ...command]
                    : command;
              const scope = scopedChecks.get(entry.name);
              const workers =
                projectKey && environment === "native" && scope !== "macos" ? workerTool(entry) : undefined;
              const invocation = wrap(entry.name, setup, workers !== undefined);
              const observed =
                entry.warnSeconds === undefined
                  ? invocation
                  : [...launcher, "observe", String(entry.warnSeconds), "--", ...invocation];
              const execution = checkCommand(observed, workers).map(quote).join(" ");
              const presentCoverage = entry.role === "coverage";
              const collector = presentCoverage
                ? checkCommand(
                    wrap(
                      entry.name,
                      resolveCommand([node, "{workbench}/scripts/check-coverage-summary.mjs"], entry.name),
                    ),
                  )
                    .map(quote)
                    .join(" ")
                : "";
              const step = ++completed;
              const releaseInput =
                environment === "native" && entry.role === "release-verify"
                  ? 'WORKBENCH_DIST_DIR="${WORKBENCH_RELEASE_ARTIFACT:-$WORKBENCH_DIST_DIR}" '
                  : "";
              const body = presentCoverage
                ? ["coverage_status=0", `${execution} || coverage_status=$?`]
                : [releaseInput + execution];
              const after = presentCoverage
                ? [
                    "workbench_check_replay=$coverage_status",
                    "presentation_status=0",
                    `${collector} "$coverage_status" ${String(Date.now())}${directory === distributionRoot(root) ? " --no-job-summary" : ""} || presentation_status=$?`,
                    '[ "$coverage_status" -eq 0 ] || exit "$coverage_status"',
                    '[ "$presentation_status" -eq 0 ] || exit "$presentation_status"',
                  ]
                : [];
              return checkOutput(body, `${entry.name} (${entry.role})`, step, verbose, after);
            });
            return steps.length > 1 ? parallelCheckOutput(steps, width) : required(steps[0], "Empty check batch");
          })
          .join("\n"),
      ].join("\n");
    const privateChecks = new Set(options.isolationGroups?.flatMap(({ checks }) => checks));
    const hasCoverage = group.some((entry) => entry.role === "coverage" && !privateChecks.has(entry.name));
    const summaryPath = hasCoverage
      ? ownedPath(directory, "coverage/coverage-summary.json")
      : join(directory, "coverage/coverage-summary.json");
    const previousSummary = hasCoverage && existsSync(summaryPath) ? readFileSync(summaryPath) : undefined;
    let complete = false;
    let scriptDirectory: string | undefined;
    let credentialLogs: string | undefined;
    let isolated: Awaited<ReturnType<typeof prepareIsolatedChecks>> | undefined;
    let sessionFailure: unknown;
    try {
      // MSYS and native Windows processes use different command-line quoting.
      // A script file preserves literal backslashes and quotes in configured commands.
      const scoped = options.isolationGroups;
      let scriptPath: string | undefined;
      let invocation: string[];
      if (process.platform === "win32" || scoped?.length) {
        scriptDirectory = mkdtempSync(join(tmpdir(), "workbench-check-session-"));
        scriptPath = join(scriptDirectory, "checks.sh");
        invocation = ["sh", "-eu", scriptPath.replaceAll("\\", "/")];
      } else invocation = ["sh", "-eu", "-c", script()];
      const execute = async () => {
        cancellation.checkpoint();
        const prepared = await measureCheckPhase(
          CheckWorkerPhase.Tools,
          () =>
            prepareCheckCommand({
              directory: directory,
              name: `checks in '${required(group[0], "expected group[0]").location}' (${environment})`,
              command: invocation,
              selected: environment,
              repositoryRoot: root,
              dockerImage: required(group[0], "expected group[0]").dockerImage,
              inspectTools: !plan.cleanup,
              lockBuild: !plan.cleanup && !credentialOnly,
              compilerSelection: options,
            }),
          observe,
        );
        // An implicit pnpm install would invalidate the dependency paths captured for scoped checks.
        if (reusePreparedModules) prepared.env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = "false";
        const run = async (owner?: ProcessLock) => {
          cancellation.checkpoint();
          const use = async () => {
            if (credentialOnly) {
              // A read-only scan keeps its logs without touching a verified build's retention state.
              if (!verbose) {
                credentialLogs = mkdtempSync(join(tmpdir(), "workbench-credential-logs-"));
                prepared.env.WORKBENCH_BUILD_DIR = credentialLogs;
              }
            } else await measureCheckPhase(CheckWorkerPhase.Prepare, prepared.prepare, observe);
            if (scriptPath) {
              if (scoped?.length)
                isolated = await measureCheckPhase(
                  CheckWorkerPhase.Isolate,
                  () => prepareIsolatedChecks(root, directory, scoped, prepared.env, prepared.builds?.directory),
                  observe,
                );
              writeFileSync(scriptPath, script(isolated?.wrap));
            }
            const execution =
              environment === "native"
                ? projectKey
                  ? prepared.invocation
                  : [...offline, ...prepared.invocation]
                : admitted(
                    [process.execPath, join(distributionRoot(root), "bin/workbench.mjs")],
                    [...offline, ...prepared.invocation],
                  );
            await cancellation.execute(execution, directory, prepared.env, false, owner);
            cancellation.checkpoint();
            for (const retain of isolated?.retainBuildOutputs ?? [])
              try {
                retain();
              } catch (error) {
                diagnostic(
                  LogLevel.Warn,
                  DiagnosticOperation.CheckCache,
                  DiagnosticOutcome.Unavailable,
                  {},
                  error,
                  "checks passed; declared build output could not be retained",
                );
              }
            const products = isolated?.productIdentities;
            if (products?.size && process.send && process.connected)
              await new Promise<void>((resolve) => {
                process.send?.({ type: CheckMessage.BuildProducts, products: [...products] }, () => {
                  resolve();
                });
              });
            if (
              prepared.builds?.external &&
              !credentialOnly &&
              environment === "native" &&
              completeSelection &&
              (plan.stage === "commit" || plan.stage === "ci") &&
              !options.role?.length &&
              !options.excludeRole?.length
            )
              try {
                verifyBuildResults([prepared.builds.directory, prepared.builds.dependencies]);
              } catch (error) {
                diagnostic(
                  LogLevel.Warn,
                  DiagnosticOperation.CheckCache,
                  DiagnosticOutcome.Unavailable,
                  {},
                  error,
                  "checks passed; build retention evidence could not be saved",
                );
              }
          };
          if (prepared.profileDependencies && !inSelectedShell(directory, environment))
            await withCacheLock(prepared.profileDependencies, use, 0);
          else await use();
        };
        if (prepared.builds && !plan.cleanup && !credentialOnly) await withBuildLock(prepared.builds, run);
        else await run();
      };
      if (environment === "native" && !plan.cleanup)
        await withToolCacheUseAsync(
          execute,
          selectedToolRequirements(root, relative(root, directory).replaceAll("\\", "/") || ".", options),
        );
      else await execute();
      complete = true;
    } catch (error) {
      sessionFailure = error;
      throw error;
    } finally {
      await settleCleanup(
        [
          () => {
            try {
              isolated?.release();
            } finally {
              if (scriptDirectory) rmSync(scriptDirectory, { recursive: true, force: true });
            }
          },
          async () => {
            try {
              if (!verbose && !plan.cleanup) {
                const paths = buildPaths(root, directory, environment, options);
                const logs = join(credentialLogs ?? paths.directory, "check-logs", logID);
                if (existsSync(logs)) {
                  const owner = process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? paths.identity.checkout;
                  const archive =
                    retainedDirectory ?? checkLogDirectory(paths.storageRoot, owner, paths.identity.root, logID);
                  if (retainedDirectory) {
                    const parent = dirname(retainedDirectory);
                    if (
                      !/^session-\d+$/.test(basename(retainedDirectory)) ||
                      resolve(parent) !== resolve(checkLogDirectory(paths.storageRoot, owner, ".", basename(parent)))
                    )
                      throw new Error("invalid parent log directory");
                    requireActiveLogRun(parent);
                  }
                  await withCacheLock(archive, async () => {
                    if (retainedDirectory) mkdirSync(archive, { recursive: true, mode: 0o700 });
                    else {
                      prepareCheckLogs(paths.storageRoot, owner, paths.identity.root, logID);
                      startLogRun(archive);
                    }
                    cpSync(logs, archive, { recursive: true });
                    rmSync(logs, { recursive: true, force: true });
                    const retained = retainedDirectory
                      ? { files: readdirSync(archive).map((name) => ({ name })), errors: [] }
                      : await finishLogRun(archive, logRetention(root));
                    const message: CheckWorkerMessage = {
                      type: CheckMessage.Logs,
                      directory: archive,
                      files: retained.files.map((file) => file.name),
                      errors: retained.errors,
                    };
                    if (process.send && process.connected)
                      process.send(message, (error) => {
                        if (error)
                          diagnostic(
                            LogLevel.Warn,
                            DiagnosticOperation.CheckLogs,
                            DiagnosticOutcome.Unavailable,
                            {},
                            error,
                            "coordinator evidence channel unavailable",
                          );
                      });
                  });
                  writeDiagnosticText(`Full check logs: ${archive}`);
                }
              }
            } catch (error) {
              diagnostic(
                LogLevel.Warn,
                DiagnosticOperation.CheckLogRetention,
                DiagnosticOutcome.Unavailable,
                {},
                error,
                "evidence may be unavailable",
              );
              if (process.send && process.connected)
                process.send({ type: CheckMessage.LogError, error: diagnosticError(error) }, () => {
                  /* The coordinator may already be gone. */
                });
            }
          },
          () => {
            if (credentialLogs) rmSync(credentialLogs, { recursive: true, force: true });
          },
          () => {
            if (hasCoverage && !complete) {
              ownedPath(directory, "coverage/coverage-summary.json");
              if (previousSummary) {
                mkdirSync(join(directory, "coverage"), { recursive: true });
                writeFileSync(summaryPath, previousSummary);
              } else rmSync(summaryPath, { force: true });
            }
          },
        ],
        sessionFailure,
      );
    }
  }
  console.log(`Passed ${String(total)}/${String(total)} checks.`);
}
