// Generated from ci-results.mts; edit the TypeScript source.
import { appendBrowserTimings } from "./ci-browser-timings.mjs";
import { describeError } from "./diagnostic-errors.mjs";
import { isRecord as object } from "./values.mjs";
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
      console.error(`${id}: ${result.error}`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLXJlc3VsdHMubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGFwcGVuZEJyb3dzZXJUaW1pbmdzIH0gZnJvbSBcIi4vY2ktYnJvd3Nlci10aW1pbmdzLm1qc1wiO1xuaW1wb3J0IHsgZGVzY3JpYmVFcnJvciB9IGZyb20gXCIuL2RpYWdub3N0aWMtZXJyb3JzLm1qc1wiO1xuaW1wb3J0IHsgaXNSZWNvcmQgYXMgb2JqZWN0IH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuZXhwb3J0IGludGVyZmFjZSBUYXJnZXRSZXN1bHQge1xuICBpZDogc3RyaW5nO1xuICBzdWNjZXNzOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbiAgcmVwb3J0OiBzdHJpbmc7XG4gIHN0YXJ0ZWQ/OiBzdHJpbmc7XG4gIGZpbmlzaGVkPzogc3RyaW5nO1xufVxuZXhwb3J0IGludGVyZmFjZSBJbmZyYXN0cnVjdHVyZUVycm9yIHtcbiAgcGhhc2U6IHN0cmluZztcbiAgbWVzc2FnZTogc3RyaW5nO1xufVxuZXhwb3J0IGludGVyZmFjZSBSdW5SZXBvcnQge1xuICB2ZXJzaW9uOiAxO1xuICB0YXJnZXRzOiBUYXJnZXRSZXN1bHRbXTtcbiAgZXJyb3JzOiBJbmZyYXN0cnVjdHVyZUVycm9yW107XG59XG5pbXBvcnQgeyBta2RpclN5bmMsIHJlbmFtZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgY29sbGVjdFJlcG9ydHMsIHJlcG9ydFN0YXRlIH0gZnJvbSBcIi4vY2ktcmVwb3J0cy5tanNcIjtcbmltcG9ydCB0eXBlIHsgQmluYXJ5TGlrZSB9IGZyb20gXCJjcnlwdG9cIjtcblxuZXhwb3J0IGNvbnN0IGVycm9yTWVzc2FnZSA9IGRlc2NyaWJlRXJyb3I7XG5leHBvcnQgY29uc3QgcmVwb3J0RGlyZWN0b3J5ID0gKHJlcG9ydHM6IHN0cmluZywgaWQ6IEJpbmFyeUxpa2UpID0+XG4gIGpvaW4ocmVwb3J0cywgY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUoaWQpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAyNCkpO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUnVuUmVwb3J0KGlkczogc3RyaW5nW10sIHJlcG9ydHM6IHN0cmluZyk6IFJ1blJlcG9ydCB7XG4gIGlmICghaWRzLmxlbmd0aCB8fCBuZXcgU2V0KGlkcykuc2l6ZSAhPT0gaWRzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiQ0kgcmVxdWlyZXMgdW5pcXVlIHNlbGVjdGVkIHRhcmdldCBJRHNcIik7XG4gIHJldHVybiB7XG4gICAgdmVyc2lvbjogMSxcbiAgICB0YXJnZXRzOiBpZHMubWFwKChpZCkgPT4gKHtcbiAgICAgIGlkLFxuICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICBlcnJvcjogXCJUYXJnZXQgd2FzIG5vdCBleGVjdXRlZFwiLFxuICAgICAgcmVwb3J0OiByZXBvcnREaXJlY3RvcnkocmVwb3J0cywgaWQpLFxuICAgIH0pKSxcbiAgICBlcnJvcnM6IFtdLFxuICB9O1xufVxuXG4vKiogVmFsaWRhdGUgdGhlIGVudGlyZSBndWVzdCBjb250cmFjdCBiZWZvcmUgYWNjZXB0aW5nIGFueSBvZiBpdHMgb3V0Y29tZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSdW5SZXBvcnQodmFsdWU6IHVua25vd24sIGlkczogc3RyaW5nW10sIHJlcG9ydHM6IHN0cmluZyk6IFJ1blJlcG9ydCB7XG4gIGNvbnN0IHRleHQgPSAoZW50cnk6IHVua25vd24pOiBlbnRyeSBpcyBzdHJpbmcgPT4gdHlwZW9mIGVudHJ5ID09PSBcInN0cmluZ1wiICYmIGVudHJ5Lmxlbmd0aCA+IDA7XG4gIGNvbnN0IGtleXMgPSAoZW50cnk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBhbGxvd2VkOiBzdHJpbmdbXSkgPT5cbiAgICBPYmplY3Qua2V5cyhlbnRyeSkuZXZlcnkoKGtleSkgPT4gYWxsb3dlZC5pbmNsdWRlcyhrZXkpKTtcbiAgZnVuY3Rpb24gaW52YWxpZCgpOiBuZXZlciB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQ29udGFpbmVyIHByb2R1Y2VkIGludmFsaWQgdGFyZ2V0IHJlc3VsdHNcIik7XG4gIH1cbiAgaWYgKFxuICAgICFvYmplY3QodmFsdWUpIHx8XG4gICAgIWtleXModmFsdWUsIFtcInZlcnNpb25cIiwgXCJ0YXJnZXRzXCIsIFwiZXJyb3JzXCJdKSB8fFxuICAgIHZhbHVlLnZlcnNpb24gIT09IDEgfHxcbiAgICAhQXJyYXkuaXNBcnJheSh2YWx1ZS50YXJnZXRzKSB8fFxuICAgICFBcnJheS5pc0FycmF5KHZhbHVlLmVycm9ycylcbiAgKVxuICAgIGludmFsaWQoKTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCB0YXJnZXRzOiBUYXJnZXRSZXN1bHRbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJlc3VsdCBvZiB2YWx1ZS50YXJnZXRzKSB7XG4gICAgaWYgKFxuICAgICAgIW9iamVjdChyZXN1bHQpIHx8XG4gICAgICAha2V5cyhyZXN1bHQsIFtcImlkXCIsIFwic3VjY2Vzc1wiLCBcImVycm9yXCIsIFwicmVwb3J0XCIsIFwic3RhcnRlZFwiLCBcImZpbmlzaGVkXCJdKSB8fFxuICAgICAgIXRleHQocmVzdWx0LmlkKSB8fFxuICAgICAgIWlkcy5pbmNsdWRlcyhyZXN1bHQuaWQpIHx8XG4gICAgICBzZWVuLmhhcyhyZXN1bHQuaWQpIHx8XG4gICAgICB0eXBlb2YgcmVzdWx0LnN1Y2Nlc3MgIT09IFwiYm9vbGVhblwiIHx8XG4gICAgICAhdGV4dChyZXN1bHQucmVwb3J0KVxuICAgIClcbiAgICAgIGludmFsaWQoKTtcbiAgICBpZiAocmVzdWx0LnN1Y2Nlc3MgPyByZXN1bHQuZXJyb3IgIT09IHVuZGVmaW5lZCA6ICF0ZXh0KHJlc3VsdC5lcnJvcikpIGludmFsaWQoKTtcbiAgICBpZiAocmVzdWx0LnN1Y2Nlc3MgJiYgKCF0ZXh0KHJlc3VsdC5zdGFydGVkKSB8fCAhdGV4dChyZXN1bHQuZmluaXNoZWQpKSkgaW52YWxpZCgpO1xuICAgIGlmIChyZXN1bHQuZmluaXNoZWQgIT09IHVuZGVmaW5lZCAmJiByZXN1bHQuc3RhcnRlZCA9PT0gdW5kZWZpbmVkKSBpbnZhbGlkKCk7XG4gICAgZm9yIChjb25zdCBmaWVsZCBvZiBbXCJzdGFydGVkXCIsIFwiZmluaXNoZWRcIl0pXG4gICAgICBpZiAocmVzdWx0W2ZpZWxkXSAhPT0gdW5kZWZpbmVkICYmICghdGV4dChyZXN1bHRbZmllbGRdKSB8fCAhTnVtYmVyLmlzRmluaXRlKERhdGUucGFyc2UocmVzdWx0W2ZpZWxkXSkpKSlcbiAgICAgICAgaW52YWxpZCgpO1xuICAgIHNlZW4uYWRkKHJlc3VsdC5pZCk7XG4gICAgLy8gRXZlcnkgZmllbGQgaGFzIGJlZW4gY2hlY2tlZCwgaW5jbHVkaW5nIHRoZSBzdWNjZXNzL2Vycm9yIGFuZCB0aW1lc3RhbXAgcmVsYXRpb25zaGlwcy5cbiAgICB0YXJnZXRzLnB1c2gocmVzdWx0IGFzIHVua25vd24gYXMgVGFyZ2V0UmVzdWx0KTtcbiAgfVxuICBpZiAoc2Vlbi5zaXplICE9PSBpZHMubGVuZ3RoKSBpbnZhbGlkKCk7XG4gIGNvbnN0IGVycm9yczogSW5mcmFzdHJ1Y3R1cmVFcnJvcltdID0gW107XG4gIGZvciAoY29uc3QgZXJyb3Igb2YgdmFsdWUuZXJyb3JzKSB7XG4gICAgaWYgKCFvYmplY3QoZXJyb3IpIHx8ICFrZXlzKGVycm9yLCBbXCJwaGFzZVwiLCBcIm1lc3NhZ2VcIl0pIHx8ICF0ZXh0KGVycm9yLnBoYXNlKSB8fCAhdGV4dChlcnJvci5tZXNzYWdlKSkgaW52YWxpZCgpO1xuICAgIGVycm9ycy5wdXNoKHsgcGhhc2U6IGVycm9yLnBoYXNlLCBtZXNzYWdlOiBlcnJvci5tZXNzYWdlIH0pO1xuICB9XG4gIHJldHVybiB7XG4gICAgdmVyc2lvbjogMSxcbiAgICB0YXJnZXRzOiB0YXJnZXRzLm1hcCgocmVzdWx0KSA9PiAoeyAuLi5yZXN1bHQsIHJlcG9ydDogcmVwb3J0RGlyZWN0b3J5KHJlcG9ydHMsIHJlc3VsdC5pZCkgfSkpLFxuICAgIGVycm9ycyxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlUnVuUmVwb3J0KHBhdGg6IHN0cmluZywgcmVwb3J0OiBSdW5SZXBvcnQpOiB2b2lkIHtcbiAgY29uc3QgdGVtcG9yYXJ5ID0gYCR7cGF0aH0uJHtTdHJpbmcocHJvY2Vzcy5waWQpfS50bXBgO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmModGVtcG9yYXJ5LCBKU09OLnN0cmluZ2lmeShyZXBvcnQsIG51bGwsIDIpKTtcbiAgICByZW5hbWVTeW5jKHRlbXBvcmFyeSwgcGF0aCk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRlbXBvcmFyeSwgeyBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufVxuXG4vKiogS2VlcCBzeW5jaHJvbm91cyBsb2NhbCBhZGFwdGVycyBhbmQgYXN5bmNocm9ub3VzIGhvc3RlZCBhZGFwdGVycyBvbiBvbmUgZXZpZGVuY2UgbGlmZWN5Y2xlLiAqL1xuZnVuY3Rpb24gdGFyZ2V0UmVwb3J0ZXIocnVuOiBSdW5SZXBvcnQsIGlkOiBzdHJpbmcsIGNvdmVyYWdlOiBzdHJpbmcpIHtcbiAgY29uc3QgcmVzdWx0ID0gcnVuLnRhcmdldHMuZmluZCgoZW50cnkpID0+IGVudHJ5LmlkID09PSBpZCk7XG4gIGlmICghcmVzdWx0KSB0aHJvdyBuZXcgRXJyb3IoYFVuc2VsZWN0ZWQgQ0kgdGFyZ2V0OiAke2lkfWApO1xuICBsZXQgYmVmb3JlOiBSZXR1cm5UeXBlPHR5cGVvZiByZXBvcnRTdGF0ZT4gfCB1bmRlZmluZWQ7XG4gIHJldHVybiB7XG4gICAgYmVnaW46ICgpID0+IHtcbiAgICAgIHJlc3VsdC5zdGFydGVkID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgICAgcmVzdWx0LnN1Y2Nlc3MgPSBmYWxzZTtcbiAgICAgIGRlbGV0ZSByZXN1bHQuZXJyb3I7XG4gICAgICBta2RpclN5bmMocmVzdWx0LnJlcG9ydCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBiZWZvcmUgPSByZXBvcnRTdGF0ZShjb3ZlcmFnZSk7XG4gICAgICByZXR1cm4gcmVzdWx0LnJlcG9ydDtcbiAgICB9LFxuICAgIHBhc3M6ICgpID0+IHtcbiAgICAgIHJlc3VsdC5zdWNjZXNzID0gdHJ1ZTtcbiAgICB9LFxuICAgIGZhaWw6IChlcnJvcjogdW5rbm93bikgPT4ge1xuICAgICAgcmVzdWx0LnN1Y2Nlc3MgPSBmYWxzZTtcbiAgICAgIHJlc3VsdC5lcnJvciA9IGVycm9yTWVzc2FnZShlcnJvcik7XG4gICAgICBpZiAoYmVmb3JlID09PSB1bmRlZmluZWQpIHJ1bi5lcnJvcnMucHVzaCh7IHBoYXNlOiBgcmVwb3J0czoke2lkfWAsIG1lc3NhZ2U6IHJlc3VsdC5lcnJvciB9KTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYCR7aWR9OiAke3Jlc3VsdC5lcnJvcn1gKTtcbiAgICB9LFxuICAgIGZpbmlzaDogKCkgPT4ge1xuICAgICAgaWYgKGJlZm9yZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29sbGVjdFJlcG9ydHMoY292ZXJhZ2UsIGpvaW4ocmVzdWx0LnJlcG9ydCwgXCJjb3ZlcmFnZVwiKSwgYmVmb3JlKTtcbiAgICAgICAgICBhcHBlbmRCcm93c2VyVGltaW5ncyhqb2luKHJlc3VsdC5yZXBvcnQsIFwiY292ZXJhZ2VcIiksIGlkKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yKTtcbiAgICAgICAgICBydW4uZXJyb3JzLnB1c2goeyBwaGFzZTogYHJlcG9ydHM6JHtpZH1gLCBtZXNzYWdlIH0pO1xuICAgICAgICAgIHJlc3VsdC5zdWNjZXNzID0gZmFsc2U7XG4gICAgICAgICAgcmVzdWx0LmVycm9yID0gW3Jlc3VsdC5lcnJvciwgYFJlcG9ydCBjb2xsZWN0aW9uIGZhaWxlZDogJHttZXNzYWdlfWBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiOyBcIik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJlc3VsdC5maW5pc2hlZCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgICB9LFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcnVuUmVwb3J0ZWRUYXJnZXQoXG4gIHJ1bjogUnVuUmVwb3J0LFxuICBpZDogc3RyaW5nLFxuICBjb3ZlcmFnZTogc3RyaW5nLFxuICBhY3Rpb246IChyZXBvcnQ6IHN0cmluZykgPT4gdm9pZCxcbik6IHZvaWQge1xuICBjb25zdCBhdHRlbXB0ID0gdGFyZ2V0UmVwb3J0ZXIocnVuLCBpZCwgY292ZXJhZ2UpO1xuICB0cnkge1xuICAgIGFjdGlvbihhdHRlbXB0LmJlZ2luKCkpO1xuICAgIGF0dGVtcHQucGFzcygpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGF0dGVtcHQuZmFpbChlcnJvcik7XG4gIH0gZmluYWxseSB7XG4gICAgYXR0ZW1wdC5maW5pc2goKTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuUmVwb3J0ZWRUYXJnZXRBc3luYyhcbiAgcnVuOiBSdW5SZXBvcnQsXG4gIGlkOiBzdHJpbmcsXG4gIGNvdmVyYWdlOiBzdHJpbmcsXG4gIGFjdGlvbjogKHJlcG9ydDogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGF0dGVtcHQgPSB0YXJnZXRSZXBvcnRlcihydW4sIGlkLCBjb3ZlcmFnZSk7XG4gIHRyeSB7XG4gICAgYXdhaXQgYWN0aW9uKGF0dGVtcHQuYmVnaW4oKSk7XG4gICAgYXR0ZW1wdC5wYXNzKCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgYXR0ZW1wdC5mYWlsKGVycm9yKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhdHRlbXB0LmZpbmlzaCgpO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBydW5TdWNjZWVkZWQocnVuOiBSdW5SZXBvcnQpOiBib29sZWFuIHtcbiAgcmV0dXJuICFydW4uZXJyb3JzLmxlbmd0aCAmJiBydW4udGFyZ2V0cy5ldmVyeSgodGFyZ2V0KSA9PiB0YXJnZXQuc3VjY2Vzcyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBydW5TdW1tYXJ5KHJ1bjogUnVuUmVwb3J0LCByZXBvcnRzOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBwYXNzZWQgPSBydW4udGFyZ2V0cy5maWx0ZXIoKHRhcmdldCkgPT4gdGFyZ2V0LnN1Y2Nlc3MpLmxlbmd0aDtcbiAgcmV0dXJuIGBMb2NhbCBDSTogJHtTdHJpbmcocGFzc2VkKX0vJHtTdHJpbmcocnVuLnRhcmdldHMubGVuZ3RoKX0gTGludXggeDY0IHRhcmdldHMgcGFzc2VkOyAke1N0cmluZyhydW4uZXJyb3JzLmxlbmd0aCl9IGluZnJhc3RydWN0dXJlIGVycm9ycy4gUmVwb3J0czogJHtyZXBvcnRzfWA7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLFlBQVksY0FBYztBQWtCbkMsU0FBUyxXQUFXLFlBQVksUUFBUSxxQkFBcUI7QUFDN0QsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsZ0JBQWdCLG1CQUFtQjtBQUdyQyxNQUFNLGVBQWU7QUFDckIsTUFBTSxrQkFBa0IsQ0FBQyxTQUFpQixPQUMvQyxLQUFLLFNBQVMsV0FBVyxRQUFRLEVBQUUsT0FBTyxFQUFFLEVBQUUsT0FBTyxLQUFLLEVBQUUsTUFBTSxHQUFHLEVBQUUsQ0FBQztBQUVuRSxTQUFTLGdCQUFnQixLQUFlLFNBQTRCO0FBQ3pFLE1BQUksQ0FBQyxJQUFJLFVBQVUsSUFBSSxJQUFJLEdBQUcsRUFBRSxTQUFTLElBQUksT0FBUSxPQUFNLElBQUksTUFBTSx3Q0FBd0M7QUFDN0csU0FB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
