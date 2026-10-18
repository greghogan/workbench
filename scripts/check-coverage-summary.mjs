// Generated from check-coverage-summary.mts; edit the TypeScript source.
import { required, record, records } from "./values.mjs";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageMetrics, reportSummaryChange, readCoverageSummary as parseSummary } from "./coverage-summary.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNoZWNrLWNvdmVyYWdlLXN1bW1hcnkubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlcXVpcmVkLCByZWNvcmQsIHJlY29yZHMgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgdHlwZSB7IFN1bW1hcnksIEZpbGVTdW1tYXJ5IH0gZnJvbSBcIi4vY292ZXJhZ2Utc3VtbWFyeS5tanNcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgY292ZXJhZ2VNZXRyaWNzLCByZXBvcnRTdW1tYXJ5Q2hhbmdlLCByZWFkQ292ZXJhZ2VTdW1tYXJ5IGFzIHBhcnNlU3VtbWFyeSB9IGZyb20gXCIuL2NvdmVyYWdlLXN1bW1hcnkubWpzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiByZWFkQ292ZXJhZ2VTdW1tYXJ5KHJvb3Q6IHN0cmluZywgcmVwb3NpdG9yeSA9IHJvb3QsIGZyZXNoU2luY2U/OiBudW1iZXIpOiBTdW1tYXJ5IHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgYXZhaWxhYmxlID0gKHBhdGg6IHN0cmluZykgPT5cbiAgICBleGlzdHNTeW5jKHBhdGgpICYmIChmcmVzaFNpbmNlID09PSB1bmRlZmluZWQgfHwgc3RhdFN5bmMocGF0aCkubXRpbWVNcyA+PSBmcmVzaFNpbmNlKTtcbiAgY29uc3Qgc291cmNlID0gKHBhdGg6IHN0cmluZykgPT4ge1xuICAgIGlmIChwYXRoLnN0YXJ0c1dpdGgoXCIvd29yay9cIikpIHBhdGggPSBqb2luKHJlcG9zaXRvcnksIHBhdGguc2xpY2UoNikpO1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBpc0Fic29sdXRlKHBhdGgpID8gcmVsYXRpdmUocm9vdCwgcmVzb2x2ZShwYXRoKSkgOiBwYXRoO1xuICAgIGlmIChub3JtYWxpemVkID09PSBcIi4uXCIgfHwgbm9ybWFsaXplZC5zdGFydHNXaXRoKGAuLiR7c2VwfWApKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBjb3ZlcmFnZSBzb3VyY2Ugb3V0c2lkZSByb290OiAke3BhdGh9YCk7XG4gICAgcmV0dXJuIG5vcm1hbGl6ZWQuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcbiAgfTtcbiAgY29uc3QgbWV0cmljID0gKGNvdmVyZWQ6IG51bWJlciwgdG90YWw6IG51bWJlcikgPT4gKHtcbiAgICB0b3RhbCxcbiAgICBjb3ZlcmVkLFxuICAgIHNraXBwZWQ6IDAsXG4gICAgcGN0OiB0b3RhbCA/IE1hdGguZmxvb3IoKGNvdmVyZWQgLyB0b3RhbCkgKiAxMDAwMCkgLyAxMDAgOiAxMDAsXG4gIH0pO1xuICBjb25zdCBzdW1tYXJ5OiBTdW1tYXJ5ID0ge307XG4gIGNvbnN0IHJhdyA9IGpvaW4ocm9vdCwgXCJjb3ZlcmFnZS9yZXBvcnQuanNvblwiKTtcbiAgY29uc3QgcHJvZmlsZSA9IGpvaW4ocm9vdCwgXCJjb3ZlcmFnZS9wcm9maWxlLm91dFwiKTtcbiAgY29uc3Qgdml0ZXN0ID0gam9pbihyb290LCBcImNvdmVyYWdlL2NvdmVyYWdlLXN1bW1hcnkuanNvblwiKTtcbiAgaWYgKGF2YWlsYWJsZShyYXcpKSB7XG4gICAgY29uc3QgZGF0YSA9IHJlY29yZChKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhyYXcsIFwidXRmOFwiKSksIFwiSW52YWxpZCBjb3ZlcmFnZSByZXBvcnRcIik7XG4gICAgY29uc3QgbGx2bSA9IGRhdGEuZGF0YSA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogcmVjb3JkcyhkYXRhLmRhdGEsIFwiSW52YWxpZCBMTFZNIHJlcG9ydHNcIilbMF07XG4gICAgY29uc3QgY291bnQgPSAodmFsdWU6IHVua25vd24pOiBudW1iZXIgPT4ge1xuICAgICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJudW1iZXJcIiB8fCAhTnVtYmVyLmlzRmluaXRlKHZhbHVlKSB8fCB2YWx1ZSA8IDApIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgY292ZXJhZ2UgY291bnRcIik7XG4gICAgICByZXR1cm4gdmFsdWU7XG4gICAgfTtcbiAgICBpZiAobGx2bT8udG90YWxzKSB7XG4gICAgICBjb25zdCB2YWx1ZXMgPSAocmF3OiB1bmtub3duKTogRmlsZVN1bW1hcnkgPT4ge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IHJlY29yZChyYXcsIFwiSW52YWxpZCBMTFZNIGNvdW50c1wiKTtcbiAgICAgICAgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgICBjb3ZlcmFnZU1ldHJpY3NcbiAgICAgICAgICAgIC5maWx0ZXIoKG5hbWUpID0+IHZhbHVlW25hbWVdKVxuICAgICAgICAgICAgLm1hcCgobmFtZSkgPT4gW1xuICAgICAgICAgICAgICBuYW1lLFxuICAgICAgICAgICAgICBtZXRyaWMoXG4gICAgICAgICAgICAgICAgY291bnQocmVjb3JkKHZhbHVlW25hbWVdLCBcIkNvdmVyYWdlIG1ldHJpY1wiKS5jb3ZlcmVkKSxcbiAgICAgICAgICAgICAgICBjb3VudChyZWNvcmQodmFsdWVbbmFtZV0sIFwiQ292ZXJhZ2UgbWV0cmljXCIpLmNvdW50KSxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIF0pLFxuICAgICAgICApO1xuICAgICAgfTtcbiAgICAgIHN1bW1hcnkudG90YWwgPSB2YWx1ZXMobGx2bS50b3RhbHMpO1xuICAgICAgZm9yIChjb25zdCBmaWxlIG9mIHJlY29yZHMobGx2bS5maWxlcywgXCJJbnZhbGlkIExMVk0gZmlsZXNcIikpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBmaWxlLmZpbGVuYW1lICE9PSBcInN0cmluZ1wiKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIGNvdmVyYWdlIHBhdGhcIik7XG4gICAgICAgIHN1bW1hcnlbc291cmNlKGZpbGUuZmlsZW5hbWUpXSA9IHZhbHVlcyhmaWxlLnN1bW1hcnkpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoZGF0YS50b3RhbHMgJiYgZGF0YS5maWxlcykge1xuICAgICAgY29uc3QgdmFsdWVzID0gKHJhdzogdW5rbm93bik6IEZpbGVTdW1tYXJ5ID0+IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSByZWNvcmQocmF3LCBcIkludmFsaWQgUHl0aG9uIGNvdW50c1wiKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBsaW5lczogbWV0cmljKGNvdW50KHZhbHVlLmNvdmVyZWRfbGluZXMpLCBjb3VudCh2YWx1ZS5udW1fc3RhdGVtZW50cykpLFxuICAgICAgICAgIGJyYW5jaGVzOiBtZXRyaWMoY291bnQodmFsdWUuY292ZXJlZF9icmFuY2hlcyksIGNvdW50KHZhbHVlLm51bV9icmFuY2hlcykpLFxuICAgICAgICB9O1xuICAgICAgfTtcbiAgICAgIHN1bW1hcnkudG90YWwgPSB2YWx1ZXMoZGF0YS50b3RhbHMpO1xuICAgICAgZm9yIChjb25zdCBbcGF0aCwgZmlsZV0gb2YgT2JqZWN0LmVudHJpZXMocmVjb3JkKGRhdGEuZmlsZXMsIFwiSW52YWxpZCBQeXRob24gZmlsZXNcIikpKVxuICAgICAgICBzdW1tYXJ5W3NvdXJjZShwYXRoKV0gPSB2YWx1ZXMocmVjb3JkKGZpbGUsIFwiSW52YWxpZCBQeXRob24gZmlsZVwiKS5zdW1tYXJ5KTtcbiAgICB9IGVsc2UgdGhyb3cgbmV3IEVycm9yKFwidW5zdXBwb3J0ZWQgY292ZXJhZ2UvcmVwb3J0Lmpzb24gZm9ybWF0XCIpO1xuICB9IGVsc2UgaWYgKGF2YWlsYWJsZShwcm9maWxlKSkge1xuICAgIGNvbnN0IG1vZHVsZSA9IC9ebW9kdWxlXFxzKyhcXFMrKS9tLmV4ZWMocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJnby5tb2RcIiksIFwidXRmOFwiKSk/LlsxXTtcbiAgICBpZiAoIW1vZHVsZSkgdGhyb3cgbmV3IEVycm9yKFwiY292ZXJhZ2UgbmVlZHMgdGhlIEdvIG1vZHVsZSBwYXRoXCIpO1xuICAgIGNvbnN0IGJsb2NrcyA9IG5ldyBNYXA8c3RyaW5nLCB7IHBhdGg6IHN0cmluZzsgdG90YWw6IG51bWJlcjsgY292ZXJlZDogYm9vbGVhbiB8IHVuZGVmaW5lZCB9PigpO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiByZWFkRmlsZVN5bmMocHJvZmlsZSwgXCJ1dGY4XCIpLnRyaW0oKS5zcGxpdChcIlxcblwiKS5zbGljZSgxKSkge1xuICAgICAgY29uc3QgbWF0Y2ggPSAvXiguKik6KFxcZCtcXC5cXGQrLFxcZCtcXC5cXGQrKSAoXFxkKykgKFxcZCspJC8uZXhlYyhsaW5lKTtcbiAgICAgIGlmICghbWF0Y2g/LlsxXT8uc3RhcnRzV2l0aChtb2R1bGUgKyBcIi9cIikpIHRocm93IG5ldyBFcnJvcihgaW52YWxpZCBHbyBjb3ZlcmFnZSBibG9jazogJHtsaW5lfWApO1xuICAgICAgY29uc3Qga2V5ID0gYCR7bWF0Y2hbMV19OiR7U3RyaW5nKG1hdGNoWzJdKX1gO1xuICAgICAgYmxvY2tzLnNldChrZXksIHtcbiAgICAgICAgcGF0aDogc291cmNlKG1hdGNoWzFdLnNsaWNlKG1vZHVsZS5sZW5ndGggKyAxKSksXG4gICAgICAgIHRvdGFsOiBOdW1iZXIobWF0Y2hbM10pLFxuICAgICAgICBjb3ZlcmVkOiBOdW1iZXIobWF0Y2hbNF0pID4gMCB8fCBibG9ja3MuZ2V0KGtleSk/LmNvdmVyZWQsXG4gICAgICB9KTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBibG9jayBvZiBibG9ja3MudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IHZhbHVlID0gc3VtbWFyeVtibG9jay5wYXRoXT8uc3RhdGVtZW50cyA/PyBtZXRyaWMoMCwgMCk7XG4gICAgICBzdW1tYXJ5W2Jsb2NrLnBhdGhdID0ge1xuICAgICAgICBzdGF0ZW1lbnRzOiBtZXRyaWModmFsdWUuY292ZXJlZCArIChibG9jay5jb3ZlcmVkID8gYmxvY2sudG90YWwgOiAwKSwgdmFsdWUudG90YWwgKyBibG9jay50b3RhbCksXG4gICAgICB9O1xuICAgIH1cbiAgICBjb25zdCB2YWx1ZXMgPSBPYmplY3QudmFsdWVzKHN1bW1hcnkpLm1hcCgoZmlsZSkgPT4gcmVxdWlyZWQoZmlsZS5zdGF0ZW1lbnRzLCBcIk1pc3NpbmcgR28gc3RhdGVtZW50IGNvdmVyYWdlXCIpKTtcbiAgICBzdW1tYXJ5LnRvdGFsID0ge1xuICAgICAgc3RhdGVtZW50czogbWV0cmljKFxuICAgICAgICB2YWx1ZXMucmVkdWNlKCh0b3RhbCwgdmFsdWUpID0+IHRvdGFsICsgdmFsdWUuY292ZXJlZCwgMCksXG4gICAgICAgIHZhbHVlcy5yZWR1Y2UoKHRvdGFsLCB2YWx1ZSkgPT4gdG90YWwgKyB2YWx1ZS50b3RhbCwgMCksXG4gICAgICApLFxuICAgIH07XG4gIH0gZWxzZSBpZiAoYXZhaWxhYmxlKHZpdGVzdCkpIHtcbiAgICBjb25zdCBkYXRhID0gcGFyc2VTdW1tYXJ5KEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHZpdGVzdCwgXCJ1dGY4XCIpKSk7XG4gICAgZm9yIChjb25zdCBbcGF0aCwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGRhdGEpKVxuICAgICAgc3VtbWFyeVtwYXRoID09PSBcInRvdGFsXCIgPyBwYXRoIDogc291cmNlKHBhdGgpXSA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgY292ZXJhZ2VNZXRyaWNzLmZpbHRlcigobmFtZSkgPT4gdmFsdWVbbmFtZV0pLm1hcCgobmFtZSkgPT4gW25hbWUsIHZhbHVlW25hbWVdXSksXG4gICAgICApO1xuICB9IGVsc2UgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKCFzdW1tYXJ5LnRvdGFsIHx8ICFPYmplY3QudmFsdWVzKHN1bW1hcnkudG90YWwpLnNvbWUoKHZhbHVlKSA9PiB2YWx1ZS50b3RhbCA+IDApKVxuICAgIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIHN1bW1hcnkgaGFzIG5vIG1lYXN1cmVkIGNvZGVcIik7XG4gIHJldHVybiB7XG4gICAgdG90YWw6IHN1bW1hcnkudG90YWwsXG4gICAgLi4uT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgT2JqZWN0LmVudHJpZXMoc3VtbWFyeSlcbiAgICAgICAgLmZpbHRlcigoW3BhdGhdKSA9PiBwYXRoICE9PSBcInRvdGFsXCIpXG4gICAgICAgIC5zb3J0KChbbGVmdF0sIFtyaWdodF0pID0+IChsZWZ0IDwgcmlnaHQgPyAtMSA6IGxlZnQgPiByaWdodCA/IDEgOiAwKSksXG4gICAgKSxcbiAgfTtcbn1cblxuaWYgKHByb2Nlc3MuYXJndlsxXSAmJiByZXNvbHZlKHByb2Nlc3MuYXJndlsxXSkgPT09IGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSkge1xuICBjb25zdCByb290ID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgcmVwb3NpdG9yeSA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9QUk9KRUNUX1JPT1QgPz8gcm9vdDtcbiAgY29uc3QgZmFpbGVkID0gTnVtYmVyKHByb2Nlc3MuYXJndlsyXSA/PyAwKSAhPT0gMDtcbiAgY29uc3Qgc3VtbWFyeSA9IHJlYWRDb3ZlcmFnZVN1bW1hcnkocm9vdCwgcmVwb3NpdG9yeSwgcHJvY2Vzcy5hcmd2WzNdID8gTnVtYmVyKHByb2Nlc3MuYXJndlszXSkgOiB1bmRlZmluZWQpO1xuICBpZiAoc3VtbWFyeSkge1xuICAgIG1rZGlyU3luYyhqb2luKHJvb3QsIFwiY292ZXJhZ2VcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHJlcG9ydFN1bW1hcnlDaGFuZ2Uoc3VtbWFyeSwgcm9vdCwgam9pbihyb290LCBcImNvdmVyYWdlL2NvdmVyYWdlLXN1bW1hcnkuanNvblwiKSwge1xuICAgICAgcmVwb3NpdG9yeSxcbiAgICAgIC4uLihwcm9jZXNzLmFyZ3YuaW5jbHVkZXMoXCItLW5vLWpvYi1zdW1tYXJ5XCIpID8geyBqb2JTdW1tYXJ5OiBcIlwiIH0gOiB7fSksXG4gICAgICB3cml0ZVN1bW1hcnk6ICFmYWlsZWQsXG4gICAgICBub3RpY2U6IGZhaWxlZCA/IFwiQ292ZXJhZ2UgY2hlY2tzIGZhaWxlZDsgdGhlc2UgcmVzdWx0cyBtYXkgYmUgcGFydGlhbC5cIiA6IHVuZGVmaW5lZCxcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCB7IGVtaXRDaGVja0RldGFpbCB9ID0gYXdhaXQgaW1wb3J0KFwiLi9jaGVjay1kZXRhaWwtZGF0YS5tanNcIik7XG4gICAgZW1pdENoZWNrRGV0YWlsKHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICBraW5kOiBcImNvdmVyYWdlLXVuYXZhaWxhYmxlXCIsXG4gICAgICByb290LFxuICAgICAgcmVhc29uOiBcInRoZSBjb25maWd1cmVkIGNvbW1hbmQgcHJvZHVjZWQgbm8gZnJlc2ggc3VwcG9ydGVkIGNvdmVyYWdlIHJlcG9ydC5cIixcbiAgICB9KTtcbiAgICBjb25zb2xlLmxvZyhcIkNvdmVyYWdlIGNoYW5nZSB1bmF2YWlsYWJsZTogdGhlIGNvbmZpZ3VyZWQgY29tbWFuZCBwcm9kdWNlZCBubyBmcmVzaCBzdXBwb3J0ZWQgY292ZXJhZ2UgcmVwb3J0LlwiKTtcbiAgfVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxVQUFVLFFBQVEsZUFBZTtBQUUxQyxTQUFTLFlBQVksV0FBVyxjQUFjLGdCQUFnQjtBQUM5RCxTQUFTLFlBQVksTUFBTSxVQUFVLFNBQVMsV0FBVztBQUN6RCxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLGlCQUFpQixxQkFBcUIsdUJBQXVCLG9CQUFvQjtBQUVuRixTQUFTLG9CQUFvQixNQUFjLGFBQWEsTUFBTSxZQUEwQztBQUM3RyxRQUFNLFlBQVksQ0FBQyxTQUNqQixXQUFXLElBQUksTUFBTSxlQUFlLFVBQWEsU0FBUyxJQUFJLEVBQUUsV0FBVztBQUM3RSxRQUFNLFNBQVMsQ0FBQyxTQUFpQjtBQUMvQixRQUFJLEtBQUssV0FBVyxRQUFRLEVBQUcsUUFBTyxLQUFLLFlBQVksS0FBSyxNQUFNLENBQUMsQ0FBQztB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RCxRQUFNLFNBQVMsT0FBTyxRQUFRLEtBQUssQ0FBQyxLQUFLLENBQUMsTUFBTTtBQUNoRCxRQUFNLFVBQVUsb0JBQW9CLE1BQU0sWUFBWSxRQUFRLEtBQUssQ0FBQyxJQUFJLE9BQU8sUUFBUSxLQUFLLENBQUMsQ0FBQyxJQUFJLE1BQVM7QUFDM0csTUFBSSxTQUFTO0FBQ1gsY0FBVSxLQUFLLE1BQU0sVUFBVSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckQsd0JBQW9CLFNBQVMsTUFBTSxLQUFLLE1BQU0sZ0NBQWdDLEdBQUc7QUFBQSxNQUMvRTtBQUFBLE1BQ0EsR0FBSSxRQUFRLEtBQUssU0FBUyxrQkFBa0IsSUFBSSxFQUFFLFlBQVksR0FBRyxJQUFJLENBQUM7QUFBQSxNQUN0RSxjQUFjLENBQUM7QUFBQSxNQUNmLFFBQVEsU0FBUywwREFBMEQ7QUFBQSxJQUM3RSxDQUFDO0FBQUEsRUFDSCxPQUFPO0FBQ0wsVUFBTSxFQUFFLGdCQUFnQixJQUFJLE1BQU0sT0FBTyx5QkFBeUI7QUFDbEUsb0JBQWdCO0FBQUEsTUFDZCxTQUFTO0FBQUEsTUFDVCxNQUFNO0FBQUEsTUFDTjtBQUFBLE1BQ0EsUUFBUTtBQUFBLElBQ1YsQ0FBQztBQUNELFlBQVEsSUFBSSxrR0FBa0c7QUFBQSxFQUNoSDtBQUNGOyIsIm5hbWVzIjpbInJhdyJdLCJmaWxlIjoic2NyaXB0cy9jaGVjay1jb3ZlcmFnZS1zdW1tYXJ5Lm1qcyJ9
