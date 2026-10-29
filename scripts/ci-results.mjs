// Generated from ci-results.mts; edit the TypeScript source.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLXJlc3VsdHMubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGRlc2NyaWJlRXJyb3IgfSBmcm9tIFwiLi9kaWFnbm9zdGljLWVycm9ycy5tanNcIjtcbmltcG9ydCB7IGlzUmVjb3JkIGFzIG9iamVjdCB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmV4cG9ydCBpbnRlcmZhY2UgVGFyZ2V0UmVzdWx0IHtcbiAgaWQ6IHN0cmluZztcbiAgc3VjY2VzczogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIHJlcG9ydDogc3RyaW5nO1xuICBzdGFydGVkPzogc3RyaW5nO1xuICBmaW5pc2hlZD86IHN0cmluZztcbn1cbmV4cG9ydCBpbnRlcmZhY2UgSW5mcmFzdHJ1Y3R1cmVFcnJvciB7XG4gIHBoYXNlOiBzdHJpbmc7XG4gIG1lc3NhZ2U6IHN0cmluZztcbn1cbmV4cG9ydCBpbnRlcmZhY2UgUnVuUmVwb3J0IHtcbiAgdmVyc2lvbjogMTtcbiAgdGFyZ2V0czogVGFyZ2V0UmVzdWx0W107XG4gIGVycm9yczogSW5mcmFzdHJ1Y3R1cmVFcnJvcltdO1xufVxuaW1wb3J0IHsgbWtkaXJTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGNvbGxlY3RSZXBvcnRzLCByZXBvcnRTdGF0ZSB9IGZyb20gXCIuL2NpLXJlcG9ydHMubWpzXCI7XG5pbXBvcnQgdHlwZSB7IEJpbmFyeUxpa2UgfSBmcm9tIFwiY3J5cHRvXCI7XG5cbmV4cG9ydCBjb25zdCBlcnJvck1lc3NhZ2UgPSBkZXNjcmliZUVycm9yO1xuZXhwb3J0IGNvbnN0IHJlcG9ydERpcmVjdG9yeSA9IChyZXBvcnRzOiBzdHJpbmcsIGlkOiBCaW5hcnlMaWtlKSA9PlxuICBqb2luKHJlcG9ydHMsIGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKGlkKS5kaWdlc3QoXCJoZXhcIikuc2xpY2UoMCwgMjQpKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVJ1blJlcG9ydChpZHM6IHN0cmluZ1tdLCByZXBvcnRzOiBzdHJpbmcpOiBSdW5SZXBvcnQge1xuICBpZiAoIWlkcy5sZW5ndGggfHwgbmV3IFNldChpZHMpLnNpemUgIT09IGlkcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcIkNJIHJlcXVpcmVzIHVuaXF1ZSBzZWxlY3RlZCB0YXJnZXQgSURzXCIpO1xuICByZXR1cm4ge1xuICAgIHZlcnNpb246IDEsXG4gICAgdGFyZ2V0czogaWRzLm1hcCgoaWQpID0+ICh7XG4gICAgICBpZCxcbiAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgZXJyb3I6IFwiVGFyZ2V0IHdhcyBub3QgZXhlY3V0ZWRcIixcbiAgICAgIHJlcG9ydDogcmVwb3J0RGlyZWN0b3J5KHJlcG9ydHMsIGlkKSxcbiAgICB9KSksXG4gICAgZXJyb3JzOiBbXSxcbiAgfTtcbn1cblxuLyoqIFZhbGlkYXRlIHRoZSBlbnRpcmUgZ3Vlc3QgY29udHJhY3QgYmVmb3JlIGFjY2VwdGluZyBhbnkgb2YgaXRzIG91dGNvbWVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUnVuUmVwb3J0KHZhbHVlOiB1bmtub3duLCBpZHM6IHN0cmluZ1tdLCByZXBvcnRzOiBzdHJpbmcpOiBSdW5SZXBvcnQge1xuICBjb25zdCB0ZXh0ID0gKGVudHJ5OiB1bmtub3duKTogZW50cnkgaXMgc3RyaW5nID0+IHR5cGVvZiBlbnRyeSA9PT0gXCJzdHJpbmdcIiAmJiBlbnRyeS5sZW5ndGggPiAwO1xuICBjb25zdCBrZXlzID0gKGVudHJ5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgYWxsb3dlZDogc3RyaW5nW10pID0+XG4gICAgT2JqZWN0LmtleXMoZW50cnkpLmV2ZXJ5KChrZXkpID0+IGFsbG93ZWQuaW5jbHVkZXMoa2V5KSk7XG4gIGZ1bmN0aW9uIGludmFsaWQoKTogbmV2ZXIge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkNvbnRhaW5lciBwcm9kdWNlZCBpbnZhbGlkIHRhcmdldCByZXN1bHRzXCIpO1xuICB9XG4gIGlmIChcbiAgICAhb2JqZWN0KHZhbHVlKSB8fFxuICAgICFrZXlzKHZhbHVlLCBbXCJ2ZXJzaW9uXCIsIFwidGFyZ2V0c1wiLCBcImVycm9yc1wiXSkgfHxcbiAgICB2YWx1ZS52ZXJzaW9uICE9PSAxIHx8XG4gICAgIUFycmF5LmlzQXJyYXkodmFsdWUudGFyZ2V0cykgfHxcbiAgICAhQXJyYXkuaXNBcnJheSh2YWx1ZS5lcnJvcnMpXG4gIClcbiAgICBpbnZhbGlkKCk7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgdGFyZ2V0czogVGFyZ2V0UmVzdWx0W10gPSBbXTtcbiAgZm9yIChjb25zdCByZXN1bHQgb2YgdmFsdWUudGFyZ2V0cykge1xuICAgIGlmIChcbiAgICAgICFvYmplY3QocmVzdWx0KSB8fFxuICAgICAgIWtleXMocmVzdWx0LCBbXCJpZFwiLCBcInN1Y2Nlc3NcIiwgXCJlcnJvclwiLCBcInJlcG9ydFwiLCBcInN0YXJ0ZWRcIiwgXCJmaW5pc2hlZFwiXSkgfHxcbiAgICAgICF0ZXh0KHJlc3VsdC5pZCkgfHxcbiAgICAgICFpZHMuaW5jbHVkZXMocmVzdWx0LmlkKSB8fFxuICAgICAgc2Vlbi5oYXMocmVzdWx0LmlkKSB8fFxuICAgICAgdHlwZW9mIHJlc3VsdC5zdWNjZXNzICE9PSBcImJvb2xlYW5cIiB8fFxuICAgICAgIXRleHQocmVzdWx0LnJlcG9ydClcbiAgICApXG4gICAgICBpbnZhbGlkKCk7XG4gICAgaWYgKHJlc3VsdC5zdWNjZXNzID8gcmVzdWx0LmVycm9yICE9PSB1bmRlZmluZWQgOiAhdGV4dChyZXN1bHQuZXJyb3IpKSBpbnZhbGlkKCk7XG4gICAgaWYgKHJlc3VsdC5zdWNjZXNzICYmICghdGV4dChyZXN1bHQuc3RhcnRlZCkgfHwgIXRleHQocmVzdWx0LmZpbmlzaGVkKSkpIGludmFsaWQoKTtcbiAgICBpZiAocmVzdWx0LmZpbmlzaGVkICE9PSB1bmRlZmluZWQgJiYgcmVzdWx0LnN0YXJ0ZWQgPT09IHVuZGVmaW5lZCkgaW52YWxpZCgpO1xuICAgIGZvciAoY29uc3QgZmllbGQgb2YgW1wic3RhcnRlZFwiLCBcImZpbmlzaGVkXCJdKVxuICAgICAgaWYgKHJlc3VsdFtmaWVsZF0gIT09IHVuZGVmaW5lZCAmJiAoIXRleHQocmVzdWx0W2ZpZWxkXSkgfHwgIU51bWJlci5pc0Zpbml0ZShEYXRlLnBhcnNlKHJlc3VsdFtmaWVsZF0pKSkpXG4gICAgICAgIGludmFsaWQoKTtcbiAgICBzZWVuLmFkZChyZXN1bHQuaWQpO1xuICAgIC8vIEV2ZXJ5IGZpZWxkIGhhcyBiZWVuIGNoZWNrZWQsIGluY2x1ZGluZyB0aGUgc3VjY2Vzcy9lcnJvciBhbmQgdGltZXN0YW1wIHJlbGF0aW9uc2hpcHMuXG4gICAgdGFyZ2V0cy5wdXNoKHJlc3VsdCBhcyB1bmtub3duIGFzIFRhcmdldFJlc3VsdCk7XG4gIH1cbiAgaWYgKHNlZW4uc2l6ZSAhPT0gaWRzLmxlbmd0aCkgaW52YWxpZCgpO1xuICBjb25zdCBlcnJvcnM6IEluZnJhc3RydWN0dXJlRXJyb3JbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGVycm9yIG9mIHZhbHVlLmVycm9ycykge1xuICAgIGlmICghb2JqZWN0KGVycm9yKSB8fCAha2V5cyhlcnJvciwgW1wicGhhc2VcIiwgXCJtZXNzYWdlXCJdKSB8fCAhdGV4dChlcnJvci5waGFzZSkgfHwgIXRleHQoZXJyb3IubWVzc2FnZSkpIGludmFsaWQoKTtcbiAgICBlcnJvcnMucHVzaCh7IHBoYXNlOiBlcnJvci5waGFzZSwgbWVzc2FnZTogZXJyb3IubWVzc2FnZSB9KTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHZlcnNpb246IDEsXG4gICAgdGFyZ2V0czogdGFyZ2V0cy5tYXAoKHJlc3VsdCkgPT4gKHsgLi4ucmVzdWx0LCByZXBvcnQ6IHJlcG9ydERpcmVjdG9yeShyZXBvcnRzLCByZXN1bHQuaWQpIH0pKSxcbiAgICBlcnJvcnMsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZVJ1blJlcG9ydChwYXRoOiBzdHJpbmcsIHJlcG9ydDogUnVuUmVwb3J0KTogdm9pZCB7XG4gIGNvbnN0IHRlbXBvcmFyeSA9IGAke3BhdGh9LiR7U3RyaW5nKHByb2Nlc3MucGlkKX0udG1wYDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHRlbXBvcmFyeSwgSlNPTi5zdHJpbmdpZnkocmVwb3J0LCBudWxsLCAyKSk7XG4gICAgcmVuYW1lU3luYyh0ZW1wb3JhcnksIHBhdGgpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0ZW1wb3JhcnksIHsgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn1cblxuLyoqIEtlZXAgc3luY2hyb25vdXMgbG9jYWwgYWRhcHRlcnMgYW5kIGFzeW5jaHJvbm91cyBob3N0ZWQgYWRhcHRlcnMgb24gb25lIGV2aWRlbmNlIGxpZmVjeWNsZS4gKi9cbmZ1bmN0aW9uIHRhcmdldFJlcG9ydGVyKHJ1bjogUnVuUmVwb3J0LCBpZDogc3RyaW5nLCBjb3ZlcmFnZTogc3RyaW5nKSB7XG4gIGNvbnN0IHJlc3VsdCA9IHJ1bi50YXJnZXRzLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5pZCA9PT0gaWQpO1xuICBpZiAoIXJlc3VsdCkgdGhyb3cgbmV3IEVycm9yKGBVbnNlbGVjdGVkIENJIHRhcmdldDogJHtpZH1gKTtcbiAgbGV0IGJlZm9yZTogUmV0dXJuVHlwZTx0eXBlb2YgcmVwb3J0U3RhdGU+IHwgdW5kZWZpbmVkO1xuICByZXR1cm4ge1xuICAgIGJlZ2luOiAoKSA9PiB7XG4gICAgICByZXN1bHQuc3RhcnRlZCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgICAgIHJlc3VsdC5zdWNjZXNzID0gZmFsc2U7XG4gICAgICBkZWxldGUgcmVzdWx0LmVycm9yO1xuICAgICAgbWtkaXJTeW5jKHJlc3VsdC5yZXBvcnQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgYmVmb3JlID0gcmVwb3J0U3RhdGUoY292ZXJhZ2UpO1xuICAgICAgcmV0dXJuIHJlc3VsdC5yZXBvcnQ7XG4gICAgfSxcbiAgICBwYXNzOiAoKSA9PiB7XG4gICAgICByZXN1bHQuc3VjY2VzcyA9IHRydWU7XG4gICAgfSxcbiAgICBmYWlsOiAoZXJyb3I6IHVua25vd24pID0+IHtcbiAgICAgIHJlc3VsdC5zdWNjZXNzID0gZmFsc2U7XG4gICAgICByZXN1bHQuZXJyb3IgPSBlcnJvck1lc3NhZ2UoZXJyb3IpO1xuICAgICAgaWYgKGJlZm9yZSA9PT0gdW5kZWZpbmVkKSBydW4uZXJyb3JzLnB1c2goeyBwaGFzZTogYHJlcG9ydHM6JHtpZH1gLCBtZXNzYWdlOiByZXN1bHQuZXJyb3IgfSk7XG4gICAgICBjb25zb2xlLmVycm9yKGAke2lkfTogJHtyZXN1bHQuZXJyb3J9YCk7XG4gICAgfSxcbiAgICBmaW5pc2g6ICgpID0+IHtcbiAgICAgIGlmIChiZWZvcmUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbGxlY3RSZXBvcnRzKGNvdmVyYWdlLCBqb2luKHJlc3VsdC5yZXBvcnQsIFwiY292ZXJhZ2VcIiksIGJlZm9yZSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yTWVzc2FnZShlcnJvcik7XG4gICAgICAgICAgcnVuLmVycm9ycy5wdXNoKHsgcGhhc2U6IGByZXBvcnRzOiR7aWR9YCwgbWVzc2FnZSB9KTtcbiAgICAgICAgICByZXN1bHQuc3VjY2VzcyA9IGZhbHNlO1xuICAgICAgICAgIHJlc3VsdC5lcnJvciA9IFtyZXN1bHQuZXJyb3IsIGBSZXBvcnQgY29sbGVjdGlvbiBmYWlsZWQ6ICR7bWVzc2FnZX1gXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIjsgXCIpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXN1bHQuZmluaXNoZWQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgfSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJ1blJlcG9ydGVkVGFyZ2V0KFxuICBydW46IFJ1blJlcG9ydCxcbiAgaWQ6IHN0cmluZyxcbiAgY292ZXJhZ2U6IHN0cmluZyxcbiAgYWN0aW9uOiAocmVwb3J0OiBzdHJpbmcpID0+IHZvaWQsXG4pOiB2b2lkIHtcbiAgY29uc3QgYXR0ZW1wdCA9IHRhcmdldFJlcG9ydGVyKHJ1biwgaWQsIGNvdmVyYWdlKTtcbiAgdHJ5IHtcbiAgICBhY3Rpb24oYXR0ZW1wdC5iZWdpbigpKTtcbiAgICBhdHRlbXB0LnBhc3MoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBhdHRlbXB0LmZhaWwoZXJyb3IpO1xuICB9IGZpbmFsbHkge1xuICAgIGF0dGVtcHQuZmluaXNoKCk7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1blJlcG9ydGVkVGFyZ2V0QXN5bmMoXG4gIHJ1bjogUnVuUmVwb3J0LFxuICBpZDogc3RyaW5nLFxuICBjb3ZlcmFnZTogc3RyaW5nLFxuICBhY3Rpb246IChyZXBvcnQ6IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhdHRlbXB0ID0gdGFyZ2V0UmVwb3J0ZXIocnVuLCBpZCwgY292ZXJhZ2UpO1xuICB0cnkge1xuICAgIGF3YWl0IGFjdGlvbihhdHRlbXB0LmJlZ2luKCkpO1xuICAgIGF0dGVtcHQucGFzcygpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGF0dGVtcHQuZmFpbChlcnJvcik7XG4gIH0gZmluYWxseSB7XG4gICAgYXR0ZW1wdC5maW5pc2goKTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcnVuU3VjY2VlZGVkKHJ1bjogUnVuUmVwb3J0KTogYm9vbGVhbiB7XG4gIHJldHVybiAhcnVuLmVycm9ycy5sZW5ndGggJiYgcnVuLnRhcmdldHMuZXZlcnkoKHRhcmdldCkgPT4gdGFyZ2V0LnN1Y2Nlc3MpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcnVuU3VtbWFyeShydW46IFJ1blJlcG9ydCwgcmVwb3J0czogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcGFzc2VkID0gcnVuLnRhcmdldHMuZmlsdGVyKCh0YXJnZXQpID0+IHRhcmdldC5zdWNjZXNzKS5sZW5ndGg7XG4gIHJldHVybiBgTG9jYWwgQ0k6ICR7U3RyaW5nKHBhc3NlZCl9LyR7U3RyaW5nKHJ1bi50YXJnZXRzLmxlbmd0aCl9IExpbnV4IHg2NCB0YXJnZXRzIHBhc3NlZDsgJHtTdHJpbmcocnVuLmVycm9ycy5sZW5ndGgpfSBpbmZyYXN0cnVjdHVyZSBlcnJvcnMuIFJlcG9ydHM6ICR7cmVwb3J0c31gO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxZQUFZLGNBQWM7QUFrQm5DLFNBQVMsV0FBVyxZQUFZLFFBQVEscUJBQXFCO0FBQzdELFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsWUFBWTtBQUNyQixTQUFTLGdCQUFnQixtQkFBbUI7QUFHckMsTUFBTSxlQUFlO0FBQ3JCLE1BQU0sa0JBQWtCLENBQUMsU0FBaUIsT0FDL0MsS0FBSyxTQUFTLFdBQVcsUUFBUSxFQUFFLE9BQU8sRUFBRSxFQUFFLE9BQU8sS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFLENBQUM7QUFFbkUsU0FBUyxnQkFBZ0IsS0FBZSxTQUE0QjtBQUN6RSxNQUFJLENBQUMsSUFBSSxVQUFVLElBQUksSUFBSSxHQUFHLEVBQUUsU0FBUyxJQUFJLE9BQVEsT0FBTSxJQUFJLE1BQU0sd0NBQXdDO0FBQzdHLFNBQU87QUFBQSxJQUNMLFNBQVM7QUFBQSxJQUNULFNBQVMsSUFBSSxJQUFJLENBQUMsUUFBUTtBQUFBLE1BQ3hCO0FBQUEsTUFDQSxTQUFTO0FBQUEsTUFDVCxPQUFPO0FBQUEsTUFDUCxRQUFRLGdCQUFnQixTQUFTLEVBQUU7QUFBQSxJQUNyQyxFQUFFO0FBQUEsSUFDRixRQUFRLENB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
