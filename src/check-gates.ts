import { resolve } from "node:path";
import { checkReportDestination, writeCheckReport, type CheckRunResult } from "./check-report.js";
import { inspectChecks, listChecks, runChecks, type CheckInspectionOptions } from "./checks.js";
import { validate } from "./validation.js";
import { releaseAfterFailure } from "./cache-lock.js";
import { safeOutput } from "./terminal-text.js";

export interface GateOptions extends CheckInspectionOptions {
  list?: boolean;
  connectivityUrl?: string;
}

const connectivityUrl = "https://api.osv.dev/";
const unavailableCodes = new Set([
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function probeUrl(url: string): URL {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("connectivity URL must use HTTP or HTTPS without credentials");
  return parsed;
}

/** A response establishes connectivity, including HTTP errors; it does not establish check success. */
export async function onlineReachable(url: string = connectivityUrl): Promise<boolean> {
  const parsed = probeUrl(url);
  try {
    const response = await fetch(parsed, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const cause: unknown = error.cause;
    const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
    if (error.name !== "TimeoutError" && !unavailableCodes.has(code)) throw error;
    console.log(
      `Online checks skipped: connectivity to ${parsed.origin} could not be established (${code || error.name}).`,
    );
    return false;
  }
}

async function executeGate(
  root: string,
  mode: "check" | "pre-commit" | "pre-push",
  options: GateOptions,
  recordReport?: (report: CheckRunResult) => void,
): Promise<void> {
  if (mode !== "check" && (options.role?.length || options.excludeRole?.length))
    throw new Error(
      "role selection applies only to check; commit and push gates require their complete configured checks",
    );
  const focused = (options.role?.length ?? 0) > 0 || (options.excludeRole?.length ?? 0) > 0;
  const online = { ...options, online: true, stage: "ci", cache: false };
  const combined = mode === "check" && !focused && options.stage === undefined;
  if (options.connectivityUrl !== undefined) {
    if (!combined) throw new Error("--connectivity-url applies only to the combined check gate");
    probeUrl(options.connectivityUrl);
  }
  const selected = mode === "pre-push" ? online : options;
  if (options.list) {
    if (combined && options.json) {
      console.log(
        JSON.stringify({ preCommit: inspectChecks(root, options), prePush: inspectChecks(root, online) }, null, 2),
      );
    } else {
      listChecks(root, selected);
      if (combined) listChecks(root, online);
    }
    return;
  }
  const validateGate = focused ? undefined : () => validate(root);
  if (mode !== "pre-push") await runChecks(root, selected, validateGate, recordReport);
  if (mode !== "pre-push" && !combined) return;
  if (!inspectChecks(root, online).selected.length) {
    if (mode === "pre-push") await validateGate?.();
    console.log("No online pre-push checks are configured.");
    return;
  }
  if (combined && !(await onlineReachable(options.connectivityUrl))) return;
  await runChecks(root, online, validateGate, recordReport);
}

export async function runGate(
  root: string,
  mode: "check" | "pre-commit" | "pre-push",
  options: GateOptions,
): Promise<void> {
  if (!options.report) return executeGate(root, mode, options);
  if (options.list) throw new Error("--report requires execution; --json describes the plan");
  const path = resolve(root, options.report);
  checkReportDestination(path);
  const runs: CheckRunResult[] = [];
  let success = false;
  let error: string | undefined;
  const save = () => {
    writeCheckReport(path, {
      version: 1,
      kind: "workbench-check-report",
      success,
      ...(error === undefined ? {} : { error }),
      runs,
    });
  };
  try {
    await executeGate(root, mode, options, (run) => {
      runs.push(run);
    });
    success = true;
  } catch (failure) {
    error = safeOutput(failure instanceof Error ? failure.message : String(failure)).slice(0, 8192);
    releaseAfterFailure(save, failure, "Check gate and report publication both failed");
  }
  save();
}
