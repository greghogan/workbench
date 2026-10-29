import { CheckNetwork } from "../scripts/check-network.mjs";
import { CheckMessage, type CheckWorkerMessage } from "./check-protocol.js";
import { withConfigurationSnapshot } from "./configuration-snapshot.js";
import {
  writeDiagnosticText,
  LogLevel,
  DiagnosticOperation,
  DiagnosticOutcome,
  diagnostic,
  diagnosticError,
  settleCleanup,
} from "./diagnostics.js";
import { startLogRun, finishLogRun, logRetention, requireActiveLogRun } from "./log-storage.js";
import type { CheckRunResult } from "./check-report.js";
import { randomUUID } from "node:crypto";
import { checkOutput, checkOutputPrelude } from "./check-output.js";
import { prepareCheckLogs, checkLogDirectory, buildPaths, withBuildLock, cleanBuilds } from "./builds.js";
import { withCacheLock } from "./cache-lock.js";
import { runCheckGroups } from "./check-runner.js";
import { CheckCancellation } from "./check-cancellation.js";
import { withCheckCoordination } from "./check-coordination.js";
import type { ProcessLock } from "./process-lock.js";
import { withCachedChecks } from "./check-cache.js";
import { selectedToolRequirements, verifyBuildResults } from "./tool-references.js";
import { registrationRoot } from "./project-registration.js";
import { finalizeChecks } from "./check-finalization.js";
import { autoPrune } from "./auto-prune.js";
import { withToolCacheUseAsync } from "./tool-cache-lock.js";
import { required } from "./invariants.js";
import { ownedPath } from "./paths.js";
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
import { distributionRoot } from "./project-context.js";
import { readConfig } from "./project-configuration.js";
import { quote, resolveCheckCommand } from "./toolchains.js";
import { checkExecution } from "./check-resources.js";
import { validateCheckControl } from "./check-control.js";
import {
  checkEnvironment,
  executionPreference,
  inSelectedShell,
  withDevelopmentSelection,
  type CheckEnvironment,
} from "./environments.js";
import { planChecks, type CheckSelection } from "./check-plan.js";
import { terminalTable } from "./terminal-table.js";
import { readChecks, type ConfiguredCheck } from "./check-configuration.js";
import { prepareCheckCommand } from "./check-preparation.js";

export interface CheckInspectionOptions extends CheckSelection {
  json?: boolean;
  all?: boolean;
}

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
  const describe = (check: ConfiguredCheck, environment: string) => ({
    name: check.name,
    role: check.role,
    path: relative(root, check.directory).replaceAll("\\", "/") || ".",
    environment,
    command: check.command,
    source: check.source,
    stages: check.stages,
    online: check.online,
    requiresSetup: check.requiresSetup,
  });
  return {
    stage: plan.stage ?? null,
    structuralValidation: (options.role?.length ?? 0) === 0 && (options.excludeRole?.length ?? 0) === 0,
    allowEmpty: !!readConfig(root).checks?.allow_empty,
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

export function listChecks(root: string, options: CheckInspectionOptions = {}): void {
  const plan = inspectChecks(root, options);
  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`Check plan (${plan.stage ?? "manual selection"})`);
  console.log(
    plan.structuralValidation
      ? "Includes structural validation."
      : "Focused role run; structural validation is skipped.",
  );
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
    for (const [index, source] of sources.entries()) console.log(`${String(index + 1)}: ${source}`);
    console.log(
      `Up to ${String(plan.execution.maxJobs)} groups; ${String(plan.execution.availableCpus)} CPUs available.`,
    );
    for (const session of plan.execution.sessions) {
      const after = session.after.map(
        (dependency) => `${dependency.path} (${dependency.environment}) ${dependency.phase}`,
      );
      console.log(
        `${session.path} (${session.environment}): ${session.cpus === null ? "tool-default parallelism" : `${String(session.cpus)} workers maximum`}${after.length ? `; after ${after.join(", ")}` : ""}.`,
      );
    }
  }
  if (options.all && plan.excluded.length) {
    console.log("Excluded checks:");
    console.log(
      terminalTable(
        ["ROOT", "ROLE", "CHECK", "REASON"],
        plan.excluded.map((check) => [check.path, check.role, check.name, check.reason]),
      ),
    );
  } else if (plan.excluded.length)
    console.log(
      `${String(plan.excluded.length)} checks excluded; use ${options.network === CheckNetwork.Online ? "--json" : "--all or --json"} for details.`,
    );
}

export async function runChecks(
  root: string,
  options: CheckSelection = {},
  validate?: () => Promise<void>,
  recordReport?: (report: CheckRunResult) => void,
): Promise<void> {
  root = realpathSync(root);
  const cancellation = new CheckCancellation();
  let passed = false;
  const execution = { started: false };
  try {
    await withCheckCoordination(root, cancellation, (owner) =>
      withConfigurationSnapshot(async () => {
        await validate?.();
        cancellation.checkpoint();
        await withDevelopmentSelection(
          root,
          options.environment,
          options.profile,
          async () => {
            const plan = configuredCheckPlan(root, options);
            const run = () => {
              execution.started = true;
              return withCachedChecks(
                root,
                options,
                plan,
                (selected) => runCheckGroups(root, options, selected, cancellation, owner, recordReport),
                cancellation.signal,
                recordReport,
              );
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
              await finalizeChecks(original, root, {
                paths: plan.sessions.map((session) => relative(root, session.directory).replaceAll("\\", "/") || "."),
                profile: typeof options.toolchain === "string" ? options.toolchain : "",
                browser: plan.sessions.some((session) => session.checks.some((check) => check.role === "browser")),
              });
            }
          },
          options.workspace,
        );
      }),
    );
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
    await cancellation.waitForStart();
    await withConfigurationSnapshot(() =>
      runConfiguredChecks(
        root,
        options,
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
  const plan = configuredCheckPlan(root, options, directory);
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
  try {
    for (const { directory, environment, checks: group } of plan.sessions) {
      const logID = randomUUID();
      const launcher = resolveCheckCommand(
        directory,
        ["node", "{workbench}/bin/workbench.mjs"],
        distributionRoot(root),
      );
      const script = [
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
        group
          .flatMap((entry) => {
            const command = resolveCheckCommand(directory, entry.command, distributionRoot(root));
            const setup =
              entry.role === "setup" &&
              (existsSync(join(directory, "package.json")) || existsSync(join(directory, "pyproject.toml")))
                ? [...launcher, "dependency-setup", "--", ...command]
                : command;
            const observed =
              entry.warnSeconds === undefined
                ? setup
                : [...launcher, "observe", String(entry.warnSeconds), "--", ...setup];
            const presentCoverage = entry.role === "coverage";
            const collector = resolveCheckCommand(
              directory,
              ["node", "{workbench}/scripts/check-coverage-summary.mjs"],
              distributionRoot(root),
            )
              .map(quote)
              .join(" ");
            const step = ++completed;
            const body = presentCoverage
              ? ["coverage_status=0", `${observed.map(quote).join(" ")} || coverage_status=$?`]
              : [observed.map(quote).join(" ")];
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
          })
          .join("\n"),
      ].join("\n");
      const hasCoverage = group.some((entry) => entry.role === "coverage");
      const summaryPath = hasCoverage
        ? ownedPath(directory, "coverage/coverage-summary.json")
        : join(directory, "coverage/coverage-summary.json");
      const previousSummary = hasCoverage && existsSync(summaryPath) ? readFileSync(summaryPath) : undefined;
      let complete = false;
      let scriptDirectory: string | undefined;
      let sessionFailure: unknown;
      try {
        // MSYS and native Windows processes use different command-line quoting.
        // A script file preserves literal backslashes and quotes in configured commands.
        let invocation = ["sh", "-eu", "-c", script];
        if (process.platform === "win32") {
          scriptDirectory = mkdtempSync(join(tmpdir(), "workbench-check-session-"));
          const path = join(scriptDirectory, "checks.sh");
          writeFileSync(path, script);
          invocation = ["sh", "-eu", path.replaceAll("\\", "/")];
        }
        const execute = async () => {
          cancellation.checkpoint();
          const prepared = prepareCheckCommand({
            directory: directory,
            name: `checks in '${required(group[0], "expected group[0]").location}' (${environment})`,
            command: invocation,
            selected: environment,
            repositoryRoot: root,
            dockerImage: required(group[0], "expected group[0]").dockerImage,
            inspectTools: !plan.cleanup,
            lockBuild: !plan.cleanup,
            compilerSelection: options,
          });
          const run = async (owner?: ProcessLock) => {
            cancellation.checkpoint();
            const use = async () => {
              prepared.prepare();
              await cancellation.execute(prepared.invocation, directory, prepared.env, false, owner);
              if (
                prepared.builds?.external &&
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
            if (prepared.builds && prepared.profile && !inSelectedShell(directory, environment))
              await withCacheLock(prepared.builds.dependencies, use, 0);
            else await use();
          };
          if (prepared.builds && !plan.cleanup) await withBuildLock(prepared.builds, run);
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
              if (scriptDirectory) rmSync(scriptDirectory, { recursive: true, force: true });
            },
            async () => {
              try {
                if (!verbose && !plan.cleanup) {
                  const paths = buildPaths(root, directory, environment, options);
                  const logs = join(paths.directory, "check-logs", logID);
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
  } finally {
    if (process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1") {
      for (const directory of new Set(plan.sessions.map((session) => session.directory)))
        cleanBuilds(buildPaths(root, directory, "native", {}, false), true);
    }
  }
}
