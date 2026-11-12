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
  if (!object(value) || !keys(value, ["version", "targets", "errors"]) || value.version !== 1 || !Array.isArray(value.targets) || !Array.isArray(value.errors))
    invalid();
  const seen = /* @__PURE__ */ new Set();
  const targets = [];
  for (const result of value.targets) {
    if (!object(result) || !keys(result, ["id", "success", "error", "report", "started", "finished"]) || !text(result.id) || !ids.includes(result.id) || seen.has(result.id) || typeof result.success !== "boolean" || !text(result.report))
      invalid();
    if (result.success ? result.error !== void 0 : !text(result.error)) invalid();
    if (result.success && (!text(result.started) || !text(result.finished))) invalid();
    if (result.finished !== void 0 && result.started === void 0) invalid();
    for (const field of ["started", "finished"])
      if (result[field] !== void 0 && (!text(result[field]) || !Number.isFinite(Date.parse(result[field]))))
        invalid();
    seen.add(result.id);
    targets.push(result);
  }
  if (seen.size !== ids.length) invalid();
  const errors = [];
  for (const error of value.errors) {
    if (!object(error) || !keys(error, ["phase", "message"]) || !text(error.phase) || !text(error.message)) invalid();
    errors.push({ phase: error.phase, message: error.message });
  }
  return {
    version: 1,
    targets: targets.map((result) => ({ ...result, report: reportDirectory(reports, result.id) })),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLXJlc3VsdHMubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHdyaXRlRGlhZ25vc3RpY1RleHQgfSBmcm9tIFwiLi4vLi4vLi4vZGlhZ25vc3RpY3MvZGlhZ25vc3RpY3MubWpzXCI7XG5pbXBvcnQgeyBhcHBlbmRCcm93c2VyVGltaW5ncyB9IGZyb20gXCIuL2NpLWJyb3dzZXItdGltaW5ncy5tanNcIjtcbmltcG9ydCB7IGRlc2NyaWJlRXJyb3IgfSBmcm9tIFwiLi4vLi4vLi4vZGlhZ25vc3RpY3MvZGlhZ25vc3RpYy1lcnJvcnMubWpzXCI7XG5pbXBvcnQgeyBpc1JlY29yZCBhcyBvYmplY3QgfSBmcm9tIFwiLi4vLi4vLi4vcnVudGltZS92YWx1ZXMubWpzXCI7XG5leHBvcnQgaW50ZXJmYWNlIFRhcmdldFJlc3VsdCB7XG4gIGlkOiBzdHJpbmc7XG4gIHN1Y2Nlc3M6IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xuICByZXBvcnQ6IHN0cmluZztcbiAgc3RhcnRlZD86IHN0cmluZztcbiAgZmluaXNoZWQ/OiBzdHJpbmc7XG59XG5leHBvcnQgaW50ZXJmYWNlIEluZnJhc3RydWN0dXJlRXJyb3Ige1xuICBwaGFzZTogc3RyaW5nO1xuICBtZXNzYWdlOiBzdHJpbmc7XG59XG5leHBvcnQgaW50ZXJmYWNlIFJ1blJlcG9ydCB7XG4gIHZlcnNpb246IDE7XG4gIHRhcmdldHM6IFRhcmdldFJlc3VsdFtdO1xuICBlcnJvcnM6IEluZnJhc3RydWN0dXJlRXJyb3JbXTtcbn1cbmltcG9ydCB7IG1rZGlyU3luYywgcmVuYW1lU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBjb2xsZWN0UmVwb3J0cywgcmVwb3J0U3RhdGUgfSBmcm9tIFwiLi9jaS1yZXBvcnRzLm1qc1wiO1xuaW1wb3J0IHR5cGUgeyBCaW5hcnlMaWtlIH0gZnJvbSBcImNyeXB0b1wiO1xuXG5leHBvcnQgY29uc3QgZXJyb3JNZXNzYWdlID0gZGVzY3JpYmVFcnJvcjtcbmV4cG9ydCBjb25zdCByZXBvcnREaXJlY3RvcnkgPSAocmVwb3J0czogc3RyaW5nLCBpZDogQmluYXJ5TGlrZSkgPT5cbiAgam9pbihyZXBvcnRzLCBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShpZCkuZGlnZXN0KFwiaGV4XCIpLnNsaWNlKDAsIDI0KSk7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVSdW5SZXBvcnQoaWRzOiBzdHJpbmdbXSwgcmVwb3J0czogc3RyaW5nKTogUnVuUmVwb3J0IHtcbiAgaWYgKCFpZHMubGVuZ3RoIHx8IG5ldyBTZXQoaWRzKS5zaXplICE9PSBpZHMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJDSSByZXF1aXJlcyB1bmlxdWUgc2VsZWN0ZWQgdGFyZ2V0IElEc1wiKTtcbiAgcmV0dXJuIHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIHRhcmdldHM6IGlkcy5tYXAoKGlkKSA9PiAoe1xuICAgICAgaWQsXG4gICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgIGVycm9yOiBcIlRhcmdldCB3YXMgbm90IGV4ZWN1dGVkXCIsXG4gICAgICByZXBvcnQ6IHJlcG9ydERpcmVjdG9yeShyZXBvcnRzLCBpZCksXG4gICAgfSkpLFxuICAgIGVycm9yczogW10sXG4gIH07XG59XG5cbi8qKiBWYWxpZGF0ZSB0aGUgZW50aXJlIGd1ZXN0IGNvbnRyYWN0IGJlZm9yZSBhY2NlcHRpbmcgYW55IG9mIGl0cyBvdXRjb21lcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVJ1blJlcG9ydCh2YWx1ZTogdW5rbm93biwgaWRzOiBzdHJpbmdbXSwgcmVwb3J0czogc3RyaW5nKTogUnVuUmVwb3J0IHtcbiAgY29uc3QgdGV4dCA9IChlbnRyeTogdW5rbm93bik6IGVudHJ5IGlzIHN0cmluZyA9PiB0eXBlb2YgZW50cnkgPT09IFwic3RyaW5nXCIgJiYgZW50cnkubGVuZ3RoID4gMDtcbiAgY29uc3Qga2V5cyA9IChlbnRyeTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGFsbG93ZWQ6IHN0cmluZ1tdKSA9PlxuICAgIE9iamVjdC5rZXlzKGVudHJ5KS5ldmVyeSgoa2V5KSA9PiBhbGxvd2VkLmluY2x1ZGVzKGtleSkpO1xuICBmdW5jdGlvbiBpbnZhbGlkKCk6IG5ldmVyIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJDb250YWluZXIgcHJvZHVjZWQgaW52YWxpZCB0YXJnZXQgcmVzdWx0c1wiKTtcbiAgfVxuICBpZiAoXG4gICAgIW9iamVjdCh2YWx1ZSkgfHxcbiAgICAha2V5cyh2YWx1ZSwgW1widmVyc2lvblwiLCBcInRhcmdldHNcIiwgXCJlcnJvcnNcIl0pIHx8XG4gICAgdmFsdWUudmVyc2lvbiAhPT0gMSB8fFxuICAgICFBcnJheS5pc0FycmF5KHZhbHVlLnRhcmdldHMpIHx8XG4gICAgIUFycmF5LmlzQXJyYXkodmFsdWUuZXJyb3JzKVxuICApXG4gICAgaW52YWxpZCgpO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHRhcmdldHM6IFRhcmdldFJlc3VsdFtdID0gW107XG4gIGZvciAoY29uc3QgcmVzdWx0IG9mIHZhbHVlLnRhcmdldHMpIHtcbiAgICBpZiAoXG4gICAgICAhb2JqZWN0KHJlc3VsdCkgfHxcbiAgICAgICFrZXlzKHJlc3VsdCwgW1wiaWRcIiwgXCJzdWNjZXNzXCIsIFwiZXJyb3JcIiwgXCJyZXBvcnRcIiwgXCJzdGFydGVkXCIsIFwiZmluaXNoZWRcIl0pIHx8XG4gICAgICAhdGV4dChyZXN1bHQuaWQpIHx8XG4gICAgICAhaWRzLmluY2x1ZGVzKHJlc3VsdC5pZCkgfHxcbiAgICAgIHNlZW4uaGFzKHJlc3VsdC5pZCkgfHxcbiAgICAgIHR5cGVvZiByZXN1bHQuc3VjY2VzcyAhPT0gXCJib29sZWFuXCIgfHxcbiAgICAgICF0ZXh0KHJlc3VsdC5yZXBvcnQpXG4gICAgKVxuICAgICAgaW52YWxpZCgpO1xuICAgIGlmIChyZXN1bHQuc3VjY2VzcyA/IHJlc3VsdC5lcnJvciAhPT0gdW5kZWZpbmVkIDogIXRleHQocmVzdWx0LmVycm9yKSkgaW52YWxpZCgpO1xuICAgIGlmIChyZXN1bHQuc3VjY2VzcyAmJiAoIXRleHQocmVzdWx0LnN0YXJ0ZWQpIHx8ICF0ZXh0KHJlc3VsdC5maW5pc2hlZCkpKSBpbnZhbGlkKCk7XG4gICAgaWYgKHJlc3VsdC5maW5pc2hlZCAhPT0gdW5kZWZpbmVkICYmIHJlc3VsdC5zdGFydGVkID09PSB1bmRlZmluZWQpIGludmFsaWQoKTtcbiAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIFtcInN0YXJ0ZWRcIiwgXCJmaW5pc2hlZFwiXSlcbiAgICAgIGlmIChyZXN1bHRbZmllbGRdICE9PSB1bmRlZmluZWQgJiYgKCF0ZXh0KHJlc3VsdFtmaWVsZF0pIHx8ICFOdW1iZXIuaXNGaW5pdGUoRGF0ZS5wYXJzZShyZXN1bHRbZmllbGRdKSkpKVxuICAgICAgICBpbnZhbGlkKCk7XG4gICAgc2Vlbi5hZGQocmVzdWx0LmlkKTtcbiAgICAvLyBFdmVyeSBmaWVsZCBoYXMgYmVlbiBjaGVja2VkLCBpbmNsdWRpbmcgdGhlIHN1Y2Nlc3MvZXJyb3IgYW5kIHRpbWVzdGFtcCByZWxhdGlvbnNoaXBzLlxuICAgIHRhcmdldHMucHVzaChyZXN1bHQgYXMgdW5rbm93biBhcyBUYXJnZXRSZXN1bHQpO1xuICB9XG4gIGlmIChzZWVuLnNpemUgIT09IGlkcy5sZW5ndGgpIGludmFsaWQoKTtcbiAgY29uc3QgZXJyb3JzOiBJbmZyYXN0cnVjdHVyZUVycm9yW10gPSBbXTtcbiAgZm9yIChjb25zdCBlcnJvciBvZiB2YWx1ZS5lcnJvcnMpIHtcbiAgICBpZiAoIW9iamVjdChlcnJvcikgfHwgIWtleXMoZXJyb3IsIFtcInBoYXNlXCIsIFwibWVzc2FnZVwiXSkgfHwgIXRleHQoZXJyb3IucGhhc2UpIHx8ICF0ZXh0KGVycm9yLm1lc3NhZ2UpKSBpbnZhbGlkKCk7XG4gICAgZXJyb3JzLnB1c2goeyBwaGFzZTogZXJyb3IucGhhc2UsIG1lc3NhZ2U6IGVycm9yLm1lc3NhZ2UgfSk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIHRhcmdldHM6IHRhcmdldHMubWFwKChyZXN1bHQpID0+ICh7IC4uLnJlc3VsdCwgcmVwb3J0OiByZXBvcnREaXJlY3RvcnkocmVwb3J0cywgcmVzdWx0LmlkKSB9KSksXG4gICAgZXJyb3JzLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gd3JpdGVSdW5SZXBvcnQocGF0aDogc3RyaW5nLCByZXBvcnQ6IFJ1blJlcG9ydCk6IHZvaWQge1xuICBjb25zdCB0ZW1wb3JhcnkgPSBgJHtwYXRofS4ke1N0cmluZyhwcm9jZXNzLnBpZCl9LnRtcGA7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyh0ZW1wb3JhcnksIEpTT04uc3RyaW5naWZ5KHJlcG9ydCwgbnVsbCwgMikpO1xuICAgIHJlbmFtZVN5bmModGVtcG9yYXJ5LCBwYXRoKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModGVtcG9yYXJ5LCB7IGZvcmNlOiB0cnVlIH0pO1xuICB9XG59XG5cbi8qKiBLZWVwIHN5bmNocm9ub3VzIGxvY2FsIGFkYXB0ZXJzIGFuZCBhc3luY2hyb25vdXMgaG9zdGVkIGFkYXB0ZXJzIG9uIG9uZSBldmlkZW5jZSBsaWZlY3ljbGUuICovXG5mdW5jdGlvbiB0YXJnZXRSZXBvcnRlcihydW46IFJ1blJlcG9ydCwgaWQ6IHN0cmluZywgY292ZXJhZ2U6IHN0cmluZykge1xuICBjb25zdCByZXN1bHQgPSBydW4udGFyZ2V0cy5maW5kKChlbnRyeSkgPT4gZW50cnkuaWQgPT09IGlkKTtcbiAgaWYgKCFyZXN1bHQpIHRocm93IG5ldyBFcnJvcihgVW5zZWxlY3RlZCBDSSB0YXJnZXQ6ICR7aWR9YCk7XG4gIGxldCBiZWZvcmU6IFJldHVyblR5cGU8dHlwZW9mIHJlcG9ydFN0YXRlPiB8IHVuZGVmaW5lZDtcbiAgcmV0dXJuIHtcbiAgICBiZWdpbjogKCkgPT4ge1xuICAgICAgcmVzdWx0LnN0YXJ0ZWQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgICByZXN1bHQuc3VjY2VzcyA9IGZhbHNlO1xuICAgICAgZGVsZXRlIHJlc3VsdC5lcnJvcjtcbiAgICAgIG1rZGlyU3luYyhyZXN1bHQucmVwb3J0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGJlZm9yZSA9IHJlcG9ydFN0YXRlKGNvdmVyYWdlKTtcbiAgICAgIHJldHVybiByZXN1bHQucmVwb3J0O1xuICAgIH0sXG4gICAgcGFzczogKCkgPT4ge1xuICAgICAgcmVzdWx0LnN1Y2Nlc3MgPSB0cnVlO1xuICAgIH0sXG4gICAgZmFpbDogKGVycm9yOiB1bmtub3duKSA9PiB7XG4gICAgICByZXN1bHQuc3VjY2VzcyA9IGZhbHNlO1xuICAgICAgcmVzdWx0LmVycm9yID0gZXJyb3JNZXNzYWdlKGVycm9yKTtcbiAgICAgIGlmIChiZWZvcmUgPT09IHVuZGVmaW5lZCkgcnVuLmVycm9ycy5wdXNoKHsgcGhhc2U6IGByZXBvcnRzOiR7aWR9YCwgbWVzc2FnZTogcmVzdWx0LmVycm9yIH0pO1xuICAgICAgd3JpdGVEaWFnbm9zdGljVGV4dChgJHtpZH06ICR7cmVzdWx0LmVycm9yfWApO1xuICAgIH0sXG4gICAgZmluaXNoOiAoKSA9PiB7XG4gICAgICBpZiAoYmVmb3JlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb2xsZWN0UmVwb3J0cyhjb3ZlcmFnZSwgam9pbihyZXN1bHQucmVwb3J0LCBcImNvdmVyYWdlXCIpLCBiZWZvcmUpO1xuICAgICAgICAgIGFwcGVuZEJyb3dzZXJUaW1pbmdzKGpvaW4ocmVzdWx0LnJlcG9ydCwgXCJjb3ZlcmFnZVwiKSwgaWQpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvck1lc3NhZ2UoZXJyb3IpO1xuICAgICAgICAgIHJ1bi5lcnJvcnMucHVzaCh7IHBoYXNlOiBgcmVwb3J0czoke2lkfWAsIG1lc3NhZ2UgfSk7XG4gICAgICAgICAgcmVzdWx0LnN1Y2Nlc3MgPSBmYWxzZTtcbiAgICAgICAgICByZXN1bHQuZXJyb3IgPSBbcmVzdWx0LmVycm9yLCBgUmVwb3J0IGNvbGxlY3Rpb24gZmFpbGVkOiAke21lc3NhZ2V9YF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCI7IFwiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVzdWx0LmZpbmlzaGVkID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBydW5SZXBvcnRlZFRhcmdldChcbiAgcnVuOiBSdW5SZXBvcnQsXG4gIGlkOiBzdHJpbmcsXG4gIGNvdmVyYWdlOiBzdHJpbmcsXG4gIGFjdGlvbjogKHJlcG9ydDogc3RyaW5nKSA9PiB2b2lkLFxuKTogdm9pZCB7XG4gIGNvbnN0IGF0dGVtcHQgPSB0YXJnZXRSZXBvcnRlcihydW4sIGlkLCBjb3ZlcmFnZSk7XG4gIHRyeSB7XG4gICAgYWN0aW9uKGF0dGVtcHQuYmVnaW4oKSk7XG4gICAgYXR0ZW1wdC5wYXNzKCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgYXR0ZW1wdC5mYWlsKGVycm9yKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhdHRlbXB0LmZpbmlzaCgpO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5SZXBvcnRlZFRhcmdldEFzeW5jKFxuICBydW46IFJ1blJlcG9ydCxcbiAgaWQ6IHN0cmluZyxcbiAgY292ZXJhZ2U6IHN0cmluZyxcbiAgYWN0aW9uOiAocmVwb3J0OiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD4sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYXR0ZW1wdCA9IHRhcmdldFJlcG9ydGVyKHJ1biwgaWQsIGNvdmVyYWdlKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBhY3Rpb24oYXR0ZW1wdC5iZWdpbigpKTtcbiAgICBhdHRlbXB0LnBhc3MoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBhdHRlbXB0LmZhaWwoZXJyb3IpO1xuICB9IGZpbmFsbHkge1xuICAgIGF0dGVtcHQuZmluaXNoKCk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJ1blN1Y2NlZWRlZChydW46IFJ1blJlcG9ydCk6IGJvb2xlYW4ge1xuICByZXR1cm4gIXJ1bi5lcnJvcnMubGVuZ3RoICYmIHJ1bi50YXJnZXRzLmV2ZXJ5KCh0YXJnZXQpID0+IHRhcmdldC5zdWNjZXNzKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJ1blN1bW1hcnkocnVuOiBSdW5SZXBvcnQsIHJlcG9ydHM6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHBhc3NlZCA9IHJ1bi50YXJnZXRzLmZpbHRlcigodGFyZ2V0KSA9PiB0YXJnZXQuc3VjY2VzcykubGVuZ3RoO1xuICByZXR1cm4gYExvY2FsIENJOiAke1N0cmluZyhwYXNzZWQpfS8ke1N0cmluZyhydW4udGFyZ2V0cy5sZW5ndGgpfSBMaW51eCB4NjQgdGFyZ2V0cyBwYXNzZWQ7ICR7U3RyaW5nKHJ1bi5lcnJvcnMubGVuZ3RoKX0gaW5mcmFzdHJ1Y3R1cmUgZXJyb3JzLiBSZXBvcnRzOiAke3JlcG9ydHN9YDtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsWUFBWSxjQUFjO0FBa0JuQyxTQUFTLFdBQVcsWUFBWSxRQUFRLHFCQUFxQjtBQUM3RCxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFlBQVk7QUFDckIsU0FBUyxnQkFBZ0IsbUJBQW1CO0FBR3JDLE1BQU0sZUFBZTtBQUNyQixNQUFNLGtCQUFrQixDQUFDLFNBQWlCLE9BQy9DLEtBQUssU0FBUyxXQUFXLFFBQVEsRUFBRSxPQUFPLEVBQUUsRUFBRSxPQUFPLEtBQUssRUFBRSxNQUFN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VUFBVSxHQUFHLE1BQU07QUFDaEUsK0JBQXFCLEtBQUssT0FBTyxRQUFRLFVBQVUsR0FBRyxFQUFFO0FBQUEsUUFDMUQsU0FBUyxPQUFPO0FBQ2QsZ0JBQU0sVUFBVSxhQUFhLEtBQUs7QUFDbEMsY0FBSSxPQUFPLEtBQUssRUFBRSxPQUFPLFdBQVcsRUFBRSxJQUFJLFFBQVEsQ0FBQztBQUNuRCxpQkFBTyxVQUFVO0FBQ2pCLGlCQUFPLFFBQVEsQ0FBQyxPQUFPLE9BQU8sNkJBQTZCLE9BQU8sRUFBRSxFQUFFLE9BQU8sT0FBTyxFQUFFLEtBQUssSUFBSTtBQUFBLFFBQ2pHO0FBQUEsTUFDRjtBQUNBLGFBQU8sWUFBVyxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLElBQzNDO0FBQUEsRUFDRjtBQUNGO0FBRU8sU0FBUyxrQkFDZCxLQUNBLElBQ0EsVUFDQSxRQUNNO0FBQ04sUUFBTSxVQUFVLGVBQWUsS0FBSyxJQUFJLFFBQVE7QUFDaEQsTUFBSTtBQUNGLFdBQU8sUUFBUSxNQUFNLENBQUM7QUFDdEIsWUFBUSxLQUFLO0FBQUEsRUFDZixTQUFTLE9BQU87QUFDZCxZQUFRLEtBQUssS0FBSztBQUFBLEVBQ3BCLFVBQUU7QUFDQSxZQUFRLE9BQU87QUFBQSxFQUNqQjtBQUNGO0FBRUEsZUFBc0IsdUJBQ3BCLEtBQ0EsSUFDQSxVQUNBLFFBQ2U7QUFDZixRQUFNLFVBQVUsZUFBZSxLQUFLLElBQUksUUFBUTtBQUNoRCxNQUFJO0FBQ0YsVUFBTSxPQUFPLFFBQVEsTUFBTSxDQUFDO0FBQzVCLFlBQVEsS0FBSztBQUFBLEVBQ2YsU0FBUyxPQUFPO0FBQ2QsWUFBUSxLQUFLLEtBQUs7QUFBQSxFQUNwQixVQUFFO0FBQ0EsWUFBUSxPQUFPO0FBQUEsRUFDakI7QUFDRjtBQUVPLFNBQVMsYUFBYSxLQUF5QjtBQUNwRCxTQUFPLENBQUMsSUFBSSxPQUFPLFVBQVUsSUFBSSxRQUFRLE1BQU0sQ0FBQyxXQUFXLE9BQU8sT0FBTztBQUMzRTtBQUVPLFNBQVMsV0FBVyxLQUFnQixTQUF5QjtBQUNsRSxRQUFNLFNBQVMsSUFBSSxRQUFRLE9BQU8sQ0FBQyxXQUFXLE9BQU8sT0FBTyxFQUFFO0FBQzlELFNBQU8sYUFBYSxPQUFPLE1BQU0sQ0FBQyxJQUFJLE9BQU8sSUFBSSxRQUFRLE1BQU0sQ0FBQyw4QkFBOEIsT0FBTyxJQUFJLE9BQU8sTUFBTSxDQUFDLG9DQUFvQyxPQUFPO0FBQ3BLOyIsIm5hbWVzIjpbXSwiZmlsZSI6ImFwcC9zcmMvY29yZS9leGVjdXRpb24vY2kvc3VwcG9ydC9jaS1yZXN1bHRzLm1qcyJ9
