import { emitCheckDetail } from "./check-detail-data.mjs";
import type { CoverageMap, CoverageSummary, Totals as IstanbulTotals } from "istanbul-lib-coverage";
// Empty Istanbul summaries use "Unknown" before any coverage is merged.
export type Totals = Omit<IstanbulTotals, "pct"> & { pct: number | "Unknown" };
export type MetricName = "lines" | "statements" | "functions" | "branches";
export type FileSummary = Partial<Record<MetricName, Totals>>;
export type Summary = Record<string, FileSummary>;
export interface SummaryOptions {
  revision?: string;
  repository?: string;
  writeSummary?: boolean;
  jobSummary?: string;
  notice?: string | undefined;
}
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isRecord } from "./values.mjs";

export const coverageMetrics = ["lines", "statements", "functions", "branches"] as const;
export const coverageSummaryPath = "coverage/coverage-summary.json";

export function readCoverageSummary(value: unknown): Summary {
  if (!isRecord(value) || !isRecord(value.total)) throw new Error("invalid coverage summary");
  const summary: Summary = {};
  for (const [file, data] of Object.entries(value)) {
    if (!isRecord(data)) throw new Error(`invalid coverage summary for ${file}`);
    const metrics: FileSummary = {};
    for (const name of coverageMetrics) {
      const metric = data[name];
      if (metric === undefined) continue;
      if (
        !isRecord(metric) ||
        typeof metric.total !== "number" ||
        typeof metric.covered !== "number" ||
        typeof metric.skipped !== "number" ||
        (typeof metric.pct !== "number" && metric.pct !== "Unknown")
      )
        throw new Error(`invalid ${name} coverage summary for ${file}`);
      metrics[name] = { total: metric.total, covered: metric.covered, skipped: metric.skipped, pct: metric.pct };
    }
    summary[file] = metrics;
  }
  return summary;
}

export function normalizedSummary(map: CoverageMap, root: string) {
  const metrics = (summary: CoverageSummary): FileSummary =>
    Object.fromEntries(coverageMetrics.map((name) => [name, summary[name]]));
  const files = map
    .files()
    .map((file: string): [string, FileSummary] => [
      relative(root, file).split(sep).join("/"),
      metrics(map.fileCoverageFor(file).toSummary()),
    ]);
  files.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (files.some(([file]) => file === ".." || file.startsWith("../")))
    throw new Error("coverage source outside report root");
  return { total: metrics(map.getCoverageSummary()), ...Object.fromEntries(files) };
}

export function coverageChange(current: Summary, baseline: Summary | undefined, revision: string) {
  const rows = [
    "## Coverage change",
    "",
    `Baseline: ${revision}`,
    "",
    "| Source | Metric | Baseline | Current | Change |",
    "| --- | --- | --- | --- | --- |",
  ];
  const display = (metric: Totals | undefined) =>
    metric ? `${String(metric.pct)}% (${String(metric.covered)}/${String(metric.total)})` : "—";
  const changes = (before: Totals | undefined, after: Totals | undefined) => {
    if (!before) return "added";
    if (!after) return "removed";
    if (typeof before.pct !== "number" || typeof after.pct !== "number") return "unmeasured";
    const delta = Math.round((after.pct - before.pct) * 100) / 100;
    return `${delta > 0 ? "+" : ""}${delta.toFixed(2)} pp`;
  };
  const files = (baseline ? [...new Set([...Object.keys(current), ...Object.keys(baseline)])] : [])
    .filter((file) => file !== "total")
    .sort();
  for (const file of ["total", ...files])
    for (const name of coverageMetrics) {
      const before = baseline?.[file]?.[name];
      const after = current[file]?.[name];
      if (!before && !after) continue;
      if (
        file !== "total" &&
        before &&
        after &&
        (["pct", "covered", "total", "skipped"] as const).every((key) => before[key] === after[key])
      )
        continue;
      const source = file.replaceAll("|", "\\|").replaceAll("\n", " ");
      rows.push(
        `| ${source} | ${name} | ${display(before)} | ${display(after)} | ${baseline ? changes(before, after) : "unavailable"} |`,
      );
    }
  if (!baseline)
    rows.splice(2, 1, `No committed coverage summary is available at ${revision}; changes cannot be compared.`);
  return rows.join("\n") + "\n";
}

export function reportCoverageChange(map: CoverageMap, root: string, output: string, options: SummaryOptions = {}) {
  return reportSummaryChange(normalizedSummary(map, root), root, output, options);
}

/** A staged tree owns current files; its checkout owns the committed comparison baseline. */
export function coverageRepository(repository: string) {
  return process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1" &&
    process.env.WORKBENCH_LOCAL_CONFIG_ROOT &&
    process.env.WORKBENCH_PROJECT_ROOT &&
    resolve(repository) === resolve(process.env.WORKBENCH_PROJECT_ROOT)
    ? process.env.WORKBENCH_LOCAL_CONFIG_ROOT
    : repository;
}

export function reportSummaryChange(current: Summary, root: string, output: string, options: SummaryOptions = {}) {
  const revision = options.revision ?? process.env.WORKBENCH_COVERAGE_BASE ?? "HEAD";
  if (!revision || revision.startsWith("-") || /[\r\n:]/.test(revision))
    throw new Error("invalid coverage baseline revision");
  const repository = options.repository ?? root;
  const path = relative(repository, output).split(sep).join("/");
  const git = spawnSync("git", ["-C", coverageRepository(repository), "cat-file", "blob", `${revision}:${path}`], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  let baseline: Summary | undefined;
  if (!git.error && git.status === 0) {
    baseline = readCoverageSummary(JSON.parse(git.stdout));
    const total = baseline.total;
    if (!total || coverageMetrics.some((metric) => current.total?.[metric] && !total[metric]))
      throw new Error("invalid committed coverage summary");
  }
  if (options.writeSummary !== false) writeFileSync(output, JSON.stringify(current, null, 2) + "\n");
  const presentation =
    (options.notice ? options.notice + "\n\n" : "") +
    `Coverage root: ${relative(repository, root).split(sep).join("/") || "."}\n\n` +
    coverageChange(current, baseline, revision);
  emitCheckDetail({
    version: 1,
    kind: "coverage",
    root: relative(repository, root).split(sep).join("/") || ".",
    revision,
    current: current.total ?? {},
    ...(baseline?.total ? { baseline: baseline.total } : {}),
    ...(options.notice ? { notice: options.notice } : {}),
  });
  console.log(presentation);
  const jobSummary = options.jobSummary ?? process.env.GITHUB_STEP_SUMMARY;
  if (jobSummary) appendFileSync(jobSummary, presentation + "\n");
  return current;
}
