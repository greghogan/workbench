import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { collectReports, reportState } from "./ci-reports.mjs";

export const errorMessage = (error) => (error instanceof Error ? error.message : String(error));
export const reportDirectory = (reports, id) =>
  join(reports, createHash("sha256").update(id).digest("hex").slice(0, 24));

export function createRunReport(ids, reports) {
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
export function parseRunReport(value, ids, reports) {
  const object = (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry);
  const text = (entry) => typeof entry === "string" && entry.length > 0;
  const keys = (entry, allowed) => Object.keys(entry).every((key) => allowed.includes(key));
  const invalid = () => {
    throw new Error("Container produced invalid target results");
  };
  if (
    !object(value) ||
    !keys(value, ["version", "targets", "errors"]) ||
    value.version !== 1 ||
    !Array.isArray(value.targets) ||
    !Array.isArray(value.errors)
  )
    invalid();
  const seen = new Set();
  for (const result of value.targets) {
    if (
      !object(result) ||
      !keys(result, ["id", "success", "error", "report", "started", "finished"]) ||
      !ids.includes(result.id) ||
      seen.has(result.id) ||
      typeof result.success !== "boolean" ||
      !text(result.report)
    )
      invalid();
    if (result.success ? result.error !== undefined : !text(result.error)) invalid();
    if (result.success && (!text(result.started) || !text(result.finished))) invalid();
    if (result.finished !== undefined && result.started === undefined) invalid();
    for (const field of ["started", "finished"])
      if (result[field] !== undefined && (!text(result[field]) || !Number.isFinite(Date.parse(result[field]))))
        invalid();
    seen.add(result.id);
  }
  if (seen.size !== ids.length) invalid();
  for (const error of value.errors)
    if (!object(error) || !keys(error, ["phase", "message"]) || !text(error.phase) || !text(error.message)) invalid();
  return {
    version: 1,
    targets: value.targets.map((result) => ({ ...result, report: reportDirectory(reports, result.id) })),
    errors: value.errors.map((error) => ({ ...error })),
  };
}

export function writeRunReport(path, report) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2));
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Host and guest use identical attempt, evidence, and partial-failure semantics. */
export function runReportedTarget(run, id, coverage, action) {
  const result = run.targets.find((entry) => entry.id === id);
  if (!result) throw new Error(`Unselected CI target: ${id}`);
  result.started = new Date().toISOString();
  delete result.error;
  let before;
  try {
    mkdirSync(result.report, { recursive: true });
    before = reportState(coverage);
    action(result.report);
    result.success = true;
  } catch (error) {
    result.success = false;
    result.error = errorMessage(error);
    if (before === undefined) run.errors.push({ phase: `reports:${id}`, message: result.error });
    console.error(`${id}: ${result.error}`);
  } finally {
    if (before !== undefined) {
      try {
        collectReports(coverage, join(result.report, "coverage"), before);
      } catch (error) {
        const message = errorMessage(error);
        run.errors.push({ phase: `reports:${id}`, message });
        result.success = false;
        result.error = [result.error, `Report collection failed: ${message}`].filter(Boolean).join("; ");
      }
    }
    result.finished = new Date().toISOString();
  }
}

export function runSucceeded(run) {
  return !run.errors.length && run.targets.every((target) => target.success);
}

export function runSummary(run, reports) {
  const passed = run.targets.filter((target) => target.success).length;
  return `Local CI: ${passed}/${run.targets.length} Linux x64 targets passed; ${run.errors.length} infrastructure errors. Reports: ${reports}`;
}
