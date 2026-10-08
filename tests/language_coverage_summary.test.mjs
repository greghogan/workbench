import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { readCoverageSummary } from "../scripts/check-coverage-summary.mjs";

test("language coverage summaries translate native reports without inventing unavailable metrics", () => {
  const repository = mkdtempSync(join(tmpdir(), "workbench-language-coverage-"));
  const root = join(repository, "project");
  const output = join(root, "coverage");
  try {
    mkdirSync(output, { recursive: true });
    assert.equal(readCoverageSummary(root), undefined);
    const llvm = {
      lines: { count: 3, covered: 2 },
      functions: { count: 2, covered: 1 },
      branches: { count: 4, covered: 3 },
    };
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify({ data: [{ totals: llvm, files: [{ filename: "/work/project/src/value.c", summary: llvm }] }] }),
    );
    let summary = readCoverageSummary(root, repository);
    assert.deepEqual(Object.keys(summary), ["total", "src/value.c"]);
    assert.equal(summary.total.lines.pct, 66.66);
    assert.equal(summary.total.functions.covered, 1);
    assert.equal(summary.total.branches.covered, 3);
    const python = { num_statements: 3, covered_lines: 2, num_branches: 4, covered_branches: 3 };
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify({ totals: python, files: { "src/value.py": { summary: python } } }),
    );
    summary = readCoverageSummary(root);
    assert.equal(summary.total.lines.pct, 66.66);
    assert.equal(summary.total.branches.pct, 75);
    assert.equal(Object.hasOwn(summary.total, "functions"), false);
    rmSync(join(output, "report.json"));
    writeFileSync(join(root, "go.mod"), "module example.com/project\n");
    writeFileSync(
      join(output, "profile.out"),
      "mode: atomic\nexample.com/project/value.go:1.1,2.1 2 0\nexample.com/project/value.go:1.1,2.1 2 1\nexample.com/project/value.go:3.1,4.1 1 0\n",
    );
    summary = readCoverageSummary(root);
    assert.deepEqual(summary.total, { statements: { total: 3, covered: 2, skipped: 0, pct: 66.66 } });
    assert.deepEqual(summary["value.go"], summary.total);
    rmSync(join(output, "profile.out"));
    writeFileSync(
      join(output, "coverage-summary.json"),
      JSON.stringify({ total: summary.total, [join(root, "src/value.ts")]: summary.total }),
    );
    assert.deepEqual(Object.keys(readCoverageSummary(root)), ["total", "src/value.ts"]);
    utimesSync(join(output, "coverage-summary.json"), 1, 1);
    assert.equal(readCoverageSummary(root, root, Date.now()), undefined);
    writeFileSync(join(output, "report.json"), "{}");
    assert.throws(() => readCoverageSummary(root), /unsupported coverage\/report.json/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
