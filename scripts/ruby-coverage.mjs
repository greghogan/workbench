import { writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const metric = (values) => ({
  total: values.length,
  covered: values.filter((hits) => hits > 0).length,
  skipped: 0,
  pct: values.length ? Math.floor((values.filter((hits) => hits > 0).length / values.length) * 10000) / 100 : 100,
});

export function rubyCoverageSummary(report, root) {
  const runs = Object.values(report);
  if (runs.length !== 1 || !runs[0]?.coverage) throw new Error("Expected one fresh SimpleCov suite");
  const files = {};
  const lines = [],
    branches = [];
  for (const [absolute, counters] of Object.entries(runs[0].coverage)) {
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (isAbsolute(path) || path.startsWith("../")) throw new Error("Ruby coverage source outside root");
    if (!path.startsWith("lib/") && !path.startsWith("bin/")) continue;
    const fileLines = counters.lines.filter((hits) => hits !== null);
    const fileBranches = Object.values(counters.branches ?? {}).flatMap((branch) => Object.values(branch));
    if ([...fileLines, ...fileBranches].some((hits) => !Number.isSafeInteger(hits) || hits < 0))
      throw new Error("Invalid Ruby coverage counter");
    files[path] = { lines: metric(fileLines), branches: metric(fileBranches) };
    lines.push(...fileLines);
    branches.push(...fileBranches);
  }
  if (!Object.keys(files).length || !lines.length) throw new Error("Ruby coverage has no production files");
  return {
    total: { lines: metric(lines), branches: metric(branches) },
    ...Object.fromEntries(Object.entries(files).sort()),
  };
}

export function writeRubyCoverage(report, root) {
  writeFileSync(
    join(root, "coverage/coverage-summary.json"),
    JSON.stringify(rubyCoverageSummary(report, root), null, 2) + "\n",
  );
}
