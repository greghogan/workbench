import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageMetrics, reportSummaryChange } from "./coverage-summary.mjs";

export function readCoverageSummary(root, repository = root, freshSince) {
  const available = (path) => existsSync(path) && (freshSince === undefined || statSync(path).mtimeMs >= freshSince);
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
    pct: total ? Math.floor((covered / total) * 10000) / 100 : 100,
  });
  const summary = {};
  const raw = join(root, "coverage/report.json");
  const profile = join(root, "coverage/profile.out");
  const vitest = join(root, "coverage/coverage-summary.json");
  if (available(raw)) {
    const data = JSON.parse(readFileSync(raw, "utf8"));
    if (data.data?.[0]?.totals) {
      const values = (value) =>
        Object.fromEntries(
          coverageMetrics
            .filter((name) => value[name])
            .map((name) => [name, metric(value[name].covered, value[name].count)]),
        );
      summary.total = values(data.data[0].totals);
      for (const file of data.data[0].files) summary[source(file.filename)] = values(file.summary);
    } else if (data.totals && data.files) {
      const values = (value) => ({
        lines: metric(value.covered_lines, value.num_statements),
        branches: metric(value.covered_branches, value.num_branches),
      });
      summary.total = values(data.totals);
      for (const [path, file] of Object.entries(data.files)) summary[source(path)] = values(file.summary);
    } else throw new Error("unsupported coverage/report.json format");
  } else if (available(profile)) {
    const module = /^module\s+(\S+)/m.exec(readFileSync(join(root, "go.mod"), "utf8"))?.[1];
    if (!module) throw new Error("coverage needs the Go module path");
    const blocks = new Map();
    for (const line of readFileSync(profile, "utf8").trim().split("\n").slice(1)) {
      const match = /^(.*):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(line);
      if (!match || !match[1].startsWith(module + "/")) throw new Error(`invalid Go coverage block: ${line}`);
      const key = `${match[1]}:${match[2]}`;
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
    const values = Object.values(summary).map((file) => file.statements);
    summary.total = {
      statements: metric(
        values.reduce((total, value) => total + value.covered, 0),
        values.reduce((total, value) => total + value.total, 0),
      ),
    };
  } else if (available(vitest)) {
    const data = JSON.parse(readFileSync(vitest, "utf8"));
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
      writeSummary: !failed,
      notice: failed ? "Coverage checks failed; these results may be partial." : undefined,
    });
  } else
    console.log("Coverage change unavailable: the configured command produced no fresh supported coverage report.");
}
