// Generated from check-coverage-summary.mts; edit the TypeScript source.
import { required, record, records } from "./values.mjs";
import {
  coverageMetrics,
  reportSummaryChange,
  readCoverageSummary as parseSummary
} from "./coverage-summary.mjs";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
function readCoverageSummary(root, repository = root, freshSince) {
  const available = (path) => existsSync(path) && (freshSince === void 0 || statSync(path).mtimeMs >= freshSince);
  const source = (path) => {
    if (path.startsWith("/work/")) path = join(repository, path.slice(6));
    const normalized = isAbsolute(path) ? relative(root, resolve(path)) : path;
    if (normalized === ".." || normalized.startsWith(`..${sep}`))
      throw new Error(`coverage source outside root: ${path}`);
    return normalized.split(sep).join("/");
  };
  const metric = (covered, total) => ({
    total,
    covered,
    skipped: 0,
    pct: total ? Math.floor(covered / total * 1e4) / 100 : 100
  });
  const summary = {};
  const raw = join(root, "coverage/report.json");
  const profile = join(root, "coverage/profile.out");
  const vitest = join(root, "coverage/coverage-summary.json");
  if (available(raw)) {
    const data = record(JSON.parse(readFileSync(raw, "utf8")), "Invalid coverage report");
    const llvm = data.data === void 0 ? void 0 : records(data.data, "Invalid LLVM reports")[0];
    const count = (value) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid coverage count");
      return value;
    };
    if (llvm?.totals) {
      const values = (raw2) => {
        const value = record(raw2, "Invalid LLVM counts");
        return Object.fromEntries(
          coverageMetrics.filter((name) => value[name]).map((name) => [
            name,
            metric(
              count(record(value[name], "Coverage metric").covered),
              count(record(value[name], "Coverage metric").count)
            )
          ])
        );
      };
      summary.total = values(llvm.totals);
      for (const file of records(llvm.files, "Invalid LLVM files")) {
        if (typeof file.filename !== "string") throw new Error("Invalid coverage path");
        summary[source(file.filename)] = values(file.summary);
      }
    } else if (data.totals && data.files) {
      const values = (raw2) => {
        const value = record(raw2, "Invalid Python counts");
        return {
          lines: metric(count(value.covered_lines), count(value.num_statements)),
          branches: metric(count(value.covered_branches), count(value.num_branches))
        };
      };
      summary.total = values(data.totals);
      for (const [path, file] of Object.entries(record(data.files, "Invalid Python files")))
        summary[source(path)] = values(record(file, "Invalid Python file").summary);
    } else throw new Error("unsupported coverage/report.json format");
  } else if (available(profile)) {
    const module = /^module\s+(\S+)/m.exec(readFileSync(join(root, "go.mod"), "utf8"))?.[1];
    if (!module) throw new Error("coverage needs the Go module path");
    const blocks = /* @__PURE__ */ new Map();
    for (const line of readFileSync(profile, "utf8").trim().split("\n").slice(1)) {
      const match = /^(.*):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(line);
      if (!match?.[1]?.startsWith(module + "/")) throw new Error(`invalid Go coverage block: ${line}`);
      const key = `${match[1]}:${String(match[2])}`;
      blocks.set(key, {
        path: source(match[1].slice(module.length + 1)),
        total: Number(match[3]),
        covered: Number(match[4]) > 0 || blocks.get(key)?.covered
      });
    }
    for (const block of blocks.values()) {
      const value = summary[block.path]?.statements ?? metric(0, 0);
      summary[block.path] = {
        statements: metric(value.covered + (block.covered ? block.total : 0), value.total + block.total)
      };
    }
    const values = Object.values(summary).map((file) => required(file.statements, "Missing Go statement coverage"));
    summary.total = {
      statements: metric(
        values.reduce((total, value) => total + value.covered, 0),
        values.reduce((total, value) => total + value.total, 0)
      )
    };
  } else if (available(vitest)) {
    const data = parseSummary(JSON.parse(readFileSync(vitest, "utf8")));
    for (const [path, value] of Object.entries(data))
      summary[path === "total" ? path : source(path)] = Object.fromEntries(
        coverageMetrics.filter((name) => value[name]).map((name) => [name, value[name]])
      );
  } else return void 0;
  if (!summary.total || !Object.values(summary.total).some((value) => value.total > 0))
    throw new Error("coverage summary has no measured code");
  return {
    total: summary.total,
    ...Object.fromEntries(
      Object.entries(summary).filter(([path]) => path !== "total").sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    )
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const repository = process.env.WORKBENCH_PROJECT_ROOT ?? root;
  const failed = Number(process.argv[2] ?? 0) !== 0;
  const summary = readCoverageSummary(root, repository, process.argv[3] ? Number(process.argv[3]) : void 0);
  if (summary) {
    mkdirSync(join(root, "coverage"), { recursive: true });
    reportSummaryChange(summary, root, join(root, "coverage/coverage-summary.json"), {
      repository,
      ...process.argv.includes("--no-job-summary") ? { jobSummary: "" } : {},
      writeSummary: !failed,
      notice: failed ? "Coverage checks failed; these results may be partial." : void 0
    });
  } else {
    const { emitCheckDetail } = await import("./check-detail-data.mjs");
    emitCheckDetail({
      version: 1,
      kind: "coverage-unavailable",
      root,
      reason: "the configured command produced no fresh supported coverage report."
    });
    console.log("Coverage change unavailable: the configured command produced no fresh supported coverage report.");
  }
}
export {
  readCoverageSummary
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNoZWNrLWNvdmVyYWdlLXN1bW1hcnkubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlcXVpcmVkLCByZWNvcmQsIHJlY29yZHMgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQge1xuICB0eXBlIFN1bW1hcnksXG4gIHR5cGUgRmlsZVN1bW1hcnksXG4gIGNvdmVyYWdlTWV0cmljcyxcbiAgcmVwb3J0U3VtbWFyeUNoYW5nZSxcbiAgcmVhZENvdmVyYWdlU3VtbWFyeSBhcyBwYXJzZVN1bW1hcnksXG59IGZyb20gXCIuL2NvdmVyYWdlLXN1bW1hcnkubWpzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaXNBYnNvbHV0ZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlYWRDb3ZlcmFnZVN1bW1hcnkocm9vdDogc3RyaW5nLCByZXBvc2l0b3J5ID0gcm9vdCwgZnJlc2hTaW5jZT86IG51bWJlcik6IFN1bW1hcnkgfCB1bmRlZmluZWQge1xuICBjb25zdCBhdmFpbGFibGUgPSAocGF0aDogc3RyaW5nKSA9PlxuICAgIGV4aXN0c1N5bmMocGF0aCkgJiYgKGZyZXNoU2luY2UgPT09IHVuZGVmaW5lZCB8fCBzdGF0U3luYyhwYXRoKS5tdGltZU1zID49IGZyZXNoU2luY2UpO1xuICBjb25zdCBzb3VyY2UgPSAocGF0aDogc3RyaW5nKSA9PiB7XG4gICAgaWYgKHBhdGguc3RhcnRzV2l0aChcIi93b3JrL1wiKSkgcGF0aCA9IGpvaW4ocmVwb3NpdG9yeSwgcGF0aC5zbGljZSg2KSk7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IGlzQWJzb2x1dGUocGF0aCkgPyByZWxhdGl2ZShyb290LCByZXNvbHZlKHBhdGgpKSA6IHBhdGg7XG4gICAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiLi5cIiB8fCBub3JtYWxpemVkLnN0YXJ0c1dpdGgoYC4uJHtzZXB9YCkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGNvdmVyYWdlIHNvdXJjZSBvdXRzaWRlIHJvb3Q6ICR7cGF0aH1gKTtcbiAgICByZXR1cm4gbm9ybWFsaXplZC5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuICB9O1xuICBjb25zdCBtZXRyaWMgPSAoY292ZXJlZDogbnVtYmVyLCB0b3RhbDogbnVtYmVyKSA9PiAoe1xuICAgIHRvdGFsLFxuICAgIGNvdmVyZWQsXG4gICAgc2tpcHBlZDogMCxcbiAgICBwY3Q6IHRvdGFsID8gTWF0aC5mbG9vcigoY292ZXJlZCAvIHRvdGFsKSAqIDEwMDAwKSAvIDEwMCA6IDEwMCxcbiAgfSk7XG4gIGNvbnN0IHN1bW1hcnk6IFN1bW1hcnkgPSB7fTtcbiAgY29uc3QgcmF3ID0gam9pbihyb290LCBcImNvdmVyYWdlL3JlcG9ydC5qc29uXCIpO1xuICBjb25zdCBwcm9maWxlID0gam9pbihyb290LCBcImNvdmVyYWdlL3Byb2ZpbGUub3V0XCIpO1xuICBjb25zdCB2aXRlc3QgPSBqb2luKHJvb3QsIFwiY292ZXJhZ2UvY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpO1xuICBpZiAoYXZhaWxhYmxlKHJhdykpIHtcbiAgICBjb25zdCBkYXRhID0gcmVjb3JkKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHJhdywgXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIGNvdmVyYWdlIHJlcG9ydFwiKTtcbiAgICBjb25zdCBsbHZtID0gZGF0YS5kYXRhID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiByZWNvcmRzKGRhdGEuZGF0YSwgXCJJbnZhbGlkIExMVk0gcmVwb3J0c1wiKVswXTtcbiAgICBjb25zdCBjb3VudCA9ICh2YWx1ZTogdW5rbm93bik6IG51bWJlciA9PiB7XG4gICAgICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNGaW5pdGUodmFsdWUpIHx8IHZhbHVlIDwgMCkgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBjb3ZlcmFnZSBjb3VudFwiKTtcbiAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9O1xuICAgIGlmIChsbHZtPy50b3RhbHMpIHtcbiAgICAgIGNvbnN0IHZhbHVlcyA9IChyYXc6IHVua25vd24pOiBGaWxlU3VtbWFyeSA9PiB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVjb3JkKHJhdywgXCJJbnZhbGlkIExMVk0gY291bnRzXCIpO1xuICAgICAgICByZXR1cm4gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICAgIGNvdmVyYWdlTWV0cmljc1xuICAgICAgICAgICAgLmZpbHRlcigobmFtZSkgPT4gdmFsdWVbbmFtZV0pXG4gICAgICAgICAgICAubWFwKChuYW1lKSA9PiBbXG4gICAgICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgICAgIG1ldHJpYyhcbiAgICAgICAgICAgICAgICBjb3VudChyZWNvcmQodmFsdWVbbmFtZV0sIFwiQ292ZXJhZ2UgbWV0cmljXCIpLmNvdmVyZWQpLFxuICAgICAgICAgICAgICAgIGNvdW50KHJlY29yZCh2YWx1ZVtuYW1lXSwgXCJDb3ZlcmFnZSBtZXRyaWNcIikuY291bnQpLFxuICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgXSksXG4gICAgICAgICk7XG4gICAgICB9O1xuICAgICAgc3VtbWFyeS50b3RhbCA9IHZhbHVlcyhsbHZtLnRvdGFscyk7XG4gICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgcmVjb3JkcyhsbHZtLmZpbGVzLCBcIkludmFsaWQgTExWTSBmaWxlc1wiKSkge1xuICAgICAgICBpZiAodHlwZW9mIGZpbGUuZmlsZW5hbWUgIT09IFwic3RyaW5nXCIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgY292ZXJhZ2UgcGF0aFwiKTtcbiAgICAgICAgc3VtbWFyeVtzb3VyY2UoZmlsZS5maWxlbmFtZSldID0gdmFsdWVzKGZpbGUuc3VtbWFyeSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChkYXRhLnRvdGFscyAmJiBkYXRhLmZpbGVzKSB7XG4gICAgICBjb25zdCB2YWx1ZXMgPSAocmF3OiB1bmtub3duKTogRmlsZVN1bW1hcnkgPT4ge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IHJlY29yZChyYXcsIFwiSW52YWxpZCBQeXRob24gY291bnRzXCIpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGxpbmVzOiBtZXRyaWMoY291bnQodmFsdWUuY292ZXJlZF9saW5lcyksIGNvdW50KHZhbHVlLm51bV9zdGF0ZW1lbnRzKSksXG4gICAgICAgICAgYnJhbmNoZXM6IG1ldHJpYyhjb3VudCh2YWx1ZS5jb3ZlcmVkX2JyYW5jaGVzKSwgY291bnQodmFsdWUubnVtX2JyYW5jaGVzKSksXG4gICAgICAgIH07XG4gICAgICB9O1xuICAgICAgc3VtbWFyeS50b3RhbCA9IHZhbHVlcyhkYXRhLnRvdGFscyk7XG4gICAgICBmb3IgKGNvbnN0IFtwYXRoLCBmaWxlXSBvZiBPYmplY3QuZW50cmllcyhyZWNvcmQoZGF0YS5maWxlcywgXCJJbnZhbGlkIFB5dGhvbiBmaWxlc1wiKSkpXG4gICAgICAgIHN1bW1hcnlbc291cmNlKHBhdGgpXSA9IHZhbHVlcyhyZWNvcmQoZmlsZSwgXCJJbnZhbGlkIFB5dGhvbiBmaWxlXCIpLnN1bW1hcnkpO1xuICAgIH0gZWxzZSB0aHJvdyBuZXcgRXJyb3IoXCJ1bnN1cHBvcnRlZCBjb3ZlcmFnZS9yZXBvcnQuanNvbiBmb3JtYXRcIik7XG4gIH0gZWxzZSBpZiAoYXZhaWxhYmxlKHByb2ZpbGUpKSB7XG4gICAgY29uc3QgbW9kdWxlID0gL15tb2R1bGVcXHMrKFxcUyspL20uZXhlYyhyZWFkRmlsZVN5bmMoam9pbihyb290LCBcImdvLm1vZFwiKSwgXCJ1dGY4XCIpKT8uWzFdO1xuICAgIGlmICghbW9kdWxlKSB0aHJvdyBuZXcgRXJyb3IoXCJjb3ZlcmFnZSBuZWVkcyB0aGUgR28gbW9kdWxlIHBhdGhcIik7XG4gICAgY29uc3QgYmxvY2tzID0gbmV3IE1hcDxzdHJpbmcsIHsgcGF0aDogc3RyaW5nOyB0b3RhbDogbnVtYmVyOyBjb3ZlcmVkOiBib29sZWFuIHwgdW5kZWZpbmVkIH0+KCk7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIHJlYWRGaWxlU3luYyhwcm9maWxlLCBcInV0ZjhcIikudHJpbSgpLnNwbGl0KFwiXFxuXCIpLnNsaWNlKDEpKSB7XG4gICAgICBjb25zdCBtYXRjaCA9IC9eKC4qKTooXFxkK1xcLlxcZCssXFxkK1xcLlxcZCspIChcXGQrKSAoXFxkKykkLy5leGVjKGxpbmUpO1xuICAgICAgaWYgKCFtYXRjaD8uWzFdPy5zdGFydHNXaXRoKG1vZHVsZSArIFwiL1wiKSkgdGhyb3cgbmV3IEVycm9yKGBpbnZhbGlkIEdvIGNvdmVyYWdlIGJsb2NrOiAke2xpbmV9YCk7XG4gICAgICBjb25zdCBrZXkgPSBgJHttYXRjaFsxXX06JHtTdHJpbmcobWF0Y2hbMl0pfWA7XG4gICAgICBibG9ja3Muc2V0KGtleSwge1xuICAgICAgICBwYXRoOiBzb3VyY2UobWF0Y2hbMV0uc2xpY2UobW9kdWxlLmxlbmd0aCArIDEpKSxcbiAgICAgICAgdG90YWw6IE51bWJlcihtYXRjaFszXSksXG4gICAgICAgIGNvdmVyZWQ6IE51bWJlcihtYXRjaFs0XSkgPiAwIHx8IGJsb2Nrcy5nZXQoa2V5KT8uY292ZXJlZCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGJsb2NrIG9mIGJsb2Nrcy52YWx1ZXMoKSkge1xuICAgICAgY29uc3QgdmFsdWUgPSBzdW1tYXJ5W2Jsb2NrLnBhdGhdPy5zdGF0ZW1lbnRzID8/IG1ldHJpYygwLCAwKTtcbiAgICAgIHN1bW1hcnlbYmxvY2sucGF0aF0gPSB7XG4gICAgICAgIHN0YXRlbWVudHM6IG1ldHJpYyh2YWx1ZS5jb3ZlcmVkICsgKGJsb2NrLmNvdmVyZWQgPyBibG9jay50b3RhbCA6IDApLCB2YWx1ZS50b3RhbCArIGJsb2NrLnRvdGFsKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNvbnN0IHZhbHVlcyA9IE9iamVjdC52YWx1ZXMoc3VtbWFyeSkubWFwKChmaWxlKSA9PiByZXF1aXJlZChmaWxlLnN0YXRlbWVudHMsIFwiTWlzc2luZyBHbyBzdGF0ZW1lbnQgY292ZXJhZ2VcIikpO1xuICAgIHN1bW1hcnkudG90YWwgPSB7XG4gICAgICBzdGF0ZW1lbnRzOiBtZXRyaWMoXG4gICAgICAgIHZhbHVlcy5yZWR1Y2UoKHRvdGFsLCB2YWx1ZSkgPT4gdG90YWwgKyB2YWx1ZS5jb3ZlcmVkLCAwKSxcbiAgICAgICAgdmFsdWVzLnJlZHVjZSgodG90YWwsIHZhbHVlKSA9PiB0b3RhbCArIHZhbHVlLnRvdGFsLCAwKSxcbiAgICAgICksXG4gICAgfTtcbiAgfSBlbHNlIGlmIChhdmFpbGFibGUodml0ZXN0KSkge1xuICAgIGNvbnN0IGRhdGEgPSBwYXJzZVN1bW1hcnkoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmModml0ZXN0LCBcInV0ZjhcIikpKTtcbiAgICBmb3IgKGNvbnN0IFtwYXRoLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoZGF0YSkpXG4gICAgICBzdW1tYXJ5W3BhdGggPT09IFwidG90YWxcIiA/IHBhdGggOiBzb3VyY2UocGF0aCldID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICBjb3ZlcmFnZU1ldHJpY3MuZmlsdGVyKChuYW1lKSA9PiB2YWx1ZVtuYW1lXSkubWFwKChuYW1lKSA9PiBbbmFtZSwgdmFsdWVbbmFtZV1dKSxcbiAgICAgICk7XG4gIH0gZWxzZSByZXR1cm4gdW5kZWZpbmVkO1xuICBpZiAoIXN1bW1hcnkudG90YWwgfHwgIU9iamVjdC52YWx1ZXMoc3VtbWFyeS50b3RhbCkuc29tZSgodmFsdWUpID0+IHZhbHVlLnRvdGFsID4gMCkpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiY292ZXJhZ2Ugc3VtbWFyeSBoYXMgbm8gbWVhc3VyZWQgY29kZVwiKTtcbiAgcmV0dXJuIHtcbiAgICB0b3RhbDogc3VtbWFyeS50b3RhbCxcbiAgICAuLi5PYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBPYmplY3QuZW50cmllcyhzdW1tYXJ5KVxuICAgICAgICAuZmlsdGVyKChbcGF0aF0pID0+IHBhdGggIT09IFwidG90YWxcIilcbiAgICAgICAgLnNvcnQoKFtsZWZ0XSwgW3JpZ2h0XSkgPT4gKGxlZnQgPCByaWdodCA/IC0xIDogbGVmdCA+IHJpZ2h0ID8gMSA6IDApKSxcbiAgICApLFxuICB9O1xufVxuXG5pZiAocHJvY2Vzcy5hcmd2WzFdICYmIHJlc29sdmUocHJvY2Vzcy5hcmd2WzFdKSA9PT0gZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKSB7XG4gIGNvbnN0IHJvb3QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCByZXBvc2l0b3J5ID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX1BST0pFQ1RfUk9PVCA/PyByb290O1xuICBjb25zdCBmYWlsZWQgPSBOdW1iZXIocHJvY2Vzcy5hcmd2WzJdID8/IDApICE9PSAwO1xuICBjb25zdCBzdW1tYXJ5ID0gcmVhZENvdmVyYWdlU3VtbWFyeShyb290LCByZXBvc2l0b3J5LCBwcm9jZXNzLmFyZ3ZbM10gPyBOdW1iZXIocHJvY2Vzcy5hcmd2WzNdKSA6IHVuZGVmaW5lZCk7XG4gIGlmIChzdW1tYXJ5KSB7XG4gICAgbWtkaXJTeW5jKGpvaW4ocm9vdCwgXCJjb3ZlcmFnZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgcmVwb3J0U3VtbWFyeUNoYW5nZShzdW1tYXJ5LCByb290LCBqb2luKHJvb3QsIFwiY292ZXJhZ2UvY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpLCB7XG4gICAgICByZXBvc2l0b3J5LFxuICAgICAgLi4uKHByb2Nlc3MuYXJndi5pbmNsdWRlcyhcIi0tbm8tam9iLXN1bW1hcnlcIikgPyB7IGpvYlN1bW1hcnk6IFwiXCIgfSA6IHt9KSxcbiAgICAgIHdyaXRlU3VtbWFyeTogIWZhaWxlZCxcbiAgICAgIG5vdGljZTogZmFpbGVkID8gXCJDb3ZlcmFnZSBjaGVja3MgZmFpbGVkOyB0aGVzZSByZXN1bHRzIG1heSBiZSBwYXJ0aWFsLlwiIDogdW5kZWZpbmVkLFxuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IHsgZW1pdENoZWNrRGV0YWlsIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2NoZWNrLWRldGFpbC1kYXRhLm1qc1wiKTtcbiAgICBlbWl0Q2hlY2tEZXRhaWwoe1xuICAgICAgdmVyc2lvbjogMSxcbiAgICAgIGtpbmQ6IFwiY292ZXJhZ2UtdW5hdmFpbGFibGVcIixcbiAgICAgIHJvb3QsXG4gICAgICByZWFzb246IFwidGhlIGNvbmZpZ3VyZWQgY29tbWFuZCBwcm9kdWNlZCBubyBmcmVzaCBzdXBwb3J0ZWQgY292ZXJhZ2UgcmVwb3J0LlwiLFxuICAgIH0pO1xuICAgIGNvbnNvbGUubG9nKFwiQ292ZXJhZ2UgY2hhbmdlIHVuYXZhaWxhYmxlOiB0aGUgY29uZmlndXJlZCBjb21tYW5kIHByb2R1Y2VkIG5vIGZyZXNoIHN1cHBvcnRlZCBjb3ZlcmFnZSByZXBvcnQuXCIpO1xuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFVBQVUsUUFBUSxlQUFlO0FBQzFDO0FBQUEsRUFHRTtBQUFBLEVBQ0E7QUFBQSxFQUNBLHVCQUF1QjtBQUFBLE9BQ2xCO0FBQ1AsU0FBUyxZQUFZLFdBQVcsY0FBYyxnQkFBZ0I7QUFDOUQsU0FBUyxZQUFZLE1BQU0sVUFBVSxTQUFTLFdBQVc7QUFDekQsU0FBUyxxQkFBcUI7QUFFdkIsU0FBUyxvQkFBb0IsTUFBYyxhQUFhLE1BQU0sWUFBMEM7QUFDN0csUUFBTSxZQUFZLENBQUMsU0FDakIsV0FBVyxJQUFJLE1BQU0sZUFBZSxVQUFhLFNBQVMsSUFBSSxFQUFFLFdBQVc7QUFDN0UsUUFBTSxTQUFTLENBQUMsU0FBaUI7QUFDL0IsUUFBSSxLQUFLLFdBQVcsUUFBUSxFQUFHLFFBQU8sS0FBSyxZQUFZLEtBQUssTUFBTSxDQUFDLENBQUM7QUFDcEUsVUFB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QUFTLE9BQU8sUUFBUSxLQUFLLENBQUMsS0FBSyxDQUFDLE1BQU07QUFDaEQsUUFBTSxVQUFVLG9CQUFvQixNQUFNLFlBQVksUUFBUSxLQUFLLENBQUMsSUFBSSxPQUFPLFFBQVEsS0FBSyxDQUFDLENBQUMsSUFBSSxNQUFTO0FBQzNHLE1BQUksU0FBUztBQUNYLGNBQVUsS0FBSyxNQUFNLFVBQVUsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3JELHdCQUFvQixTQUFTLE1BQU0sS0FBSyxNQUFNLGdDQUFnQyxHQUFHO0FBQUEsTUFDL0U7QUFBQSxNQUNBLEdBQUksUUFBUSxLQUFLLFNBQVMsa0JBQWtCLElBQUksRUFBRSxZQUFZLEdBQUcsSUFBSSxDQUFDO0FBQUEsTUFDdEUsY0FBYyxDQUFDO0FBQUEsTUFDZixRQUFRLFNBQVMsMERBQTBEO0FBQUEsSUFDN0UsQ0FBQztBQUFBLEVBQ0gsT0FBTztBQUNMLFVBQU0sRUFBRSxnQkFBZ0IsSUFBSSxNQUFNLE9BQU8seUJBQXlCO0FBQ2xFLG9CQUFnQjtBQUFBLE1BQ2QsU0FBUztBQUFBLE1BQ1QsTUFBTTtBQUFBLE1BQ047QUFBQSxNQUNBLFFBQVE7QUFBQSxJQUNWLENBQUM7QUFDRCxZQUFRLElBQUksa0dBQWtHO0FBQUEsRUFDaEg7QUFDRjsiLCJuYW1lcyI6WyJyYXciXSwiZmlsZSI6InNjcmlwdHMvY2hlY2stY292ZXJhZ2Utc3VtbWFyeS5tanMifQ==
