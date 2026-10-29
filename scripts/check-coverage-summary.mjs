// Generated from check-coverage-summary.mts; edit the TypeScript source.
import { isMainScript } from "./script-entry.mjs";
import { emitCheckDetail } from "./check-detail-data.mjs";
import { clipped } from "./diagnostic-text.mjs";
import { required, record, records } from "./values.mjs";
import {
  coverageMetrics,
  reportSummaryChange,
  readCoverageSummary as parseSummary
} from "./coverage-summary.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNoZWNrLWNvdmVyYWdlLXN1bW1hcnkubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGlzTWFpblNjcmlwdCB9IGZyb20gXCIuL3NjcmlwdC1lbnRyeS5tanNcIjtcbmltcG9ydCB7IGVtaXRDaGVja0RldGFpbCB9IGZyb20gXCIuL2NoZWNrLWRldGFpbC1kYXRhLm1qc1wiO1xuaW1wb3J0IHsgY2xpcHBlZCB9IGZyb20gXCIuL2RpYWdub3N0aWMtdGV4dC5tanNcIjtcbmltcG9ydCB7IHJlcXVpcmVkLCByZWNvcmQsIHJlY29yZHMgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQge1xuICB0eXBlIFN1bW1hcnksXG4gIHR5cGUgRmlsZVN1bW1hcnksXG4gIGNvdmVyYWdlTWV0cmljcyxcbiAgcmVwb3J0U3VtbWFyeUNoYW5nZSxcbiAgcmVhZENvdmVyYWdlU3VtbWFyeSBhcyBwYXJzZVN1bW1hcnksXG59IGZyb20gXCIuL2NvdmVyYWdlLXN1bW1hcnkubWpzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgcmVhbHBhdGhTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlYWRDb3ZlcmFnZVN1bW1hcnkocm9vdDogc3RyaW5nLCByZXBvc2l0b3J5ID0gcm9vdCwgZnJlc2hTaW5jZT86IG51bWJlcik6IFN1bW1hcnkgfCB1bmRlZmluZWQge1xuICAvLyBSZXBvcnRzIGNhbiByZXRhaW4gZGVsZXRlZCBzb3VyY2UgZW50cmllczsgcmVzb2x2ZSB0aGVpciBleGlzdGluZyBhbmNlc3RvcnMgYXMgd2VsbCBhcyBsaXZlIGZpbGVzLlxuICBjb25zdCBjYW5vbmljYWwgPSAocGF0aDogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWxwYXRoU3luYy5uYXRpdmUocGF0aCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUocGF0aCk7XG4gICAgICBpZiAoKGVycm9yIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZSAhPT0gXCJFTk9FTlRcIiB8fCBwYXJlbnQgPT09IHBhdGgpIHRocm93IGVycm9yO1xuICAgICAgcmV0dXJuIGpvaW4oY2Fub25pY2FsKHBhcmVudCksIGJhc2VuYW1lKHBhdGgpKTtcbiAgICB9XG4gIH07XG4gIHJvb3QgPSBjYW5vbmljYWwocmVzb2x2ZShyb290KSk7XG4gIHJlcG9zaXRvcnkgPSBjYW5vbmljYWwocmVzb2x2ZShyZXBvc2l0b3J5KSk7XG4gIGNvbnN0IGF2YWlsYWJsZSA9IChwYXRoOiBzdHJpbmcpID0+XG4gICAgZXhpc3RzU3luYyhwYXRoKSAmJiAoZnJlc2hTaW5jZSA9PT0gdW5kZWZpbmVkIHx8IHN0YXRTeW5jKHBhdGgpLm10aW1lTXMgPj0gZnJlc2hTaW5jZSk7XG4gIGNvbnN0IHNvdXJjZSA9IChwYXRoOiBzdHJpbmcpID0+IHtcbiAgICBpZiAocGF0aC5zdGFydHNXaXRoKFwiL3dvcmsvXCIpKSBwYXRoID0gam9pbihyZXBvc2l0b3J5LCBwYXRoLnNsaWNlKDYpKTtcbiAgICBjb25zdCBub3JtYWxpemVkID0gcmVsYXRpdmUocm9vdCwgY2Fub25pY2FsKHJlc29sdmUocm9vdCwgcGF0aCkpKTtcbiAgICBpZiAobm9ybWFsaXplZCA9PT0gXCIuLlwiIHx8IG5vcm1hbGl6ZWQuc3RhcnRzV2l0aChgLi4ke3NlcH1gKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgY292ZXJhZ2Ugc291cmNlIG91dHNpZGUgcm9vdDogJHtwYXRofWApO1xuICAgIHJldHVybiBub3JtYWxpemVkLnNwbGl0KHNlcCkuam9pbihcIi9cIik7XG4gIH07XG4gIGNvbnN0IG1ldHJpYyA9IChjb3ZlcmVkOiBudW1iZXIsIHRvdGFsOiBudW1iZXIpID0+ICh7XG4gICAgdG90YWwsXG4gICAgY292ZXJlZCxcbiAgICBza2lwcGVkOiAwLFxuICAgIHBjdDogdG90YWwgPyBNYXRoLmZsb29yKChjb3ZlcmVkIC8gdG90YWwpICogMTAwMDApIC8gMTAwIDogMTAwLFxuICB9KTtcbiAgY29uc3Qgc3VtbWFyeTogU3VtbWFyeSA9IHt9O1xuICBjb25zdCByYXcgPSBqb2luKHJvb3QsIFwiY292ZXJhZ2UvcmVwb3J0Lmpzb25cIik7XG4gIGNvbnN0IHByb2ZpbGUgPSBqb2luKHJvb3QsIFwiY292ZXJhZ2UvcHJvZmlsZS5vdXRcIik7XG4gIGNvbnN0IHZpdGVzdCA9IGpvaW4ocm9vdCwgXCJjb3ZlcmFnZS9jb3ZlcmFnZS1zdW1tYXJ5Lmpzb25cIik7XG4gIGlmIChhdmFpbGFibGUocmF3KSkge1xuICAgIGNvbnN0IGRhdGEgPSByZWNvcmQoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocmF3LCBcInV0ZjhcIikpLCBcIkludmFsaWQgY292ZXJhZ2UgcmVwb3J0XCIpO1xuICAgIGNvbnN0IGxsdm0gPSBkYXRhLmRhdGEgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHJlY29yZHMoZGF0YS5kYXRhLCBcIkludmFsaWQgTExWTSByZXBvcnRzXCIpWzBdO1xuICAgIGNvbnN0IGNvdW50ID0gKHZhbHVlOiB1bmtub3duKTogbnVtYmVyID0+IHtcbiAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPCAwKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIGNvdmVyYWdlIGNvdW50XCIpO1xuICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH07XG4gICAgaWYgKGxsdm0/LnRvdGFscykge1xuICAgICAgY29uc3QgdmFsdWVzID0gKHJhdzogdW5rbm93bik6IEZpbGVTdW1tYXJ5ID0+IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSByZWNvcmQocmF3LCBcIkludmFsaWQgTExWTSBjb3VudHNcIik7XG4gICAgICAgIHJldHVybiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICAgICAgY292ZXJhZ2VNZXRyaWNzXG4gICAgICAgICAgICAuZmlsdGVyKChuYW1lKSA9PiB2YWx1ZVtuYW1lXSlcbiAgICAgICAgICAgIC5tYXAoKG5hbWUpID0+IFtcbiAgICAgICAgICAgICAgbmFtZSxcbiAgICAgICAgICAgICAgbWV0cmljKFxuICAgICAgICAgICAgICAgIGNvdW50KHJlY29yZCh2YWx1ZVtuYW1lXSwgXCJDb3ZlcmFnZSBtZXRyaWNcIikuY292ZXJlZCksXG4gICAgICAgICAgICAgICAgY291bnQocmVjb3JkKHZhbHVlW25hbWVdLCBcIkNvdmVyYWdlIG1ldHJpY1wiKS5jb3VudCksXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICBdKSxcbiAgICAgICAgKTtcbiAgICAgIH07XG4gICAgICBzdW1tYXJ5LnRvdGFsID0gdmFsdWVzKGxsdm0udG90YWxzKTtcbiAgICAgIGZvciAoY29uc3QgZmlsZSBvZiByZWNvcmRzKGxsdm0uZmlsZXMsIFwiSW52YWxpZCBMTFZNIGZpbGVzXCIpKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZmlsZS5maWxlbmFtZSAhPT0gXCJzdHJpbmdcIikgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBjb3ZlcmFnZSBwYXRoXCIpO1xuICAgICAgICBzdW1tYXJ5W3NvdXJjZShmaWxlLmZpbGVuYW1lKV0gPSB2YWx1ZXMoZmlsZS5zdW1tYXJ5KTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGRhdGEudG90YWxzICYmIGRhdGEuZmlsZXMpIHtcbiAgICAgIGNvbnN0IHZhbHVlcyA9IChyYXc6IHVua25vd24pOiBGaWxlU3VtbWFyeSA9PiB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVjb3JkKHJhdywgXCJJbnZhbGlkIFB5dGhvbiBjb3VudHNcIik7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgbGluZXM6IG1ldHJpYyhjb3VudCh2YWx1ZS5jb3ZlcmVkX2xpbmVzKSwgY291bnQodmFsdWUubnVtX3N0YXRlbWVudHMpKSxcbiAgICAgICAgICBicmFuY2hlczogbWV0cmljKGNvdW50KHZhbHVlLmNvdmVyZWRfYnJhbmNoZXMpLCBjb3VudCh2YWx1ZS5udW1fYnJhbmNoZXMpKSxcbiAgICAgICAgfTtcbiAgICAgIH07XG4gICAgICBzdW1tYXJ5LnRvdGFsID0gdmFsdWVzKGRhdGEudG90YWxzKTtcbiAgICAgIGZvciAoY29uc3QgW3BhdGgsIGZpbGVdIG9mIE9iamVjdC5lbnRyaWVzKHJlY29yZChkYXRhLmZpbGVzLCBcIkludmFsaWQgUHl0aG9uIGZpbGVzXCIpKSlcbiAgICAgICAgc3VtbWFyeVtzb3VyY2UocGF0aCldID0gdmFsdWVzKHJlY29yZChmaWxlLCBcIkludmFsaWQgUHl0aG9uIGZpbGVcIikuc3VtbWFyeSk7XG4gICAgfSBlbHNlIHRocm93IG5ldyBFcnJvcihcInVuc3VwcG9ydGVkIGNvdmVyYWdlL3JlcG9ydC5qc29uIGZvcm1hdFwiKTtcbiAgfSBlbHNlIGlmIChhdmFpbGFibGUocHJvZmlsZSkpIHtcbiAgICBjb25zdCBtb2R1bGUgPSAvXm1vZHVsZVxccysoXFxTKykvbS5leGVjKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwiZ28ubW9kXCIpLCBcInV0ZjhcIikpPy5bMV07XG4gICAgaWYgKCFtb2R1bGUpIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIG5lZWRzIHRoZSBHbyBtb2R1bGUgcGF0aFwiKTtcbiAgICBjb25zdCBibG9ja3MgPSBuZXcgTWFwPHN0cmluZywgeyBwYXRoOiBzdHJpbmc7IHRvdGFsOiBudW1iZXI7IGNvdmVyZWQ6IGJvb2xlYW4gfCB1bmRlZmluZWQgfT4oKTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgcmVhZEZpbGVTeW5jKHByb2ZpbGUsIFwidXRmOFwiKS50cmltKCkuc3BsaXQoXCJcXG5cIikuc2xpY2UoMSkpIHtcbiAgICAgIGNvbnN0IG1hdGNoID0gL14oLiopOihcXGQrXFwuXFxkKyxcXGQrXFwuXFxkKykgKFxcZCspIChcXGQrKSQvLmV4ZWMobGluZSk7XG4gICAgICBpZiAoIW1hdGNoPy5bMV0/LnN0YXJ0c1dpdGgobW9kdWxlICsgXCIvXCIpKSB0aHJvdyBuZXcgRXJyb3IoYGludmFsaWQgR28gY292ZXJhZ2UgYmxvY2s6ICR7bGluZX1gKTtcbiAgICAgIGNvbnN0IGtleSA9IGAke21hdGNoWzFdfToke1N0cmluZyhtYXRjaFsyXSl9YDtcbiAgICAgIGJsb2Nrcy5zZXQoa2V5LCB7XG4gICAgICAgIHBhdGg6IHNvdXJjZShtYXRjaFsxXS5zbGljZShtb2R1bGUubGVuZ3RoICsgMSkpLFxuICAgICAgICB0b3RhbDogTnVtYmVyKG1hdGNoWzNdKSxcbiAgICAgICAgY292ZXJlZDogTnVtYmVyKG1hdGNoWzRdKSA+IDAgfHwgYmxvY2tzLmdldChrZXkpPy5jb3ZlcmVkLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzLnZhbHVlcygpKSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IHN1bW1hcnlbYmxvY2sucGF0aF0/LnN0YXRlbWVudHMgPz8gbWV0cmljKDAsIDApO1xuICAgICAgc3VtbWFyeVtibG9jay5wYXRoXSA9IHtcbiAgICAgICAgc3RhdGVtZW50czogbWV0cmljKHZhbHVlLmNvdmVyZWQgKyAoYmxvY2suY292ZXJlZCA/IGJsb2NrLnRvdGFsIDogMCksIHZhbHVlLnRvdGFsICsgYmxvY2sudG90YWwpLFxuICAgICAgfTtcbiAgICB9XG4gICAgY29uc3QgdmFsdWVzID0gT2JqZWN0LnZhbHVlcyhzdW1tYXJ5KS5tYXAoKGZpbGUpID0+IHJlcXVpcmVkKGZpbGUuc3RhdGVtZW50cywgXCJNaXNzaW5nIEdvIHN0YXRlbWVudCBjb3ZlcmFnZVwiKSk7XG4gICAgc3VtbWFyeS50b3RhbCA9IHtcbiAgICAgIHN0YXRlbWVudHM6IG1ldHJpYyhcbiAgICAgICAgdmFsdWVzLnJlZHVjZSgodG90YWwsIHZhbHVlKSA9PiB0b3RhbCArIHZhbHVlLmNvdmVyZWQsIDApLFxuICAgICAgICB2YWx1ZXMucmVkdWNlKCh0b3RhbCwgdmFsdWUpID0+IHRvdGFsICsgdmFsdWUudG90YWwsIDApLFxuICAgICAgKSxcbiAgICB9O1xuICB9IGVsc2UgaWYgKGF2YWlsYWJsZSh2aXRlc3QpKSB7XG4gICAgY29uc3QgZGF0YSA9IHBhcnNlU3VtbWFyeShKU09OLnBhcnNlKHJlYWRGaWxlU3luYyh2aXRlc3QsIFwidXRmOFwiKSkpO1xuICAgIGZvciAoY29uc3QgW3BhdGgsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhkYXRhKSlcbiAgICAgIHN1bW1hcnlbcGF0aCA9PT0gXCJ0b3RhbFwiID8gcGF0aCA6IHNvdXJjZShwYXRoKV0gPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICAgIGNvdmVyYWdlTWV0cmljcy5maWx0ZXIoKG5hbWUpID0+IHZhbHVlW25hbWVdKS5tYXAoKG5hbWUpID0+IFtuYW1lLCB2YWx1ZVtuYW1lXV0pLFxuICAgICAgKTtcbiAgfSBlbHNlIHJldHVybiB1bmRlZmluZWQ7XG4gIGlmICghc3VtbWFyeS50b3RhbCB8fCAhT2JqZWN0LnZhbHVlcyhzdW1tYXJ5LnRvdGFsKS5zb21lKCh2YWx1ZSkgPT4gdmFsdWUudG90YWwgPiAwKSlcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJjb3ZlcmFnZSBzdW1tYXJ5IGhhcyBubyBtZWFzdXJlZCBjb2RlXCIpO1xuICByZXR1cm4ge1xuICAgIHRvdGFsOiBzdW1tYXJ5LnRvdGFsLFxuICAgIC4uLk9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgIE9iamVjdC5lbnRyaWVzKHN1bW1hcnkpXG4gICAgICAgIC5maWx0ZXIoKFtwYXRoXSkgPT4gcGF0aCAhPT0gXCJ0b3RhbFwiKVxuICAgICAgICAuc29ydCgoW2xlZnRdLCBbcmlnaHRdKSA9PiAobGVmdCA8IHJpZ2h0ID8gLTEgOiBsZWZ0ID4gcmlnaHQgPyAxIDogMCkpLFxuICAgICksXG4gIH07XG59XG5cbmlmIChpc01haW5TY3JpcHQoaW1wb3J0Lm1ldGEudXJsKSkge1xuICBjb25zdCByb290ID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgcmVwb3NpdG9yeSA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9QUk9KRUNUX1JPT1QgPz8gcm9vdDtcbiAgY29uc3QgZmFpbGVkID0gTnVtYmVyKHByb2Nlc3MuYXJndlsyXSA/PyAwKSAhPT0gMDtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdW1tYXJ5ID0gcmVhZENvdmVyYWdlU3VtbWFyeShyb290LCByZXBvc2l0b3J5LCBwcm9jZXNzLmFyZ3ZbM10gPyBOdW1iZXIocHJvY2Vzcy5hcmd2WzNdKSA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKHN1bW1hcnkpIHtcbiAgICAgIG1rZGlyU3luYyhqb2luKHJvb3QsIFwiY292ZXJhZ2VcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgcmVwb3J0U3VtbWFyeUNoYW5nZShzdW1tYXJ5LCByb290LCBqb2luKHJvb3QsIFwiY292ZXJhZ2UvY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpLCB7XG4gICAgICAgIHJlcG9zaXRvcnksXG4gICAgICAgIC4uLihwcm9jZXNzLmFyZ3YuaW5jbHVkZXMoXCItLW5vLWpvYi1zdW1tYXJ5XCIpID8geyBqb2JTdW1tYXJ5OiBcIlwiIH0gOiB7fSksXG4gICAgICAgIHdyaXRlU3VtbWFyeTogIWZhaWxlZCxcbiAgICAgICAgbm90aWNlOiBmYWlsZWQgPyBcIkNvdmVyYWdlIGNoZWNrcyBmYWlsZWQ7IHRoZXNlIHJlc3VsdHMgbWF5IGJlIHBhcnRpYWwuXCIgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgZW1pdENoZWNrRGV0YWlsKHtcbiAgICAgICAgdmVyc2lvbjogMSxcbiAgICAgICAga2luZDogXCJjb3ZlcmFnZS11bmF2YWlsYWJsZVwiLFxuICAgICAgICByb290LFxuICAgICAgICByZWFzb246IFwidGhlIGNvbmZpZ3VyZWQgY29tbWFuZCBwcm9kdWNlZCBubyBmcmVzaCBzdXBwb3J0ZWQgY292ZXJhZ2UgcmVwb3J0LlwiLFxuICAgICAgfSk7XG4gICAgICBjb25zb2xlLmxvZyhcIkNvdmVyYWdlIGNoYW5nZSB1bmF2YWlsYWJsZTogdGhlIGNvbmZpZ3VyZWQgY29tbWFuZCBwcm9kdWNlZCBubyBmcmVzaCBzdXBwb3J0ZWQgY292ZXJhZ2UgcmVwb3J0LlwiKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZW1pdENoZWNrRGV0YWlsKHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICBraW5kOiBcImNvdmVyYWdlLXVuYXZhaWxhYmxlXCIsXG4gICAgICByb290LFxuICAgICAgcmVhc29uOiBgY292ZXJhZ2Ugc3VtbWFyeSBmYWlsZWQ6ICR7Y2xpcHBlZChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiaW52YWxpZCBjb3ZlcmFnZSByZXBvcnRcIiwgMjA0OCkudGV4dH1gLFxuICAgIH0pO1xuICAgIHRocm93IGVycm9yO1xuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLGVBQWU7QUFDeEIsU0FBUyxVQUFVLFFBQVEsZUFBZTtBQUMxQztBQUFBLEVBR0U7QUFBQSxFQUNBO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxPQUNsQjtBQUNQLFNBQVMsWUFBWSxXQUFXLGNBQWMsY0FBYyxnQkFBZ0I7QUFDNUUsU0FBUyxVQUFVLFNBQVMsTUFBTSxVQUFVLFNBQVMsV0FBVztBQUV6RCxTQUFTLG9CQUFvQixNQUFjLGFBQWEsTUFBTSxZQUEwQztBQUU3RyxRQUFNLFlBQVksQ0FBQyxTQUF5QjtBQUMxQyxRQUFJO0FBQ0YsYUFBTyxhQUFhLE9BQU8sSUFBSTtBQUFBLElBQ2pDLFNBQVMsT0FBTztBQUNkLFlBQU0sU0FBUyxRQUFRLElBQUk7QUFDM0IsVUFBSyxNQUFnQyxTQUFTLFlBQVksV0FBVyxLQUFNLE9BQU07QUFDakYsYUFBTyxLQUFLLFVBQVUsTUFBTSxH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
