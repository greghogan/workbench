import { RetainedProcessLogs } from "./retained-process-logs.js";
import type { ProcessTermination } from "../scripts/diagnostic-contract.mjs";
import { CheckMessage, readCheckMessage } from "./check-protocol.js";
import { performance } from "node:perf_hooks";
import {
  writeDiagnosticText,
  LogLevel,
  DiagnosticOperation,
  DiagnosticOutcome,
  diagnostic,
  describeError,
  CheckState,
  restoreDiagnosticError,
  settleCleanup,
  secretValues,
  routeDiagnostics,
} from "./diagnostics.js";
import { startLogRun, finishLogRun, logRetention } from "./log-storage.js";
import { processFailure } from "../scripts/process-outcome.mjs";
import { CheckReport, writeCheckReport, type CheckRunResult } from "./check-report.js";
import { checkDetailPrefix } from "../scripts/check-detail-data.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { relative, join } from "node:path";
import { checkFailureExcerpt, checkDetailLines } from "./check-output.js";
import { distributionRoot } from "./project-context.js";
import { buildCheckout, buildStorageSettings, prepareCheckLogs, checkLogDirectory } from "./builds.js";
import { withCacheLock } from "./cache-lock.js";
import { checkExecution } from "./check-resources.js";
import { CheckControl, checkControlPrefix } from "./check-control.js";
import { required } from "./invariants.js";
import { cpuEnvironment } from "../scripts/cpu-budget.mjs";
import type { CheckCancellation } from "./check-cancellation.js";
import type { ProcessLock } from "./process-lock.js";
import { CheckLines, CheckProgress, checkEventPrefix } from "./check-progress.js";
import { safeOutput } from "./terminal-output.js";
import type { CheckSelection, planChecks } from "./check-plan.js";

type Plan = ReturnType<typeof planChecks>;

/** Drain every admitted group before returning, so staged checkouts and shared outputs outlive active work. */
export async function runCheckGroups(
  root: string,
  options: CheckSelection,
  plan: Plan,
  cancellation: CheckCancellation,
  owner: ProcessLock,
  recordReport?: (report: CheckRunResult) => void,
): Promise<void> {
  const total = plan.sessions.reduce((sum, session) => sum + session.checks.length, 0);
  const progress = new CheckProgress(total);
  const allocation = checkExecution(root, plan);
  const { dependencies, maxJobs: concurrency } = allocation;
  const pending = new Set(plan.sessions.map((_, index) => index));
  const complete = new Set<number>();
  const setupComplete = new Set<number>();
  const active = new Map<number, Promise<void>>();
  const workers = new Set<ReturnType<typeof spawn>>();
  const failures: Error[] = [];
  let admissionFailed = false;
  let notifyChange: (() => void) | undefined;
  let diagnostics = Promise.resolve();
  const verbose = options.verbose ?? process.env.WORKBENCH_VERBOSE === "1";
  const storageRoot = buildStorageSettings(root).root;
  const checkout = process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? buildCheckout(root);
  const run = randomUUID();
  const report = new CheckReport(run, plan);
  const reportState = { finished: false };
  const logs = checkLogDirectory(storageRoot, checkout, ".", run);
  const finishReport = async (owned: boolean, failure?: unknown) => {
    reportState.finished = true;
    report.finish(
      failure === undefined && !failures.length && !cancellation.cancelled && !pending.size,
      cancellation.cancelled,
    );
    if (failure !== undefined) report.result.error = describeError(failure);
    for (const check of report.result.checks)
      if (check.omittedDetails)
        writeDiagnosticText(
          `${safeOutput(check.name)}: ${String(check.omittedDetails)} check details omitted from the report (size limit).`,
        );
    const finalizationStarted = performance.now();
    if (owned) {
      writeDiagnosticText("Finalizing check logs…");
      try {
        const retained = await finishLogRun(logs, logRetention(root));
        for (const error of retained.errors) report.logIssue(restoreDiagnosticError(error));
        const retainedPaths = new Set(retained.files.map((file) => join(logs, file.name)));
        for (const check of report.result.checks) {
          const path = check.log;
          if (path && retainedPaths.has(path + ".zst")) check.log = path + ".zst";
        }
        for (const group of report.result.groups) {
          const stdout = group.stdout,
            stderr = group.stderr;
          if (stdout && retainedPaths.has(stdout + ".zst")) group.stdout = stdout + ".zst";
          if (stderr && retainedPaths.has(stderr + ".zst")) group.stderr = stderr + ".zst";
        }
      } catch (error) {
        report.logIssue(error);
        diagnostic(
          LogLevel.Warn,
          DiagnosticOperation.CheckLogs,
          DiagnosticOutcome.Unavailable,
          {},
          error,
          "finalization incomplete; source logs preserved",
        );
      }
    }
    report.result.logFinalizationDurationMs = performance.now() - finalizationStarted;
    if (owned)
      writeDiagnosticText(
        `Finalizing check logs: ${report.result.logIssues.length ? "issues reported" : "finished"} (${(report.result.logFinalizationDurationMs / 1000).toFixed(1)}s).`,
      );
    report.result.finished = new Date().toISOString();
    try {
      if (owned) writeCheckReport(join(logs, "results.json"), report.result);
    } finally {
      recordReport?.(report.result);
      if (owned)
        writeDiagnosticText(
          `${report.result.logIssues.length ? "Check logs (retention issues reported)" : "Full check logs"}: ${logs}`,
        );
    }
  };
  const interrupt = () => {
    progress.stop();
    for (const child of workers)
      if (child.connected)
        child.send({ type: CheckMessage.Cancel }, () => {
          /* Close still drains an exiting worker. */
        });
  };
  cancellation.signal.addEventListener("abort", interrupt, { once: true });

  async function execute(index: number): Promise<void> {
    const session = plan.sessions[index];
    if (!session) throw new Error("missing check session");
    const id = String(index);
    const path = relative(root, session.directory).replaceAll("\\", "/") || ".";
    const label = `${path} (${session.environment})`;
    const logPath = join(logs, `group-${id}.log`);
    progress.startGroup(id, label);
    const errorPath = join(logs, `group-${id}.stderr.log`);
    report.startGroup(index, logPath, errorPath);
    let termination: ProcessTermination | undefined;
    let error: Error | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let workerFailure: Error | undefined;
    let failedCheck: Plan["sessions"][number]["checks"][number] | undefined;
    const token = randomBytes(16).toString("hex");
    const control = new CheckControl(token, session.checks.length);
    const setupStep = session.checks.reduce((last, check, index) => (check.role === "setup" ? index + 1 : last), 0);
    const retained = new RetainedProcessLogs(logPath, errorPath, logFailure);
    const line = (text: string) => {
      if (text.startsWith(checkControlPrefix)) {
        try {
          const event = control.accept(text);
          if (!event || cancellation.cancelled) return;
          const check = required(session.checks[event.step - 1], "missing controlled check");
          const result = report.event(index, event.step, event.event);
          progress.event(id, label, event.step, `${check.name} (${check.role})`, event.event);
          if (!verbose && event.event !== "start")
            for (const detail of result.details)
              for (const line of checkDetailLines(detail)) progress.message(`  ${line}`);
          if (event.event === "fail") {
            failedCheck = check;
            admissionFailed = true;
            notifyChange?.();
          } else if (event.event === "pass" && event.step === setupStep) {
            setupComplete.add(index);
            notifyChange?.();
          }
        } catch (failure) {
          error ??= failure instanceof Error ? failure : new Error(String(failure));
          admissionFailed = true;
          notifyChange?.();
        }
        return;
      }
      if (text.startsWith(checkDetailPrefix)) {
        try {
          const stored = report.detail(index, text);
          if (!verbose && stored?.check.status === CheckState.Failed)
            for (const line of checkDetailLines(stored.detail)) progress.message(`  ${label}: ${line}`);
        } catch (failure) {
          error ??= failure instanceof Error ? failure : new Error(String(failure));
          admissionFailed = true;
          notifyChange?.();
        }
        return;
      }
      // Public progress from nested tools is cosmetic and cannot satisfy this session's milestones.
      if (text.startsWith(checkEventPrefix)) return;
      if (verbose && text.length > 0) progress.message(`[${path}] ${text}`);
    };
    const longLine = (text: string) => {
      if (text.startsWith(checkDetailPrefix) && Buffer.byteLength(text) > 16384) report.detail(index, text);
      if (verbose) progress.message(`[${path}] ${text}`);
    };
    const stdout = new CheckLines(line, longLine),
      stderr = new CheckLines(line, longLine);
    try {
      await retained.open();
      cancellation.checkpoint();
      const selection: CheckSelection = { ...options };
      selection.checkNames = session.checks.map((check) => check.name);
      delete selection.path;
      delete selection.project;
      delete selection.profile;
      const cpus = allocation.cpuLimit;
      await new Promise<void>((resolve) => {
        owner.beforeSpawn();
        child = spawn(
          process.execPath,
          [
            join(distributionRoot(root), "bin/workbench.mjs"),
            "checks-session",
            path,
            session.environment,
            JSON.stringify(selection),
            token,
            join(logs, `session-${id}`),
          ],
          {
            cwd: root,
            detached: true,
            windowsHide: true,
            env: {
              ...process.env,
              ...(cpus === null ? {} : cpuEnvironment(cpus)),
              WORKBENCH_PROJECT_ROOT: root,
              WORKBENCH_CHECK_EVENTS: "1",
              WORKBENCH_LOG_PERSIST: "0",
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        workers.add(child);
        child.on("message", (value: unknown) => {
          const message = readCheckMessage(value);
          if (message && typeof message === "object" && "type" in message && message.type === CheckMessage.Failure) {
            workerFailure = restoreDiagnosticError("error" in message ? message.error : undefined);
            return;
          }
          if (message && typeof message === "object" && "type" in message && message.type === CheckMessage.LogError) {
            report.logIssue(restoreDiagnosticError("error" in message ? message.error : undefined));
            return;
          }
          if (
            message &&
            typeof message === "object" &&
            "type" in message &&
            message.type === CheckMessage.Logs &&
            "directory" in message &&
            typeof message.directory === "string" &&
            "files" in message &&
            Array.isArray(message.files)
          ) {
            if (message.directory !== join(logs, `session-${id}`)) {
              report.logIssue(new Error("Worker log directory differs from its admitted directory"));
              return;
            }
            report.retainedLogs(
              index,
              message.directory,
              message.files
                .filter(
                  (file: unknown): file is string =>
                    typeof file === "string" && /^step-\d+\.[A-Za-z0-9]{4,12}(?:\.zst)?$/.test(file),
                )
                .slice(0, session.checks.length),
            );
            if ("errors" in message && Array.isArray(message.errors))
              for (const error of message.errors.slice(0, 32)) report.logIssue(restoreDiagnosticError(error));
            return;
          }
          if (
            message &&
            typeof message === "object" &&
            "type" in message &&
            message.type === CheckMessage.Ready &&
            child?.connected
          )
            child.send({ type: cancellation.cancelled ? CheckMessage.Cancel : CheckMessage.Start }, (failure) => {
              if (failure && child?.connected) child.disconnect();
            });
        });
        if (child.stdout) {
          child.stdout.on("data", (chunk: Buffer) => {
            stdout.push(chunk);
          });
          retained.attach(child.stdout, "stdout", [...secretValues(), token]);
        }
        if (child.stderr) {
          child.stderr.on("data", (chunk: Buffer) => {
            stderr.push(chunk);
          });
          retained.attach(child.stderr, "stderr");
        }
        child.on("error", (failure) => {
          error ??= failure;
          admissionFailed = true;
          notifyChange?.();
        });
        child.once("close", (code, signal) => {
          if (child) workers.delete(child);
          termination = { pid: child?.pid ?? null, status: code, signal };
          if (code !== 0)
            error ??= processFailure(`${label}${failedCheck ? `: ${failedCheck.name} (${failedCheck.role})` : ""}`, {
              ...termination,
              pid: termination.pid ?? 0,
              ...(workerFailure ? { error: workerFailure } : {}),
            });
          else if (!control.complete && !cancellation.cancelled)
            error ??= new Error(`${label} exited without completing its check control sequence`);
          resolve();
        });
        try {
          owner.spawned(child.pid, false);
        } catch (failure) {
          error ??= failure instanceof Error ? failure : new Error(String(failure));
          cancellation.cancel();
          // An unregistered worker never receives admission; disconnect also covers its startup window.
          if (child.connected) child.disconnect();
        }
      });
    } catch (failure) {
      error = failure instanceof Error ? failure : new Error(String(failure));
    } finally {
      await retained.close();
      stdout.end();
      stderr.end();
    }
    report.finishGroup(index, error, termination, cancellation.cancelled);
    progress.finishGroup(id, label, cancellation.cancelled ? "cancelled" : !!error);
    if (error) {
      failures.push(error);
      if (!verbose && !cancellation.cancelled) {
        const display = async () => {
          progress.suspend();
          try {
            const stepLog = report.failureLog(index);
            const excerpt = stepLog
              ? `Failed step log: ${stepLog}\nRead full output: workbench logs read '${stepLog.replaceAll("'", "'\\''")}'\n${await checkFailureExcerpt(stepLog)}`
              : `stdout:\n${await checkFailureExcerpt(logPath)}\nstderr:\n${await checkFailureExcerpt(errorPath)}`;
            if (!process.stdout.write(safeOutput(excerpt))) await once(process.stdout, "drain");
          } catch (failure) {
            progress.message(`Cannot display group log: ${String(failure)}`);
          } finally {
            progress.resume();
          }
        };
        diagnostics = diagnostics.then(display, display);
        await diagnostics;
      }
      progress.message(
        `${cancellation.cancelled ? `${label} cancelled` : `${label} failed`}; read full output: workbench logs read '${logPath.replaceAll("'", "'\\''")}'`,
      );
    } else complete.add(index);
    function logFailure(failure: unknown): void {
      report.logIssue(failure);
      error ??= failure instanceof Error ? failure : new Error(String(failure));
      admissionFailed = true;
      notifyChange?.();
    }
  }

  const restoreDiagnostics = routeDiagnostics((text, forward) => {
    progress.diagnostic(text, forward);
  });
  let runFailure: unknown;
  try {
    await withCacheLock(
      logs,
      async () => {
        prepareCheckLogs(storageRoot, checkout, ".", run);
        startLogRun(logs);
        report.result.logs = logs;
        const work = async () => {
          try {
            while (pending.size || active.size) {
              const changed = new Promise<void>((resolve) => {
                notifyChange = resolve;
              });
              if (await cancellation.ready()) {
                for (const index of pending) {
                  if (active.size >= concurrency || failures.length || admissionFailed) break;
                  if (
                    dependencies[index]?.some(
                      (dependency) =>
                        !complete.has(dependency.session) &&
                        !(dependency.phase === "setup" && setupComplete.has(dependency.session)),
                    )
                  )
                    continue;

                  pending.delete(index);
                  active.set(
                    index,
                    execute(index)
                      .catch((failure: unknown) => {
                        failures.push(failure instanceof Error ? failure : new Error(String(failure)));
                      })
                      .finally(() => {
                        active.delete(index);
                      }),
                  );
                }
              }
              if (!active.size) break;
              await Promise.race([...active.values(), changed]);
            }
            cancellation.checkpoint();
            if (failures.length)
              throw new AggregateError(
                failures,
                `Check gate failed (${String(failures.length)} group${failures.length === 1 ? "" : "s"}); see the failed check and retained output above`,
              );
            if (pending.size) throw new Error("check group dependencies could not be satisfied");
          } finally {
            await Promise.allSettled(active.values());
          }
        };
        let failure: unknown;
        try {
          await work();
        } catch (error) {
          failure = error;
        }
        await settleCleanup([() => finishReport(true, failure)], failure);
      },
      undefined,
      cancellation.signal,
    );
  } catch (error) {
    runFailure = error;
    throw error;
  } finally {
    await settleCleanup(
      [
        () => Promise.allSettled(active.values()),
        () => {
          cancellation.signal.removeEventListener("abort", interrupt);
          progress.close(!failures.length && !cancellation.cancelled && !pending.size);
        },
        () => (reportState.finished ? undefined : finishReport(false, runFailure)),
        restoreDiagnostics,
      ],
      runFailure,
    );
  }
}
