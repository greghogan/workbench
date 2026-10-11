import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { relative, sep } from "node:path";

export const coverageMetrics = ["lines", "statements", "functions", "branches"];
export const coverageSummaryPath = "coverage/coverage-summary.json";

export function normalizedSummary(map, root) {
  const metrics = (summary) => Object.fromEntries(coverageMetrics.map((name) => [name, summary[name]]));
  const files = map
    .files()
    .map((file) => [relative(root, file).split(sep).join("/"), metrics(map.fileCoverageFor(file).toSummary())]);
  files.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (files.some(([file]) => file === ".." || file.startsWith("../")))
    throw new Error("coverage source outside report root");
  return { total: metrics(map.getCoverageSummary()), ...Object.fromEntries(files) };
}

export function coverageChange(current, baseline, revision) {
  const rows = [
    "## Coverage change",
    "",
    `Baseline: ${revision}`,
    "",
    "| Source | Metric | Baseline | Current | Change |",
    "| --- | --- | --- | --- | --- |",
  ];
  const display = (metric) => (metric ? `${metric.pct}% (${metric.covered}/${metric.total})` : "—");
  const changes = (before, after) => {
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
        ["pct", "covered", "total", "skipped"].every((key) => before[key] === after[key])
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

export function reportCoverageChange(map, root, output, options = {}) {
  return reportSummaryChange(normalizedSummary(map, root), root, output, options);
}

export function reportSummaryChange(current, root, output, options = {}) {
  const revision = options.revision ?? process.env.WORKBENCH_COVERAGE_BASE ?? "HEAD";
  if (!revision || revision.startsWith("-") || /[\r\n:]/.test(revision))
    throw new Error("invalid coverage baseline revision");
  const repository = options.repository ?? root;
  const path = relative(repository, output).split(sep).join("/");
  const git = spawnSync("git", ["-C", repository, "cat-file", "blob", `${revision}:${path}`], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  let baseline;
  if (!git.error && git.status === 0) {
    baseline = JSON.parse(git.stdout);
    if (!baseline.total || Object.keys(current.total).some((metric) => !baseline.total[metric]))
      throw new Error("invalid committed coverage summary");
  }
  if (options.writeSummary !== false) writeFileSync(output, JSON.stringify(current, null, 2) + "\n");
  const presentation =
    (options.notice ? options.notice + "\n\n" : "") +
    `Coverage root: ${relative(repository, root).split(sep).join("/") || "."}\n\n` +
    coverageChange(current, baseline, revision);
  console.log(presentation);
  const jobSummary = options.jobSummary ?? process.env.GITHUB_STEP_SUMMARY;
  if (jobSummary) appendFileSync(jobSummary, presentation + "\n");
  return current;
}
