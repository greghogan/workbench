// Generated from ci-results.mts; edit the TypeScript source.
import { writeDiagnosticText } from "../../../diagnostics/diagnostics.mjs";
import { appendBrowserTimings } from "./ci-browser-timings.mjs";
import { describeError } from "../../../diagnostics/diagnostic-errors.mjs";
import { isRecord as object } from "../../../runtime/values.mjs";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { collectReports, reportState } from "./ci-reports.mjs";
const errorMessage = describeError;
const reportDirectory = (reports, id) => join(reports, createHash("sha256").update(id).digest("hex").slice(0, 24));
function createRunReport(ids, reports) {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("CI requires unique selected target IDs");
  return {
    version: 1,
    targets: ids.map((id) => ({
      id,
      success: false,
      error: "Target was not executed",
      report: reportDirectory(reports, id)
    })),
    errors: []
  };
}
function parseRunReport(value, ids, reports) {
  const text = (entry) => typeof entry === "string" && entry.length > 0;
  const keys = (entry, allowed) => Object.keys(entry).every((key) => allowed.includes(key));
  function invalid() {
    throw new Error("Container produced invalid target results");
  }
  const outcomeKeys = ["success", "error", "report", "started", "finished"];
  const outcome = (result) => {
    const { success, error, report, started, finished } = result;
    const timestamp = (value2) => text(value2) && Number.isFinite(Date.parse(value2));
    if (typeof success !== "boolean" || !text(report)) invalid();
    if (success ? error !== void 0 || !timestamp(started) || !timestamp(finished) : !text(error)) invalid();
    if (started !== void 0 && !timestamp(started)) invalid();
    if (finished !== void 0 && (started === void 0 || !timestamp(finished))) invalid();
    return {
      success,
      report,
      ...typeof error === "string" ? { error } : {},
      ...started === void 0 ? {} : { started },
      ...finished === void 0 ? {} : { finished }
    };
  };
  if (!object(value) || !keys(value, ["version", "targets", "errors"]) || value.version !== 1 || !Array.isArray(value.targets) || !Array.isArray(value.errors))
    invalid();
  const seen = /* @__PURE__ */ new Set();
  const targets = [];
  for (const result of value.targets) {
    if (!object(result) || !keys(result, ["id", "partitions", ...outcomeKeys]) || !text(result.id) || !ids.includes(result.id) || seen.has(result.id))
      invalid();
    const id = result.id;
    seen.add(id);
    const target = { id, ...outcome(result), report: reportDirectory(reports, id) };
    if (result.partitions !== void 0) {
      if (!Array.isArray(result.partitions) || !result.partitions.length || result.partitions.length > 2) invalid();
      target.partitions = result.partitions.map((phase, index) => {
        const network = index === 0 ? "offline" : "online";
        if (!object(phase) || !keys(phase, ["network", "checks", ...outcomeKeys]) || phase.network !== network || !Array.isArray(phase.checks) || !phase.checks.every(text))
          invalid();
        const directory = ids.length === 1 ? target.report : reports;
        return {
          ...outcome(phase),
          network,
          checks: phase.checks,
          report: reportDirectory(join(directory, network), id)
        };
      });
      if (target.success && target.partitions.some((phase) => !phase.success)) invalid();
    }
    targets.push(target);
  }
  if (seen.size !== ids.length) invalid();
  const errors = [];
  for (const error of value.errors) {
    if (!object(error) || !keys(error, ["phase", "message"]) || !text(error.phase) || !text(error.message)) invalid();
    errors.push({ phase: error.phase, message: error.message });
  }
  return {
    version: 1,
    targets,
    errors
  };
}
function writeRunReport(path, report) {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2));
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function targetReporter(run, id, coverage) {
  const result = run.targets.find((entry) => entry.id === id);
  if (!result) throw new Error(`Unselected CI target: ${id}`);
  let before;
  return {
    begin: () => {
      result.started = (/* @__PURE__ */ new Date()).toISOString();
      result.success = false;
      delete result.error;
      mkdirSync(result.report, { recursive: true });
      before = reportState(coverage);
      return result.report;
    },
    pass: () => {
      result.success = true;
    },
    fail: (error) => {
      result.success = false;
      result.error = errorMessage(error);
      if (before === void 0) run.errors.push({ phase: `reports:${id}`, message: result.error });
      writeDiagnosticText(`${id}: ${result.error}`);
    },
    finish: () => {
      if (before !== void 0) {
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
      result.finished = (/* @__PURE__ */ new Date()).toISOString();
    }
  };
}
function runReportedTarget(run, id, coverage, action) {
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
async function runReportedTargetAsync(run, id, coverage, action) {
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
function runSucceeded(run) {
  return !run.errors.length && run.targets.every((target) => target.success);
}
function runSummary(run, reports) {
  const passed = run.targets.filter((target) => target.success).length;
  return `Local CI: ${String(passed)}/${String(run.targets.length)} Linux x64 targets passed; ${String(run.errors.length)} infrastructure errors. Reports: ${reports}`;
}
export {
  createRunReport,
  errorMessage,
  parseRunReport,
  reportDirectory,
  runReportedTarget,
  runReportedTargetAsync,
  runSucceeded,
  runSummary,
  writeRunReport
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLXJlc3VsdHMubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHdyaXRlRGlhZ25vc3RpY1RleHQgfSBmcm9tIFwiLi4vLi4vLi4vZGlhZ25vc3RpY3MvZGlhZ25vc3RpY3MubWpzXCI7XG5pbXBvcnQgeyBhcHBlbmRCcm93c2VyVGltaW5ncyB9IGZyb20gXCIuL2NpLWJyb3dzZXItdGltaW5ncy5tanNcIjtcbmltcG9ydCB7IGRlc2NyaWJlRXJyb3IgfSBmcm9tIFwiLi4vLi4vLi4vZGlhZ25vc3RpY3MvZGlhZ25vc3RpYy1lcnJvcnMubWpzXCI7XG5pbXBvcnQgeyBpc1JlY29yZCBhcyBvYmplY3QgfSBmcm9tIFwiLi4vLi4vLi4vcnVudGltZS92YWx1ZXMubWpzXCI7XG5pbnRlcmZhY2UgQ2hlY2tPdXRjb21lIHtcbiAgc3VjY2VzczogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIHJlcG9ydDogc3RyaW5nO1xuICBzdGFydGVkPzogc3RyaW5nO1xuICBmaW5pc2hlZD86IHN0cmluZztcbn1cbmV4cG9ydCBpbnRlcmZhY2UgVGFyZ2V0UmVzdWx0IGV4dGVuZHMgQ2hlY2tPdXRjb21lIHtcbiAgaWQ6IHN0cmluZztcbiAgcGFydGl0aW9ucz86IChDaGVja091dGNvbWUgJiB7IG5ldHdvcms6IFwib2ZmbGluZVwiIHwgXCJvbmxpbmVcIjsgY2hlY2tzOiBzdHJpbmdbXSB9KVtdO1xufVxuZXhwb3J0IGludGVyZmFjZSBJbmZyYXN0cnVjdHVyZUVycm9yIHtcbiAgcGhhc2U6IHN0cmluZztcbiAgbWVzc2FnZTogc3RyaW5nO1xufVxuZXhwb3J0IGludGVyZmFjZSBSdW5SZXBvcnQge1xuICB2ZXJzaW9uOiAxO1xuICB0YXJnZXRzOiBUYXJnZXRSZXN1bHRbXTtcbiAgZXJyb3JzOiBJbmZyYXN0cnVjdHVyZUVycm9yW107XG59XG5pbXBvcnQgeyBta2RpclN5bmMsIHJlbmFtZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgY29sbGVjdFJlcG9ydHMsIHJlcG9ydFN0YXRlIH0gZnJvbSBcIi4vY2ktcmVwb3J0cy5tanNcIjtcbmltcG9ydCB0eXBlIHsgQmluYXJ5TGlrZSB9IGZyb20gXCJjcnlwdG9cIjtcblxuZXhwb3J0IGNvbnN0IGVycm9yTWVzc2FnZSA9IGRlc2NyaWJlRXJyb3I7XG5leHBvcnQgY29uc3QgcmVwb3J0RGlyZWN0b3J5ID0gKHJlcG9ydHM6IHN0cmluZywgaWQ6IEJpbmFyeUxpa2UpID0+XG4gIGpvaW4ocmVwb3J0cywgY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUoaWQpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAyNCkpO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUnVuUmVwb3J0KGlkczogc3RyaW5nW10sIHJlcG9ydHM6IHN0cmluZyk6IFJ1blJlcG9ydCB7XG4gIGlmICghaWRzLmxlbmd0aCB8fCBuZXcgU2V0KGlkcykuc2l6ZSAhPT0gaWRzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiQ0kgcmVxdWlyZXMgdW5pcXVlIHNlbGVjdGVkIHRhcmdldCBJRHNcIik7XG4gIHJldHVybiB7XG4gICAgdmVyc2lvbjogMSxcbiAgICB0YXJnZXRzOiBpZHMubWFwKChpZCkgPT4gKHtcbiAgICAgIGlkLFxuICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICBlcnJvcjogXCJUYXJnZXQgd2FzIG5vdCBleGVjdXRlZFwiLFxuICAgICAgcmVwb3J0OiByZXBvcnREaXJlY3RvcnkocmVwb3J0cywgaWQpLFxuICAgIH0pKSxcbiAgICBlcnJvcnM6IFtdLFxuICB9O1xufVxuXG4vKiogVmFsaWRhdGUgdGhlIGVudGlyZSBndWVzdCBjb250cmFjdCBiZWZvcmUgYWNjZXB0aW5nIGFueSBvZiBpdHMgb3V0Y29tZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSdW5SZXBvcnQodmFsdWU6IHVua25vd24sIGlkczogc3RyaW5nW10sIHJlcG9ydHM6IHN0cmluZyk6IFJ1blJlcG9ydCB7XG4gIGNvbnN0IHRleHQgPSAoZW50cnk6IHVua25vd24pOiBlbnRyeSBpcyBzdHJpbmcgPT4gdHlwZW9mIGVudHJ5ID09PSBcInN0cmluZ1wiICYmIGVudHJ5Lmxlbmd0aCA+IDA7XG4gIGNvbnN0IGtleXMgPSAoZW50cnk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBhbGxvd2VkOiBzdHJpbmdbXSkgPT5cbiAgICBPYmplY3Qua2V5cyhlbnRyeSkuZXZlcnkoKGtleSkgPT4gYWxsb3dlZC5pbmNsdWRlcyhrZXkpKTtcbiAgZnVuY3Rpb24gaW52YWxpZCgpOiBuZXZlciB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQ29udGFpbmVyIHByb2R1Y2VkIGludmFsaWQgdGFyZ2V0IHJlc3VsdHNcIik7XG4gIH1cbiAgY29uc3Qgb3V0Y29tZUtleXMgPSBbXCJzdWNjZXNzXCIsIFwiZXJyb3JcIiwgXCJyZXBvcnRcIiwgXCJzdGFydGVkXCIsIFwiZmluaXNoZWRcIl07XG4gIGNvbnN0IG91dGNvbWUgPSAocmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IENoZWNrT3V0Y29tZSA9PiB7XG4gICAgY29uc3QgeyBzdWNjZXNzLCBlcnJvciwgcmVwb3J0LCBzdGFydGVkLCBmaW5pc2hlZCB9ID0gcmVzdWx0O1xuICAgIGNvbnN0IHRpbWVzdGFtcCA9ICh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIHN0cmluZyA9PiB0ZXh0KHZhbHVlKSAmJiBOdW1iZXIuaXNGaW5pdGUoRGF0ZS5wYXJzZSh2YWx1ZSkpO1xuICAgIGlmICh0eXBlb2Ygc3VjY2VzcyAhPT0gXCJib29sZWFuXCIgfHwgIXRleHQocmVwb3J0KSkgaW52YWxpZCgpO1xuICAgIGlmIChzdWNjZXNzID8gZXJyb3IgIT09IHVuZGVmaW5lZCB8fCAhdGltZXN0YW1wKHN0YXJ0ZWQpIHx8ICF0aW1lc3RhbXAoZmluaXNoZWQpIDogIXRleHQoZXJyb3IpKSBpbnZhbGlkKCk7XG4gICAgaWYgKHN0YXJ0ZWQgIT09IHVuZGVmaW5lZCAmJiAhdGltZXN0YW1wKHN0YXJ0ZWQpKSBpbnZhbGlkKCk7XG4gICAgaWYgKGZpbmlzaGVkICE9PSB1bmRlZmluZWQgJiYgKHN0YXJ0ZWQgPT09IHVuZGVmaW5lZCB8fCAhdGltZXN0YW1wKGZpbmlzaGVkKSkpIGludmFsaWQoKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3VjY2VzcyxcbiAgICAgIHJlcG9ydCxcbiAgICAgIC4uLih0eXBlb2YgZXJyb3IgPT09IFwic3RyaW5nXCIgPyB7IGVycm9yIH0gOiB7fSksXG4gICAgICAuLi4oc3RhcnRlZCA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHN0YXJ0ZWQgfSksXG4gICAgICAuLi4oZmluaXNoZWQgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBmaW5pc2hlZCB9KSxcbiAgICB9O1xuICB9O1xuICBpZiAoXG4gICAgIW9iamVjdCh2YWx1ZSkgfHxcbiAgICAha2V5cyh2YWx1ZSwgW1widmVyc2lvblwiLCBcInRhcmdldHNcIiwgXCJlcnJvcnNcIl0pIHx8XG4gICAgdmFsdWUudmVyc2lvbiAhPT0gMSB8fFxuICAgICFBcnJheS5pc0FycmF5KHZhbHVlLnRhcmdldHMpIHx8XG4gICAgIUFycmF5LmlzQXJyYXkodmFsdWUuZXJyb3JzKVxuICApXG4gICAgaW52YWxpZCgpO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHRhcmdldHM6IFRhcmdldFJlc3VsdFtdID0gW107XG4gIGZvciAoY29uc3QgcmVzdWx0IG9mIHZhbHVlLnRhcmdldHMpIHtcbiAgICBpZiAoXG4gICAgICAhb2JqZWN0KHJlc3VsdCkgfHxcbiAgICAgICFrZXlzKHJlc3VsdCwgW1wiaWRcIiwgXCJwYXJ0aXRpb25zXCIsIC4uLm91dGNvbWVLZXlzXSkgfHxcbiAgICAgICF0ZXh0KHJlc3VsdC5pZCkgfHxcbiAgICAgICFpZHMuaW5jbHVkZXMocmVzdWx0LmlkKSB8fFxuICAgICAgc2Vlbi5oYXMocmVzdWx0LmlkKVxuICAgIClcbiAgICAgIGludmFsaWQoKTtcbiAgICBjb25zdCBpZCA9IHJlc3VsdC5pZDtcbiAgICBzZWVuLmFkZChpZCk7XG4gICAgY29uc3QgdGFyZ2V0OiBUYXJnZXRSZXN1bHQgPSB7IGlkLCAuLi5vdXRjb21lKHJlc3VsdCksIHJlcG9ydDogcmVwb3J0RGlyZWN0b3J5KHJlcG9ydHMsIGlkKSB9O1xuICAgIGlmIChyZXN1bHQucGFydGl0aW9ucyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoIUFycmF5LmlzQXJyYXkocmVzdWx0LnBhcnRpdGlvbnMpIHx8ICFyZXN1bHQucGFydGl0aW9ucy5sZW5ndGggfHwgcmVzdWx0LnBhcnRpdGlvbnMubGVuZ3RoID4gMikgaW52YWxpZCgpO1xuICAgICAgdGFyZ2V0LnBhcnRpdGlvbnMgPSByZXN1bHQucGFydGl0aW9ucy5tYXAoKHBoYXNlOiB1bmtub3duLCBpbmRleCkgPT4ge1xuICAgICAgICBjb25zdCBuZXR3b3JrID0gaW5kZXggPT09IDAgPyBcIm9mZmxpbmVcIiA6IFwib25saW5lXCI7XG4gICAgICAgIGlmIChcbiAgICAgICAgICAhb2JqZWN0KHBoYXNlKSB8fFxuICAgICAgICAgICFrZXlzKHBoYXNlLCBbXCJuZXR3b3JrXCIsIFwiY2hlY2tzXCIsIC4uLm91dGNvbWVLZXlzXSkgfHxcbiAgICAgICAgICBwaGFzZS5uZXR3b3JrICE9PSBuZXR3b3JrIHx8XG4gICAgICAgICAgIUFycmF5LmlzQXJyYXkocGhhc2UuY2hlY2tzKSB8fFxuICAgICAgICAgICFwaGFzZS5jaGVja3MuZXZlcnkodGV4dClcbiAgICAgICAgKVxuICAgICAgICAgIGludmFsaWQoKTtcbiAgICAgICAgY29uc3QgZGlyZWN0b3J5ID0gaWRzLmxlbmd0aCA9PT0gMSA/IHRhcmdldC5yZXBvcnQgOiByZXBvcnRzO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIC4uLm91dGNvbWUocGhhc2UpLFxuICAgICAgICAgIG5ldHdvcmssXG4gICAgICAgICAgY2hlY2tzOiBwaGFzZS5jaGVja3MsXG4gICAgICAgICAgcmVwb3J0OiByZXBvcnREaXJlY3Rvcnkoam9pbihkaXJlY3RvcnksIG5ldHdvcmspLCBpZCksXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgICAgIGlmICh0YXJnZXQuc3VjY2VzcyAmJiB0YXJnZXQucGFydGl0aW9ucy5zb21lKChwaGFzZSkgPT4gIXBoYXNlLnN1Y2Nlc3MpKSBpbnZhbGlkKCk7XG4gICAgfVxuICAgIHRhcmdldHMucHVzaCh0YXJnZXQpO1xuICB9XG4gIGlmIChzZWVuLnNpemUgIT09IGlkcy5sZW5ndGgpIGludmFsaWQoKTtcbiAgY29uc3QgZXJyb3JzOiBJbmZyYXN0cnVjdHVyZUVycm9yW10gPSBbXTtcbiAgZm9yIChjb25zdCBlcnJvciBvZiB2YWx1ZS5lcnJvcnMpIHtcbiAgICBpZiAoIW9iamVjdChlcnJvcikgfHwgIWtleXMoZXJyb3IsIFtcInBoYXNlXCIsIFwibWVzc2FnZVwiXSkgfHwgIXRleHQoZXJyb3IucGhhc2UpIHx8ICF0ZXh0KGVycm9yLm1lc3NhZ2UpKSBpbnZhbGlkKCk7XG4gICAgZXJyb3JzLnB1c2goeyBwaGFzZTogZXJyb3IucGhhc2UsIG1lc3NhZ2U6IGVycm9yLm1lc3NhZ2UgfSk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIHRhcmdldHMsXG4gICAgZXJyb3JzLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gd3JpdGVSdW5SZXBvcnQocGF0aDogc3RyaW5nLCByZXBvcnQ6IFJ1blJlcG9ydCk6IHZvaWQge1xuICBjb25zdCB0ZW1wb3JhcnkgPSBgJHtwYXRofS4ke1N0cmluZyhwcm9jZXNzLnBpZCl9LnRtcGA7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyh0ZW1wb3JhcnksIEpTT04uc3RyaW5naWZ5KHJlcG9ydCwgbnVsbCwgMikpO1xuICAgIHJlbmFtZVN5bmModGVtcG9yYXJ5LCBwYXRoKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModGVtcG9yYXJ5LCB7IGZvcmNlOiB0cnVlIH0pO1xuICB9XG59XG5cbi8qKiBLZWVwIHN5bmNocm9ub3VzIGxvY2FsIGFkYXB0ZXJzIGFuZCBhc3luY2hyb25vdXMgaG9zdGVkIGFkYXB0ZXJzIG9uIG9uZSBldmlkZW5jZSBsaWZlY3ljbGUuICovXG5mdW5jdGlvbiB0YXJnZXRSZXBvcnRlcihydW46IFJ1blJlcG9ydCwgaWQ6IHN0cmluZywgY292ZXJhZ2U6IHN0cmluZykge1xuICBjb25zdCByZXN1bHQgPSBydW4udGFyZ2V0cy5maW5kKChlbnRyeSkgPT4gZW50cnkuaWQgPT09IGlkKTtcbiAgaWYgKCFyZXN1bHQpIHRocm93IG5ldyBFcnJvcihgVW5zZWxlY3RlZCBDSSB0YXJnZXQ6ICR7aWR9YCk7XG4gIGxldCBiZWZvcmU6IFJldHVyblR5cGU8dHlwZW9mIHJlcG9ydFN0YXRlPiB8IHVuZGVmaW5lZDtcbiAgcmV0dXJuIHtcbiAgICBiZWdpbjogKCkgPT4ge1xuICAgICAgcmVzdWx0LnN0YXJ0ZWQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgICByZXN1bHQuc3VjY2VzcyA9IGZhbHNlO1xuICAgICAgZGVsZXRlIHJlc3VsdC5lcnJvcjtcbiAgICAgIG1rZGlyU3luYyhyZXN1bHQucmVwb3J0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGJlZm9yZSA9IHJlcG9ydFN0YXRlKGNvdmVyYWdlKTtcbiAgICAgIHJldHVybiByZXN1bHQucmVwb3J0O1xuICAgIH0sXG4gICAgcGFzczogKCkgPT4ge1xuICAgICAgcmVzdWx0LnN1Y2Nlc3MgPSB0cnVlO1xuICAgIH0sXG4gICAgZmFpbDogKGVycm9yOiB1bmtub3duKSA9PiB7XG4gICAgICByZXN1bHQuc3VjY2VzcyA9IGZhbHNlO1xuICAgICAgcmVzdWx0LmVycm9yID0gZXJyb3JNZXNzYWdlKGVycm9yKTtcbiAgICAgIGlmIChiZWZvcmUgPT09IHVuZGVmaW5lZCkgcnVuLmVycm9ycy5wdXNoKHsgcGhhc2U6IGByZXBvcnRzOiR7aWR9YCwgbWVzc2FnZTogcmVzdWx0LmVycm9yIH0pO1xuICAgICAgd3JpdGVEaWFnbm9zdGljVGV4dChgJHtpZH06ICR7cmVzdWx0LmVycm9yfWApO1xuICAgIH0sXG4gICAgZmluaXNoOiAoKSA9PiB7XG4gICAgICBpZiAoYmVmb3JlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb2xsZWN0UmVwb3J0cyhjb3ZlcmFnZSwgam9pbihyZXN1bHQucmVwb3J0LCBcImNvdmVyYWdlXCIpLCBiZWZvcmUpO1xuICAgICAgICAgIGFwcGVuZEJyb3dzZXJUaW1pbmdzKGpvaW4ocmVzdWx0LnJlcG9ydCwgXCJjb3ZlcmFnZVwiKSwgaWQpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvck1lc3NhZ2UoZXJyb3IpO1xuICAgICAgICAgIHJ1bi5lcnJvcnMucHVzaCh7IHBoYXNlOiBgcmVwb3J0czoke2lkfWAsIG1lc3NhZ2UgfSk7XG4gICAgICAgICAgcmVzdWx0LnN1Y2Nlc3MgPSBmYWxzZTtcbiAgICAgICAgICByZXN1bHQuZXJyb3IgPSBbcmVzdWx0LmVycm9yLCBgUmVwb3J0IGNvbGxlY3Rpb24gZmFpbGVkOiAke21lc3NhZ2V9YF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCI7IFwiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVzdWx0LmZpbmlzaGVkID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBydW5SZXBvcnRlZFRhcmdldChcbiAgcnVuOiBSdW5SZXBvcnQsXG4gIGlkOiBzdHJpbmcsXG4gIGNvdmVyYWdlOiBzdHJpbmcsXG4gIGFjdGlvbjogKHJlcG9ydDogc3RyaW5nKSA9PiB2b2lkLFxuKTogdm9pZCB7XG4gIGNvbnN0IGF0dGVtcHQgPSB0YXJnZXRSZXBvcnRlcihydW4sIGlkLCBjb3ZlcmFnZSk7XG4gIHRyeSB7XG4gICAgYWN0aW9uKGF0dGVtcHQuYmVnaW4oKSk7XG4gICAgYXR0ZW1wdC5wYXNzKCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgYXR0ZW1wdC5mYWlsKGVycm9yKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhdHRlbXB0LmZpbmlzaCgpO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5SZXBvcnRlZFRhcmdldEFzeW5jKFxuICBydW46IFJ1blJlcG9ydCxcbiAgaWQ6IHN0cmluZyxcbiAgY292ZXJhZ2U6IHN0cmluZyxcbiAgYWN0aW9uOiAocmVwb3J0OiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD4sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYXR0ZW1wdCA9IHRhcmdldFJlcG9ydGVyKHJ1biwgaWQsIGNvdmVyYWdlKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBhY3Rpb24oYXR0ZW1wdC5iZWdpbigpKTtcbiAgICBhdHRlbXB0LnBhc3MoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBhdHRlbXB0LmZhaWwoZXJyb3IpO1xuICB9IGZpbmFsbHkge1xuICAgIGF0dGVtcHQuZmluaXNoKCk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJ1blN1Y2NlZWRlZChydW46IFJ1blJlcG9ydCk6IGJvb2xlYW4ge1xuICByZXR1cm4gIXJ1bi5lcnJvcnMubGVuZ3RoICYmIHJ1bi50YXJnZXRzLmV2ZXJ5KCh0YXJnZXQpID0+IHRhcmdldC5zdWNjZXNzKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJ1blN1bW1hcnkocnVuOiBSdW5SZXBvcnQsIHJlcG9ydHM6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHBhc3NlZCA9IHJ1bi50YXJnZXRzLmZpbHRlcigodGFyZ2V0KSA9PiB0YXJnZXQuc3VjY2VzcykubGVuZ3RoO1xuICByZXR1cm4gYExvY2FsIENJOiAke1N0cmluZyhwYXNzZWQpfS8ke1N0cmluZyhydW4udGFyZ2V0cy5sZW5ndGgpfSBMaW51eCB4NjQgdGFyZ2V0cyBwYXNzZWQ7ICR7U3RyaW5nKHJ1bi5lcnJvcnMubGVuZ3RoKX0gaW5mcmFzdHJ1Y3R1cmUgZXJyb3JzLiBSZXBvcnRzOiAke3JlcG9ydHN9YDtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsWUFBWSxjQUFjO0FBcUJuQyxTQUFTLFdBQVcsWUFBWSxRQUFRLHFCQUFxQjtBQUM3RCxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFlBQVk7QUFDckIsU0FBUyxnQkFBZ0IsbUJBQW1CO0FBR3JDLE1BQU0sZUFBZTtBQUNyQixNQUFNLGtCQUFrQixDQUFDLFNBQWlCLE9BQy9DLEtBQUssU0FBUyxXQUFXLFFBQVEsRUFBRSxPQUFPLEVBQUUsRUFBRSxPQUFPLEtBQUssRUFBRSxNQUFNLEdBQUcsRUFBRSxDQUFDO0FBRW5FLFNBQVMsZ0JBQWdCLEtBQWUsU0FBNEI7QUFDekUsTUFBSSxDQUFDLElBQUksVUFBVSxJQUFJLElBQUksR0FBRyxFQUFFLFNBQVMsSUFBSSxPQUFRLE9BQU0sSUFBSSxNQUFNLHdDQUF3QztBQUM3RyxTQUFPO0FBQUEsSUFDTCxTQUFTO0FBQUEsSUFDVCxTQUFTLElBQUksSUFBSSxDQUFDLFFBQVE7QUFBQSxNQUN4QjtBQUFBLE1BQ0EsU0FBUztBQUFBLE1BQ1QsT0FBTztBQUFBLE1BQ1AsUUFBUSxnQkFBZ0IsU0FBUyxFQUFFO0FBQUEsSUFDckMsRUFBRTtBQUFBLElBQ0YsUUFBUSxDQUFDO0FBQUEsRUFDWDtBQUNGO0FBR08sU0FBUyxlQUFlLE9BQWdCLEtBQWUsU0FBNEI7QUFDeEYsUUFBTSxPQUFPLENBQUMsVUFBb0MsT0FBTyxVQUFVLFlBQVksTUFBTSxTQUFTO0FBQzlGLFFBQU0sT0FBTyxDQUFDLE9BQWdDLFlBQzVDLE9BQU8sS0FBSyxLQUFLLEVBQUUsTUFBTSxDQUFDLFFBQVEs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SztBQUFBLEVBQ3BCLFVBQUU7QUFDQSxZQUFRLE9BQU87QUFBQSxFQUNqQjtBQUNGO0FBRUEsZUFBc0IsdUJBQ3BCLEtBQ0EsSUFDQSxVQUNBLFFBQ2U7QUFDZixRQUFNLFVBQVUsZUFBZSxLQUFLLElBQUksUUFBUTtBQUNoRCxNQUFJO0FBQ0YsVUFBTSxPQUFPLFFBQVEsTUFBTSxDQUFDO0FBQzVCLFlBQVEsS0FBSztBQUFBLEVBQ2YsU0FBUyxPQUFPO0FBQ2QsWUFBUSxLQUFLLEtBQUs7QUFBQSxFQUNwQixVQUFFO0FBQ0EsWUFBUSxPQUFPO0FBQUEsRUFDakI7QUFDRjtBQUVPLFNBQVMsYUFBYSxLQUF5QjtBQUNwRCxTQUFPLENBQUMsSUFBSSxPQUFPLFVBQVUsSUFBSSxRQUFRLE1BQU0sQ0FBQyxXQUFXLE9BQU8sT0FBTztBQUMzRTtBQUVPLFNBQVMsV0FBVyxLQUFnQixTQUF5QjtBQUNsRSxRQUFNLFNBQVMsSUFBSSxRQUFRLE9BQU8sQ0FBQyxXQUFXLE9BQU8sT0FBTyxFQUFFO0FBQzlELFNBQU8sYUFBYSxPQUFPLE1BQU0sQ0FBQyxJQUFJLE9BQU8sSUFBSSxRQUFRLE1BQU0sQ0FBQyw4QkFBOEIsT0FBTyxJQUFJLE9BQU8sTUFBTSxDQUFDLG9DQUFvQyxPQUFPO0FBQ3BLOyIsIm5hbWVzIjpbInZhbHVlIl0sImZpbGUiOiJhcHAvc3JjL2NvcmUvZXhlY3V0aW9uL2NpL3N1cHBvcnQvY2ktcmVzdWx0cy5tanMifQ==
