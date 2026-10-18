import { CheckReport, writeCheckReport, type CheckRunResult } from "./check-report.js";
import { checkDetailPrefix } from "../scripts/check-detail-data.mjs";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { relative, join } from "node:path";
import { checkFailureExcerpt, presentCheckSummaries } from "./check-output.js";
import { distributionRoot } from "./core.js";
import { buildCheckout, buildStorageSettings, prepareCheckLogs, checkLogDirectory } from "./builds.js";
import { withCacheLock, releaseAfterFailure } from "./cache-lock.js";
import { checkExecution } from "./check-resources.js";
import { CheckControl, checkControlPrefix } from "./check-control.js";
import { required } from "./invariants.js";
import { cpuEnvironment } from "../scripts/cpu-budget.mjs";
import type { CheckCancellation } from "./check-cancellation.js";
import type { ProcessLock } from "./process-lock.js";
import { CheckLines, CheckProgress, checkEventPrefix } from "./check-progress.js";
import { safeOutput } from "./terminal-text.js";
import { errorMessage } from "../scripts/ci-results.mjs";
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
  const finishedLogs = new Map<number, string>();
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
  const finishReport = (owned: boolean, failure?: unknown) => {
    reportState.finished = true;
    report.finish(
      failure === undefined && !failures.length && !cancellation.cancelled && !pending.size,
      cancellation.cancelled,
    );
    if (failure !== undefined) report.result.error = safeOutput(errorMessage(failure)).slice(0, 8192);
    for (const check of report.result.checks)
      if (check.omittedDetails)
        console.error(
          `${safeOutput(check.name)}: ${String(check.omittedDetails)} check details omitted from the report (size limit).`,
        );
    try {
      if (owned) writeCheckReport(join(logs, "results.json"), report.result);
    } finally {
      recordReport?.(report.result);
      if (owned) console.log(`Full check logs: ${logs}`);
    }
  };
  const interrupt = () => {
    progress.stop();
    for (const child of workers)
      if (child.connected)
        child.send({ type: "workbench-check-cancel" }, () => {
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
    const output = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
    let error: Error | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let failedCheck: Plan["sessions"][number]["checks"][number] | undefined;
    const token = randomBytes(16).toString("hex");
    const control = new CheckControl(token, session.checks.length);
    const setupStep = session.checks.reduce((last, check, index) => (check.role === "setup" ? index + 1 : last), 0);
    output.on("error", (failure) => {
      error ??= failure;
      admissionFailed = true;
      notifyChange?.();
      child?.stdout?.resume();
      child?.stderr?.resume();
    });
    const line = (text: string) => {
      if (text.startsWith(checkControlPrefix)) {
        try {
          const event = control.accept(text);
          if (!event || cancellation.cancelled) return;
          const check = required(session.checks[event.step - 1], "missing controlled check");
          report.event(index, event.step, event.event);
          progress.event(id, label, event.step, `${check.name} (${check.role})`, event.event);
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
          report.detail(index, text);
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
      await once(output, "open");
      cancellation.checkpoint();
      const selection: CheckSelection = { ...options };
      selection.checkNames = session.checks.map((check) => check.name);
      delete selection.path;
      delete selection.project;
      delete selection.profile;
      const cpus = required(allocation.cpus[index], "missing check CPU allocation");
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
          ],
          {
            cwd: root,
            detached: true,
            windowsHide: true,
            env: { ...process.env, ...cpuEnvironment(cpus), WORKBENCH_PROJECT_ROOT: root, WORKBENCH_CHECK_EVENTS: "1" },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        workers.add(child);
        child.on("message", (message: unknown) => {
          if (
            message &&
            typeof message === "object" &&
            "type" in message &&
            message.type === "workbench-check-ready" &&
            child?.connected
          )
            child.send(
              { type: cancellation.cancelled ? "workbench-check-cancel" : "workbench-check-start" },
              (failure) => {
                if (failure && child?.connected) child.disconnect();
              },
            );
        });
        child.stdout
          ?.on("data", (chunk: Buffer) => {
            stdout.push(chunk);
          })
          .pipe(output, { end: false });
        child.stderr
          ?.on("data", (chunk: Buffer) => {
            stderr.push(chunk);
          })
          .pipe(output, { end: false });
        child.on("error", (failure) => {
          error ??= failure;
          admissionFailed = true;
          notifyChange?.();
        });
        child.once("close", (code, signal) => {
          if (child) workers.delete(child);
          if (code !== 0)
            error ??= new Error(
              `${label}${failedCheck ? `: ${failedCheck.name} (${failedCheck.role})` : ""} failed: ${String(code ?? signal)}`,
            );
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
      stdout.end();
      stderr.end();
      output.end();
      if (!output.closed)
        await once(output, "close").catch((failure: unknown) => {
          error ??= failure instanceof Error ? failure : new Error(String(failure));
        });
    }
    progress.finishGroup(id, label, cancellation.cancelled ? "cancelled" : !!error);
    finishedLogs.set(index, logPath);
    if (error) {
      failures.push(error);
      if (!verbose && !cancellation.cancelled) {
        const display = async () => {
          progress.suspend();
          try {
            if (!process.stdout.write(safeOutput(await checkFailureExcerpt(logPath))))
              await once(process.stdout, "drain");
          } catch (failure) {
            progress.message(`Cannot display group log: ${String(failure)}`);
          } finally {
            progress.resume();
          }
        };
        diagnostics = diagnostics.then(display, display);
        await diagnostics;
      }
      progress.message(`${cancellation.cancelled ? `${label} cancelled` : error.message}; log: ${logPath}`);
    } else complete.add(index);
  }

  try {
    await withCacheLock(
      logs,
      async () => {
        prepareCheckLogs(storageRoot, checkout, ".", run);
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
                  const occupied = [...active.keys()].reduce(
                    (sum, activeIndex) => sum + required(allocation.cpus[activeIndex], "missing active CPU allocation"),
                    0,
                  );
                  if (
                    occupied + required(allocation.cpus[index], "missing pending CPU allocation") >
                    allocation.availableCpus
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
                `Check gate failed: ${failures.map((failure) => failure.message).join("; ")}`,
              );
            if (pending.size) throw new Error("check group dependencies could not be satisfied");
          } finally {
            await Promise.allSettled(active.values());
            progress.close(!failures.length && !cancellation.cancelled && !pending.size);
            if (!verbose)
              await presentCheckSummaries(
                [...finishedLogs]
                  .sort(([left], [right]) => left - right)
                  .map(([index, log]) => {
                    const session = required(plan.sessions[index], "missing completed session");
                    return {
                      log,
                      root: relative(root, session.directory).replaceAll("\\", "/") || ".",
                      environment: session.environment,
                    };
                  }),
              );
          }
        };
        try {
          await work();
        } catch (failure) {
          releaseAfterFailure(
            () => {
              finishReport(true, failure);
            },
            failure,
            "Check execution and report publication both failed",
          );
        }
        finishReport(true);
      },
      undefined,
      cancellation.signal,
    );
  } finally {
    await Promise.allSettled(active.values());
    cancellation.signal.removeEventListener("abort", interrupt);
    progress.close(!failures.length && !cancellation.cancelled && !pending.size);
    if (!reportState.finished) finishReport(false);
  }
}
