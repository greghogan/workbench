import { required, record, records } from "./values.mjs";
import type { Summary, FileSummary } from "./coverage-summary.mjs";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageMetrics, reportSummaryChange, readCoverageSummary as parseSummary } from "./coverage-summary.mjs";

export function readCoverageSummary(root: string, repository = root, freshSince?: number): Summary | undefined {
  const available = (path: string) =>
    existsSync(path) && (freshSince === undefined || statSync(path).mtimeMs >= freshSince);
  const source = (path: string) => {
    if (path.startsWith("/work/")) path = join(repository, path.slice(6));
    const normalized = isAbsolute(path) ? relative(root, resolve(path)) : path;
    if (normalized === ".." || normalized.startsWith(`..${sep}`))
      throw new Error(`coverage source outside root: ${path}`);
    return normalized.split(sep).join("/");
  };
  const metric = (covered: number, total: number) => ({
    total,
    covered,
    skipped: 0,
    pct: total ? Math.floor((covered / total) * 10000) / 100 : 100,
  });
  const summary: Summary = {};
  const raw = join(root, "coverage/report.json");
  const profile = join(root, "coverage/profile.out");
  const vitest = join(root, "coverage/coverage-summary.json");
  if (available(raw)) {
    const data = record(JSON.parse(readFileSync(raw, "utf8")), "Invalid coverage report");
    const llvm = data.data === undefined ? undefined : records(data.data, "Invalid LLVM reports")[0];
    const count = (value: unknown): number => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid coverage count");
      return value;
    };
    if (llvm?.totals) {
      const values = (raw: unknown): FileSummary => {
        const value = record(raw, "Invalid LLVM counts");
        return Object.fromEntries(
          coverageMetrics
            .filter((name) => value[name])
            .map((name) => [
              name,
              metric(
                count(record(value[name], "Coverage metric").covered),
                count(record(value[name], "Coverage metric").count),
              ),
            ]),
        );
      };
      summary.total = values(llvm.totals);
      for (const file of records(llvm.files, "Invalid LLVM files")) {
        if (typeof file.filename !== "string") throw new Error("Invalid coverage path");
        summary[source(file.filename)] = values(file.summary);
      }
    } else if (data.totals && data.files) {
      const values = (raw: unknown): FileSummary => {
        const value = record(raw, "Invalid Python counts");
        return {
          lines: metric(count(value.covered_lines), count(value.num_statements)),
          branches: metric(count(value.covered_branches), count(value.num_branches)),
        };
      };
      summary.total = values(data.totals);
      for (const [path, file] of Object.entries(record(data.files, "Invalid Python files")))
        summary[source(path)] = values(record(file, "Invalid Python file").summary);
    } else throw new Error("unsupported coverage/report.json format");
  } else if (available(profile)) {
    const module = /^module\s+(\S+)/m.exec(readFileSync(join(root, "go.mod"), "utf8"))?.[1];
    if (!module) throw new Error("coverage needs the Go module path");
    const blocks = new Map<string, { path: string; total: number; covered: boolean | undefined }>();
    for (const line of readFileSync(profile, "utf8").trim().split("\n").slice(1)) {
      const match = /^(.*):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(line);
      if (!match?.[1]?.startsWith(module + "/")) throw new Error(`invalid Go coverage block: ${line}`);
      const key = `${match[1]}:${String(match[2])}`;
      blocks.set(key, {
        path: source(match[1].slice(module.length + 1)),
        total: Number(match[3]),
        covered: Number(match[4]) > 0 || blocks.get(key)?.covered,
      });
    }
    for (const block of blocks.values()) {
      const value = summary[block.path]?.statements ?? metric(0, 0);
      summary[block.path] = {
        statements: metric(value.covered + (block.covered ? block.total : 0), value.total + block.total),
      };
    }
    const values = Object.values(summary).map((file) => required(file.statements, "Missing Go statement coverage"));
    summary.total = {
      statements: metric(
        values.reduce((total, value) => total + value.covered, 0),
        values.reduce((total, value) => total + value.total, 0),
      ),
    };
  } else if (available(vitest)) {
    const data = parseSummary(JSON.parse(readFileSync(vitest, "utf8")));
    for (const [path, value] of Object.entries(data))
      summary[path === "total" ? path : source(path)] = Object.fromEntries(
        coverageMetrics.filter((name) => value[name]).map((name) => [name, value[name]]),
      );
  } else return undefined;
  if (!summary.total || !Object.values(summary.total).some((value) => value.total > 0))
    throw new Error("coverage summary has no measured code");
  return {
    total: summary.total,
    ...Object.fromEntries(
      Object.entries(summary)
        .filter(([path]) => path !== "total")
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const repository = process.env.WORKBENCH_PROJECT_ROOT ?? root;
  const failed = Number(process.argv[2] ?? 0) !== 0;
  const summary = readCoverageSummary(root, repository, process.argv[3] ? Number(process.argv[3]) : undefined);
  if (summary) {
    mkdirSync(join(root, "coverage"), { recursive: true });
    reportSummaryChange(summary, root, join(root, "coverage/coverage-summary.json"), {
      repository,
      ...(process.argv.includes("--no-job-summary") ? { jobSummary: "" } : {}),
      writeSummary: !failed,
      notice: failed ? "Coverage checks failed; these results may be partial." : undefined,
    });
  } else {
    const { emitCheckDetail } = await import("./check-detail-data.mjs");
    emitCheckDetail({
      version: 1,
      kind: "coverage-unavailable",
      root,
      reason: "the configured command produced no fresh supported coverage report.",
    });
    console.log("Coverage change unavailable: the configured command produced no fresh supported coverage report.");
  }
}
