// Generated from check-coverage-summary.mts; edit the TypeScript source.
import { isMainScript } from "./script-entry.mjs";
import { emitCheckDetail } from "../app/src/core/execution/checks/check-detail-data.mjs";
import { clipped } from "../app/src/core/diagnostics/diagnostic-text.mjs";
import { record, records } from "../app/src/core/runtime/values.mjs";
import {
  coverageMetrics,
  coverageTotals,
  reportSummaryChange,
  readCoverageSummary as parseSummary
} from "../app/src/core/execution/checks/coverage-summary.mjs";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
function readCoverageSummary(root, repository = root, freshSince) {
  const canonical = (path) => {
    try {
      return realpathSync.native(path);
    } catch (error) {
      const parent = dirname(path);
      if (error.code !== "ENOENT" || parent === path) throw error;
      return join(canonical(parent), basename(path));
    }
  };
  root = canonical(resolve(root));
  repository = canonical(resolve(repository));
  const available = (path) => existsSync(path) && (freshSince === void 0 || statSync(path).mtimeMs >= freshSince);
  const source = (path) => {
    if (path.startsWith("/work/")) path = join(repository, path.slice(6));
    const normalized = relative(root, canonical(resolve(root, path)));
    if (normalized === ".." || normalized.startsWith(`..${sep}`))
      throw new Error(`coverage source outside root: ${path}`);
    return normalized.split(sep).join("/");
  };
  const metric = (covered, total) => ({ total, covered });
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
  } else if (available(vitest)) {
    const data = parseSummary(JSON.parse(readFileSync(vitest, "utf8")));
    for (const [path, value] of Object.entries(data)) summary[source(path)] = value;
  } else return void 0;
  if (!Object.values(coverageTotals(summary)).some((value) => value.total > 0))
    throw new Error("coverage summary has no measured code");
  return Object.fromEntries(
    Object.entries(summary).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  );
}
if (isMainScript(import.meta.url)) {
  const root = process.cwd();
  const repository = process.env.WORKBENCH_PROJECT_ROOT ?? root;
  const failed = Number(process.argv[2] ?? 0) !== 0;
  try {
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
      emitCheckDetail({
        version: 1,
        kind: "coverage-unavailable",
        root,
        reason: "the configured command produced no fresh supported coverage report."
      });
      console.log("Coverage change unavailable: the configured command produced no fresh supported coverage report.");
    }
  } catch (error) {
    emitCheckDetail({
      version: 1,
      kind: "coverage-unavailable",
      root,
      reason: `coverage summary failed: ${clipped(error instanceof Error ? error.message : "invalid coverage report", 2048).text}`
    });
    throw error;
  }
}
export {
  readCoverageSummary
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNoZWNrLWNvdmVyYWdlLXN1bW1hcnkubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGlzTWFpblNjcmlwdCB9IGZyb20gXCIuL3NjcmlwdC1lbnRyeS5tanNcIjtcbmltcG9ydCB7IGVtaXRDaGVja0RldGFpbCB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvZXhlY3V0aW9uL2NoZWNrcy9jaGVjay1kZXRhaWwtZGF0YS5tanNcIjtcbmltcG9ydCB7IGNsaXBwZWQgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2RpYWdub3N0aWNzL2RpYWdub3N0aWMtdGV4dC5tanNcIjtcbmltcG9ydCB7IHJlY29yZCwgcmVjb3JkcyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5pbXBvcnQge1xuICB0eXBlIFN1bW1hcnksXG4gIHR5cGUgRmlsZVN1bW1hcnksXG4gIGNvdmVyYWdlTWV0cmljcyxcbiAgY292ZXJhZ2VUb3RhbHMsXG4gIHJlcG9ydFN1bW1hcnlDaGFuZ2UsXG4gIHJlYWRDb3ZlcmFnZVN1bW1hcnkgYXMgcGFyc2VTdW1tYXJ5LFxufSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9jaGVja3MvY292ZXJhZ2Utc3VtbWFyeS5tanNcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCByZWFscGF0aFN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5leHBvcnQgZnVuY3Rpb24gcmVhZENvdmVyYWdlU3VtbWFyeShyb290OiBzdHJpbmcsIHJlcG9zaXRvcnkgPSByb290LCBmcmVzaFNpbmNlPzogbnVtYmVyKTogU3VtbWFyeSB8IHVuZGVmaW5lZCB7XG4gIC8vIFJlcG9ydHMgY2FuIHJldGFpbiBkZWxldGVkIHNvdXJjZSBlbnRyaWVzOyByZXNvbHZlIHRoZWlyIGV4aXN0aW5nIGFuY2VzdG9ycyBhcyB3ZWxsIGFzIGxpdmUgZmlsZXMuXG4gIGNvbnN0IGNhbm9uaWNhbCA9IChwYXRoOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gcmVhbHBhdGhTeW5jLm5hdGl2ZShwYXRoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgcGFyZW50ID0gZGlybmFtZShwYXRoKTtcbiAgICAgIGlmICgoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlICE9PSBcIkVOT0VOVFwiIHx8IHBhcmVudCA9PT0gcGF0aCkgdGhyb3cgZXJyb3I7XG4gICAgICByZXR1cm4gam9pbihjYW5vbmljYWwocGFyZW50KSwgYmFzZW5hbWUocGF0aCkpO1xuICAgIH1cbiAgfTtcbiAgcm9vdCA9IGNhbm9uaWNhbChyZXNvbHZlKHJvb3QpKTtcbiAgcmVwb3NpdG9yeSA9IGNhbm9uaWNhbChyZXNvbHZlKHJlcG9zaXRvcnkpKTtcbiAgY29uc3QgYXZhaWxhYmxlID0gKHBhdGg6IHN0cmluZykgPT5cbiAgICBleGlzdHNTeW5jKHBhdGgpICYmIChmcmVzaFNpbmNlID09PSB1bmRlZmluZWQgfHwgc3RhdFN5bmMocGF0aCkubXRpbWVNcyA+PSBmcmVzaFNpbmNlKTtcbiAgY29uc3Qgc291cmNlID0gKHBhdGg6IHN0cmluZykgPT4ge1xuICAgIGlmIChwYXRoLnN0YXJ0c1dpdGgoXCIvd29yay9cIikpIHBhdGggPSBqb2luKHJlcG9zaXRvcnksIHBhdGguc2xpY2UoNikpO1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSByZWxhdGl2ZShyb290LCBjYW5vbmljYWwocmVzb2x2ZShyb290LCBwYXRoKSkpO1xuICAgIGlmIChub3JtYWxpemVkID09PSBcIi4uXCIgfHwgbm9ybWFsaXplZC5zdGFydHNXaXRoKGAuLiR7c2VwfWApKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBjb3ZlcmFnZSBzb3VyY2Ugb3V0c2lkZSByb290OiAke3BhdGh9YCk7XG4gICAgcmV0dXJuIG5vcm1hbGl6ZWQuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcbiAgfTtcbiAgY29uc3QgbWV0cmljID0gKGNvdmVyZWQ6IG51bWJlciwgdG90YWw6IG51bWJlcikgPT4gKHsgdG90YWwsIGNvdmVyZWQgfSk7XG4gIGNvbnN0IHN1bW1hcnk6IFN1bW1hcnkgPSB7fTtcbiAgY29uc3QgcmF3ID0gam9pbihyb290LCBcImNvdmVyYWdlL3JlcG9ydC5qc29uXCIpO1xuICBjb25zdCBwcm9maWxlID0gam9pbihyb290LCBcImNvdmVyYWdlL3Byb2ZpbGUub3V0XCIpO1xuICBjb25zdCB2aXRlc3QgPSBqb2luKHJvb3QsIFwiY292ZXJhZ2UvY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpO1xuICBpZiAoYXZhaWxhYmxlKHJhdykpIHtcbiAgICBjb25zdCBkYXRhID0gcmVjb3JkKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHJhdywgXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIGNvdmVyYWdlIHJlcG9ydFwiKTtcbiAgICBjb25zdCBsbHZtID0gZGF0YS5kYXRhID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiByZWNvcmRzKGRhdGEuZGF0YSwgXCJJbnZhbGlkIExMVk0gcmVwb3J0c1wiKVswXTtcbiAgICBjb25zdCBjb3VudCA9ICh2YWx1ZTogdW5rbm93bik6IG51bWJlciA9PiB7XG4gICAgICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNGaW5pdGUodmFsdWUpIHx8IHZhbHVlIDwgMCkgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBjb3ZlcmFnZSBjb3VudFwiKTtcbiAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9O1xuICAgIGlmIChsbHZtPy50b3RhbHMpIHtcbiAgICAgIGNvbnN0IHZhbHVlcyA9IChyYXc6IHVua25vd24pOiBGaWxlU3VtbWFyeSA9PiB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVjb3JkKHJhdywgXCJJbnZhbGlkIExMVk0gY291bnRzXCIpO1xuICAgICAgICByZXR1cm4gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICAgIGNvdmVyYWdlTWV0cmljc1xuICAgICAgICAgICAgLmZpbHRlcigobmFtZSkgPT4gdmFsdWVbbmFtZV0pXG4gICAgICAgICAgICAubWFwKChuYW1lKSA9PiBbXG4gICAgICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgICAgIG1ldHJpYyhcbiAgICAgICAgICAgICAgICBjb3VudChyZWNvcmQodmFsdWVbbmFtZV0sIFwiQ292ZXJhZ2UgbWV0cmljXCIpLmNvdmVyZWQpLFxuICAgICAgICAgICAgICAgIGNvdW50KHJlY29yZCh2YWx1ZVtuYW1lXSwgXCJDb3ZlcmFnZSBtZXRyaWNcIikuY291bnQpLFxuICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgXSksXG4gICAgICAgICk7XG4gICAgICB9O1xuICAgICAgZm9yIChjb25zdCBmaWxlIG9mIHJlY29yZHMobGx2bS5maWxlcywgXCJJbnZhbGlkIExMVk0gZmlsZXNcIikpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBmaWxlLmZpbGVuYW1lICE9PSBcInN0cmluZ1wiKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIGNvdmVyYWdlIHBhdGhcIik7XG4gICAgICAgIHN1bW1hcnlbc291cmNlKGZpbGUuZmlsZW5hbWUpXSA9IHZhbHVlcyhmaWxlLnN1bW1hcnkpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoZGF0YS50b3RhbHMgJiYgZGF0YS5maWxlcykge1xuICAgICAgY29uc3QgdmFsdWVzID0gKHJhdzogdW5rbm93bik6IEZpbGVTdW1tYXJ5ID0+IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSByZWNvcmQocmF3LCBcIkludmFsaWQgUHl0aG9uIGNvdW50c1wiKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsaW5lczogbWV0cmljKGNvdW50KHZhbHVlLmNvdmVyZWRfbGluZXMpLCBjb3VudCh2YWx1ZS5udW1fc3RhdGVtZW50cykpLFxuICAgICAgICAgIGJyYW5jaGVzOiBtZXRyaWMoY291bnQodmFsdWUuY292ZXJlZF9icmFuY2hlcyksIGNvdW50KHZhbHVlLm51bV9icmFuY2hlcykpLFxuICAgICAgICB9O1xuICAgICAgfTtcbiAgICAgIGZvciAoY29uc3QgW3BhdGgsIGZpbGVdIG9mIE9iamVjdC5lbnRyaWVzKHJlY29yZChkYXRhLmZpbGVzLCBcIkludmFsaWQgUHl0aG9uIGZpbGVzXCIpKSlcbiAgICAgICAgc3VtbWFyeVtzb3VyY2UocGF0aCldID0gdmFsdWVzKHJlY29yZChmaWxlLCBcIkludmFsaWQgUHl0aG9uIGZpbGVcIikuc3VtbWFyeSk7XG4gICAgfSBlbHNlIHRocm93IG5ldyBFcnJvcihcInVuc3VwcG9ydGVkIGNvdmVyYWdlL3JlcG9ydC5qc29uIGZvcm1hdFwiKTtcbiAgfSBlbHNlIGlmIChhdmFpbGFibGUocHJvZmlsZSkpIHtcbiAgICBjb25zdCBtb2R1bGUgPSAvXm1vZHVsZVxccysoXFxTKykvbS5leGVjKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwiZ28ubW9kXCIpLCBcInV0ZjhcIikpPy5bMV07XG4gICAgaWYgKCFtb2R1bGUpIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIG5lZWRzIHRoZSBHbyBtb2R1bGUgcGF0aFwiKTtcbiAgICBjb25zdCBibG9ja3MgPSBuZXcgTWFwPHN0cmluZywgeyBwYXRoOiBzdHJpbmc7IHRvdGFsOiBudW1iZXI7IGNvdmVyZWQ6IGJvb2xlYW4gfCB1bmRlZmluZWQgfT4oKTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgcmVhZEZpbGVTeW5jKHByb2ZpbGUsIFwidXRmOFwiKS50cmltKCkuc3BsaXQoXCJcXG5cIikuc2xpY2UoMSkpIHtcbiAgICAgIGNvbnN0IG1hdGNoID0gL14oLiopOihcXGQrXFwuXFxkKyxcXGQrXFwuXFxkKykgKFxcZCspIChcXGQrKSQvLmV4ZWMobGluZSk7XG4gICAgICBpZiAoIW1hdGNoPy5bMV0/LnN0YXJ0c1dpdGgobW9kdWxlICsgXCIvXCIpKSB0aHJvdyBuZXcgRXJyb3IoYGludmFsaWQgR28gY292ZXJhZ2UgYmxvY2s6ICR7bGluZX1gKTtcbiAgICAgIGNvbnN0IGtleSA9IGAke21hdGNoWzFdfToke1N0cmluZyhtYXRjaFsyXSl9YDtcbiAgICAgIGJsb2Nrcy5zZXQoa2V5LCB7XG4gICAgICAgIHBhdGg6IHNvdXJjZShtYXRjaFsxXS5zbGljZShtb2R1bGUubGVuZ3RoICsgMSkpLFxuICAgICAgICB0b3RhbDogTnVtYmVyKG1hdGNoWzNdKSxcbiAgICAgICAgY292ZXJlZDogTnVtYmVyKG1hdGNoWzRdKSA+IDAgfHwgYmxvY2tzLmdldChrZXkpPy5jb3ZlcmVkLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzLnZhbHVlcygpKSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IHN1bW1hcnlbYmxvY2sucGF0aF0/LnN0YXRlbWVudHMgPz8gbWV0cmljKDAsIDApO1xuICAgICAgc3VtbWFyeVtibG9jay5wYXRoXSA9IHtcbiAgICAgICAgc3RhdGVtZW50czogbWV0cmljKHZhbHVlLmNvdmVyZWQgKyAoYmxvY2suY292ZXJlZCA/IGJsb2NrLnRvdGFsIDogMCksIHZhbHVlLnRvdGFsICsgYmxvY2sudG90YWwpLFxuICAgICAgfTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoYXZhaWxhYmxlKHZpdGVzdCkpIHtcbiAgICBjb25zdCBkYXRhID0gcGFyc2VTdW1tYXJ5KEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHZpdGVzdCwgXCJ1dGY4XCIpKSk7XG4gICAgZm9yIChjb25zdCBbcGF0aCwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGRhdGEpKSBzdW1tYXJ5W3NvdXJjZShwYXRoKV0gPSB2YWx1ZTtcbiAgfSBlbHNlIHJldHVybiB1bmRlZmluZWQ7XG4gIGlmICghT2JqZWN0LnZhbHVlcyhjb3ZlcmFnZVRvdGFscyhzdW1tYXJ5KSkuc29tZSgodmFsdWUpID0+IHZhbHVlLnRvdGFsID4gMCkpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiY292ZXJhZ2Ugc3VtbWFyeSBoYXMgbm8gbWVhc3VyZWQgY29kZVwiKTtcbiAgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBPYmplY3QuZW50cmllcyhzdW1tYXJ5KS5zb3J0KChbbGVmdF0sIFtyaWdodF0pID0+IChsZWZ0IDwgcmlnaHQgPyAtMSA6IGxlZnQgPiByaWdodCA/IDEgOiAwKSksXG4gICk7XG59XG5cbmlmIChpc01haW5TY3JpcHQoaW1wb3J0Lm1ldGEudXJsKSkge1xuICBjb25zdCByb290ID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgcmVwb3NpdG9yeSA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9QUk9KRUNUX1JPT1QgPz8gcm9vdDtcbiAgY29uc3QgZmFpbGVkID0gTnVtYmVyKHByb2Nlc3MuYXJndlsyXSA/PyAwKSAhPT0gMDtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdW1tYXJ5ID0gcmVhZENvdmVyYWdlU3VtbWFyeShyb290LCByZXBvc2l0b3J5LCBwcm9jZXNzLmFyZ3ZbM10gPyBOdW1iZXIocHJvY2Vzcy5hcmd2WzNdKSA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKHN1bW1hcnkpIHtcbiAgICAgIG1rZGlyU3luYyhqb2luKHJvb3QsIFwiY292ZXJhZ2VcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgcmVwb3J0U3VtbWFyeUNoYW5nZShzdW1tYXJ5LCByb290LCBqb2luKHJvb3QsIFwiY292ZXJhZ2UvY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpLCB7XG4gICAgICAgIHJlcG9zaXRvcnksXG4gICAgICAgIC4uLihwcm9jZXNzLmFyZ3YuaW5jbHVkZXMoXCItLW5vLWpvYi1zdW1tYXJ5XCIpID8geyBqb2JTdW1tYXJ5OiBcIlwiIH0gOiB7fSksXG4gICAgICAgIHdyaXRlU3VtbWFyeTogIWZhaWxlZCxcbiAgICAgICAgbm90aWNlOiBmYWlsZWQgPyBcIkNvdmVyYWdlIGNoZWNrcyBmYWlsZWQ7IHRoZXNlIHJlc3VsdHMgbWF5IGJlIHBhcnRpYWwuXCIgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgZW1pdENoZWNrRGV0YWlsKHtcbiAgICAgICAgdmVyc2lvbjogMSxcbiAgICAgICAga2luZDogXCJjb3ZlcmFnZS11bmF2YWlsYWJsZVwiLFxuICAgICAgICByb290LFxuICAgICAgICByZWFzb246IFwidGhlIGNvbmZpZ3VyZWQgY29tbWFuZCBwcm9kdWNlZCBubyBmcmVzaCBzdXBwb3J0ZWQgY292ZXJhZ2UgcmVwb3J0LlwiLFxuICAgICAgfSk7XG4gICAgICBjb25zb2xlLmxvZyhcIkNvdmVyYWdlIGNoYW5nZSB1bmF2YWlsYWJsZTogdGhlIGNvbmZpZ3VyZWQgY29tbWFuZCBwcm9kdWNlZCBubyBmcmVzaCBzdXBwb3J0ZWQgY292ZXJhZ2UgcmVwb3J0LlwiKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZW1pdENoZWNrRGV0YWlsKHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICBraW5kOiBcImNvdmVyYWdlLXVuYXZhaWxhYmxlXCIsXG4gICAgICByb290LFxuICAgICAgcmVhc29uOiBgY292ZXJhZ2Ugc3VtbWFyeSBmYWlsZWQ6ICR7Y2xpcHBlZChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiaW52YWxpZCBjb3ZlcmFnZSByZXBvcnRcIiwgMjA0OCkudGV4dH1gLFxuICAgIH0pO1xuICAgIHRocm93IGVycm9yO1xuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLGVBQWU7QUFDeEIsU0FBUyxRQUFRLGVBQWU7QUFDaEM7QUFBQSxFQUdFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBLHVCQUF1QjtBQUFBLE9BQ2xCO0FBQ1AsU0FBUyxZQUFZLFdBQVcsY0FBYyxjQUFjLGdCQUFnQjtBQUM1RSxT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UUFBSSxTQUFTO0FBQ1gsZ0JBQVUsS0FBSyxNQUFNLFVBQVUsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3JELDBCQUFvQixTQUFTLE1BQU0sS0FBSyxNQUFNLGdDQUFnQyxHQUFHO0FBQUEsUUFDL0U7QUFBQSxRQUNBLEdBQUksUUFBUSxLQUFLLFNBQVMsa0JBQWtCLElBQUksRUFBRSxZQUFZLEdBQUcsSUFBSSxDQUFDO0FBQUEsUUFDdEUsY0FBYyxDQUFDO0FBQUEsUUFDZixRQUFRLFNBQVMsMERBQTBEO0FBQUEsTUFDN0UsQ0FBQztBQUFBLElBQ0gsT0FBTztBQUNMLHNCQUFnQjtBQUFBLFFBQ2QsU0FBUztBQUFBLFFBQ1QsTUFBTTtBQUFBLFFBQ047QUFBQSxRQUNBLFFBQVE7QUFBQSxNQUNWLENBQUM7QUFDRCxjQUFRLElBQUksa0dBQWtHO0FBQUEsSUFDaEg7QUFBQSxFQUNGLFNBQVMsT0FBTztBQUNkLG9CQUFnQjtBQUFBLE1BQ2QsU0FBUztBQUFBLE1BQ1QsTUFBTTtBQUFBLE1BQ047QUFBQSxNQUNBLFFBQVEsNEJBQTRCLFFBQVEsaUJBQWlCLFFBQVEsTUFBTSxVQUFVLDJCQUEyQixJQUFJLEVBQUUsSUFBSTtBQUFBLElBQzVILENBQUM7QUFDRCxVQUFNO0FBQUEsRUFDUjtBQUNGOyIsIm5hbWVzIjpbInJhdyJdLCJmaWxlIjoic2NyaXB0cy9jaGVjay1jb3ZlcmFnZS1zdW1tYXJ5Lm1qcyJ9
