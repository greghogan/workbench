import { writeDiagnosticText } from "../../../diagnostics/diagnostics.mjs";
import { appendBrowserTimings } from "./ci-browser-timings.mjs";
import { describeError } from "../../../diagnostics/diagnostic-errors.mjs";
import { isRecord as object } from "../../../runtime/values.mjs";
interface CheckOutcome {
  success: boolean;
  error?: string;
  report: string;
  started?: string;
  finished?: string;
}
export interface TargetResult extends CheckOutcome {
  id: string;
  partitions?: (CheckOutcome & { network: "offline" | "online"; checks: string[] })[];
}
export interface InfrastructureError {
  phase: string;
  message: string;
}
export interface RunReport {
  version: 1;
  targets: TargetResult[];
  errors: InfrastructureError[];
}
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { collectReports, reportState } from "./ci-reports.mjs";
import type { BinaryLike } from "crypto";

export const errorMessage = describeError;
export const reportDirectory = (reports: string, id: BinaryLike) =>
  join(reports, createHash("sha256").update(id).digest("hex").slice(0, 24));

export function createRunReport(ids: string[], reports: string): RunReport {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("CI requires unique selected target IDs");
  return {
    version: 1,
    targets: ids.map((id) => ({
      id,
      success: false,
      error: "Target was not executed",
      report: reportDirectory(reports, id),
    })),
    errors: [],
  };
}

/** Validate the entire guest contract before accepting any of its outcomes. */
export function parseRunReport(value: unknown, ids: string[], reports: string): RunReport {
  const text = (entry: unknown): entry is string => typeof entry === "string" && entry.length > 0;
  const keys = (entry: Record<string, unknown>, allowed: string[]) =>
    Object.keys(entry).every((key) => allowed.includes(key));
  function invalid(): never {
    throw new Error("Container produced invalid target results");
  }
  const outcomeKeys = ["success", "error", "report", "started", "finished"];
  const outcome = (result: Record<string, unknown>): CheckOutcome => {
    const { success, error, report, started, finished } = result;
    const timestamp = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
    if (typeof success !== "boolean" || !text(report)) invalid();
    if (success ? error !== undefined || !timestamp(started) || !timestamp(finished) : !text(error)) invalid();
    if (started !== undefined && !timestamp(started)) invalid();
    if (finished !== undefined && (started === undefined || !timestamp(finished))) invalid();
    return {
      success,
      report,
      ...(typeof error === "string" ? { error } : {}),
      ...(started === undefined ? {} : { started }),
      ...(finished === undefined ? {} : { finished }),
    };
  };
  if (
    !object(value) ||
    !keys(value, ["version", "targets", "errors"]) ||
    value.version !== 1 ||
    !Array.isArray(value.targets) ||
    !Array.isArray(value.errors)
  )
    invalid();
  const seen = new Set<string>();
  const targets: TargetResult[] = [];
  for (const result of value.targets) {
    if (
      !object(result) ||
      !keys(result, ["id", "partitions", ...outcomeKeys]) ||
      !text(result.id) ||
      !ids.includes(result.id) ||
      seen.has(result.id)
    )
      invalid();
    const id = result.id;
    seen.add(id);
    const target: TargetResult = { id, ...outcome(result), report: reportDirectory(reports, id) };
    if (result.partitions !== undefined) {
      if (!Array.isArray(result.partitions) || !result.partitions.length || result.partitions.length > 2) invalid();
      target.partitions = result.partitions.map((phase: unknown, index) => {
        const network = index === 0 ? "offline" : "online";
        if (
          !object(phase) ||
          !keys(phase, ["network", "checks", ...outcomeKeys]) ||
          phase.network !== network ||
          !Array.isArray(phase.checks) ||
          !phase.checks.every(text)
        )
          invalid();
        const directory = ids.length === 1 ? target.report : reports;
        return {
          ...outcome(phase),
          network,
          checks: phase.checks,
          report: reportDirectory(join(directory, network), id),
        };
      });
      if (target.success && target.partitions.some((phase) => !phase.success)) invalid();
    }
    targets.push(target);
  }
  if (seen.size !== ids.length) invalid();
  const errors: InfrastructureError[] = [];
  for (const error of value.errors) {
    if (!object(error) || !keys(error, ["phase", "message"]) || !text(error.phase) || !text(error.message)) invalid();
    errors.push({ phase: error.phase, message: error.message });
  }
  return {
    version: 1,
    targets,
    errors,
  };
}

export function writeRunReport(path: string, report: RunReport): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2));
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Keep synchronous local adapters and asynchronous hosted adapters on one evidence lifecycle. */
function targetReporter(run: RunReport, id: string, coverage: string) {
  const result = run.targets.find((entry) => entry.id === id);
  if (!result) throw new Error(`Unselected CI target: ${id}`);
  let before: ReturnType<typeof reportState> | undefined;
  return {
    begin: () => {
      result.started = new Date().toISOString();
      result.success = false;
      delete result.error;
      mkdirSync(result.report, { recursive: true });
      before = reportState(coverage);
      return result.report;
    },
    pass: () => {
      result.success = true;
    },
    fail: (error: unknown) => {
      result.success = false;
      result.error = errorMessage(error);
      if (before === undefined) run.errors.push({ phase: `reports:${id}`, message: result.error });
      writeDiagnosticText(`${id}: ${result.error}`);
    },
    finish: () => {
      if (before !== undefined) {
        try {
          collectReports(coverage, join(result.report, "coverage"), before);
          appendBrowserTimings(join(result.report, "coverage"), id);
        } catch (error) {
          const message = errorMessage(error);
          run.errors.push({ phase: `reports:${id}`, message });
          result.success = false;
          result.error = [result.error, `Report collection failed: ${message}`].filter(Boolean).join("; ");
        }
      }
      result.finished = new Date().toISOString();
    },
  };
}

export function runReportedTarget(
  run: RunReport,
  id: string,
  coverage: string,
  action: (report: string) => void,
): void {
  const attempt = targetReporter(run, id, coverage);
  try {
    action(attempt.begin());
    attempt.pass();
  } catch (error) {
    attempt.fail(error);
  } finally {
    attempt.finish();
  }
}

export async function runReportedTargetAsync(
  run: RunReport,
  id: string,
  coverage: string,
  action: (report: string) => Promise<void>,
): Promise<void> {
  const attempt = targetReporter(run, id, coverage);
  try {
    await action(attempt.begin());
    attempt.pass();
  } catch (error) {
    attempt.fail(error);
  } finally {
    attempt.finish();
  }
}

export function runSucceeded(run: RunReport): boolean {
  return !run.errors.length && run.targets.every((target) => target.success);
}

export function runSummary(run: RunReport, reports: string): string {
  const passed = run.targets.filter((target) => target.success).length;
  return `Local CI: ${String(passed)}/${String(run.targets.length)} Linux x64 targets passed; ${String(run.errors.length)} infrastructure errors. Reports: ${reports}`;
}
