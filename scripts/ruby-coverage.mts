import type { FileSummary, Summary } from "../app/src/core/execution/checks/coverage-summary.mjs";
import { record, required } from "../app/src/core/runtime/values.mjs";
import { writeAtomic } from "../app/src/core/runtime/file-publication.mjs";
import { isAbsolute, join, relative } from "node:path";

const metric = (values: number[]) => ({
  total: values.length,
  covered: values.filter((hits: number) => hits > 0).length,
});

export function rubyCoverageSummary(report: unknown, root: string): Summary {
  const runs = Object.values(record(report, "Invalid SimpleCov report"));
  if (runs.length !== 1) throw new Error("Expected one fresh SimpleCov suite");
  const coverage = record(
    record(required(runs[0], "Missing SimpleCov suite"), "Invalid SimpleCov suite").coverage,
    "Missing SimpleCov coverage",
  );
  const files: Record<string, FileSummary> = {};
  for (const [absolute, value] of Object.entries(coverage)) {
    const counters = record(value, "Invalid SimpleCov file counters");
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (isAbsolute(path) || path.startsWith("../")) throw new Error("Ruby coverage source outside root");
    if (!path.startsWith("lib/") && !path.startsWith("bin/")) continue;
    if (!Array.isArray(counters.lines)) throw new Error("Invalid Ruby line counters");
    const counter = (hits: unknown): number => {
      if (typeof hits !== "number" || !Number.isSafeInteger(hits) || hits < 0)
        throw new Error("Invalid Ruby coverage counter");
      return hits;
    };
    const fileLines = counters.lines.filter((hits: unknown) => hits !== null).map(counter);
    const fileBranches = Object.values(record(counters.branches ?? {}, "Invalid Ruby branches")).flatMap((branch) =>
      Object.values(record(branch, "Invalid Ruby branch counters")).map(counter),
    );
    files[path] = { lines: metric(fileLines), branches: metric(fileBranches) };
  }
  if (!Object.values(files).some(({ lines }) => lines && lines.total > 0))
    throw new Error("Ruby coverage has no production files");
  return Object.fromEntries(Object.entries(files).sort());
}

export function writeRubyCoverage(report: unknown, root: string) {
  writeAtomic(
    join(root, "coverage/coverage-summary.json"),
    JSON.stringify(rubyCoverageSummary(report, root), null, 2) + "\n",
  );
}
