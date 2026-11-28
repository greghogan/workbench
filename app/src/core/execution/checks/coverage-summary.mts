import { writeAtomic } from "../../runtime/file-publication.mjs";
import { emitCheckDetail } from "./check-detail-data.mjs";
import type { CoverageMap, CoverageSummary, Totals as IstanbulTotals } from "istanbul-lib-coverage";
// Empty Istanbul summaries use "Unknown" before any coverage is merged.
export type Totals = Omit<IstanbulTotals, "pct"> & { pct: number | "Unknown" };
export type MetricName = "lines" | "statements" | "functions" | "branches";
export type MetricCounts = Pick<Totals, "covered" | "total"> & { skipped?: number };
export type FileSummary = Partial<Record<MetricName, MetricCounts>>;
export type CoverageDetailMetrics = Partial<Record<MetricName, Totals>>;
export type Summary = Record<string, FileSummary>;
export interface SummaryOptions {
  revision?: string;
  repository?: string;
  writeSummary?: boolean;
  jobSummary?: string;
  notice?: string | undefined;
}
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isRecord } from "../../runtime/values.mjs";

export const coverageMetrics = ["lines", "statements", "functions", "branches"] as const;
export const coverageSummaryPath = "coverage/coverage-summary.json";

export function coveragePercentage({ covered, total }: MetricCounts): number {
  return total ? Math.floor((covered * 10000) / total) / 100 : 100;
}

function coverageCounts({ total, covered, skipped }: MetricCounts): MetricCounts {
  return { total, covered, ...(skipped ? { skipped } : {}) };
}

export function coverageTotals(summary: Summary): FileSummary {
  const totals: FileSummary = {};
  for (const file of Object.values(summary)) {
    for (const name of coverageMetrics) {
      const counts = file[name];
      if (!counts) continue;
      const previous = totals[name];
      totals[name] = coverageCounts({
        covered: (previous?.covered ?? 0) + counts.covered,
        total: (previous?.total ?? 0) + counts.total,
        skipped: (previous?.skipped ?? 0) + (counts.skipped ?? 0),
      });
    }
  }
  return totals;
}

export function readCoverageSummary(value: unknown): Summary {
  if (!isRecord(value)) throw new Error("invalid coverage summary");
  const files: [string, FileSummary][] = [];
  for (const [file, data] of Object.entries(value)) {
    // Existing committed baselines and tool reports may carry their own aggregates and percentages.
    if (file === "total") continue;
    if (!isRecord(data)) throw new Error(`invalid coverage summary for ${file}`);
    const metrics: FileSummary = {};
    for (const name of coverageMetrics) {
      const metric = data[name];
      if (metric === undefined) continue;
      if (
        !isRecord(metric) ||
        typeof metric.total !== "number" ||
        !Number.isSafeInteger(metric.total) ||
        metric.total < 0 ||
        typeof metric.covered !== "number" ||
        !Number.isSafeInteger(metric.covered) ||
        metric.covered < 0 ||
        metric.covered > metric.total ||
        (metric.skipped !== undefined &&
          (typeof metric.skipped !== "number" || !Number.isSafeInteger(metric.skipped) || metric.skipped < 0))
      )
        throw new Error(`invalid ${name} coverage summary for ${file}`);
      metrics[name] = coverageCounts({
        covered: metric.covered,
        total: metric.total,
        ...(typeof metric.skipped === "number" ? { skipped: metric.skipped } : {}),
      });
    }
    files.push([file, metrics]);
  }
  return Object.fromEntries(files);
}

export function normalizedSummary(map: CoverageMap, root: string) {
  const metrics = (summary: CoverageSummary): FileSummary =>
    Object.fromEntries(coverageMetrics.map((name) => [name, coverageCounts(summary[name])]));
  const files = map
    .files()
    .map((file: string): [string, FileSummary] => [
      relative(root, file).split(sep).join("/"),
      metrics(map.fileCoverageFor(file).toSummary()),
    ]);
  files.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (files.some(([file]) => file === ".." || file.startsWith("../")))
    throw new Error("coverage source outside report root");
  return Object.fromEntries(files);
}

export function coverageChange(current: Summary, baseline: Summary | undefined, revision: string) {
  const currentTotals = coverageTotals(current);
  const baselineTotals = baseline && coverageTotals(baseline);
  const rows = [
    "## Coverage change",
    "",
    `Baseline: ${revision}`,
    "",
    "| Source | Metric | Baseline | Current | Change |",
    "| --- | --- | --- | --- | --- |",
  ];
  const display = (metric: MetricCounts | undefined) =>
    metric ? `${String(coveragePercentage(metric))}% (${String(metric.covered)}/${String(metric.total)})` : "—";
  const changes = (before: MetricCounts | undefined, after: MetricCounts | undefined) => {
    if (!before) return "added";
    if (!after) return "removed";
    const delta = Math.round((coveragePercentage(after) - coveragePercentage(before)) * 100) / 100;
    return `${delta > 0 ? "+" : ""}${delta.toFixed(2)} pp`;
  };
  const files = (baseline ? [...new Set([...Object.keys(current), ...Object.keys(baseline)])] : [])
    .filter((file) => file !== "total")
    .sort();
  for (const file of ["total", ...files])
    for (const name of coverageMetrics) {
      const before = (file === "total" ? baselineTotals : baseline?.[file])?.[name];
      const after = (file === "total" ? currentTotals : current[file])?.[name];
      if (!before && !after) continue;
      if (
        file !== "total" &&
        before &&
        after &&
        (["covered", "total", "skipped"] as const).every((key) => before[key] === after[key])
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
  const captured = process.env.WORKBENCH_CHECK_BASELINE;
  let committed: string | undefined;
  if (captured) committed = readFileSync(captured, "utf8");
  else {
    const git = spawnSync("git", ["-C", coverageRepository(repository), "cat-file", "blob", `${revision}:${path}`], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!git.error && git.status === 0) committed = git.stdout;
  }
  let baseline: Summary | undefined;
  if (committed) {
    baseline = readCoverageSummary(JSON.parse(committed));
    const total = coverageTotals(baseline);
    const actual = coverageTotals(current);
    if (!Object.keys(total).length || coverageMetrics.some((metric) => actual[metric] && !total[metric]))
      throw new Error("invalid committed coverage summary");
  }
  if (options.writeSummary !== false) writeAtomic(output, JSON.stringify(current, null, 2) + "\n");
  const presentation =
    (options.notice ? options.notice + "\n\n" : "") +
    `Coverage root: ${relative(repository, root).split(sep).join("/") || "."}\n\n` +
    coverageChange(current, baseline, revision);
  emitCheckDetail({
    version: 1,
    kind: "coverage",
    root: relative(repository, root).split(sep).join("/") || ".",
    revision,
    current: detailMetrics(current),
    ...(baseline ? { baseline: detailMetrics(baseline) } : {}),
    ...(options.notice ? { notice: options.notice } : {}),
  });
  console.log(presentation);
  const jobSummary = options.jobSummary ?? process.env.GITHUB_STEP_SUMMARY;
  if (jobSummary) appendFileSync(jobSummary, presentation + "\n");
  return current;
}

function detailMetrics(summary: Summary): CoverageDetailMetrics {
  return Object.fromEntries(
    Object.entries(coverageTotals(summary)).map(([name, counts]) => [
      name,
      { ...counts, skipped: counts.skipped ?? 0, pct: coveragePercentage(counts) },
    ]),
  );
}
