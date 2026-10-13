import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import coverage from "istanbul-lib-coverage";
import { test, vi } from "vitest";
import { coverageChange, normalizedSummary, reportCoverageChange } from "../scripts/coverage-summary.mjs";

const fileCoverage = (path, count) => ({
  path,
  statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } },
  fnMap: {
    0: {
      name: "value",
      decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
      loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
      line: 1,
    },
  },
  branchMap: {},
  s: { 0: count },
  f: { 0: count },
  b: {},
});

test("coverage changes use relative paths and report regressions, additions, removals, and an absent baseline", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-summary-"));
  try {
    const map = (entries) =>
      coverage.createCoverageMap(
        Object.fromEntries(
          entries.map(([file, count]) => {
            const path = join(root, "src", file);
            return [path, fileCoverage(path, count)];
          }),
        ),
      );
    const before = normalizedSummary(
      map([
        ["z.ts", 1],
        ["removed.ts", 1],
      ]),
      root,
    );
    const after = normalizedSummary(
      map([
        ["z.ts", 0],
        ["added.ts", 1],
      ]),
      root,
    );
    assert.deepEqual(Object.keys(after), ["total", "src/added.ts", "src/z.ts"]);
    assert.equal(JSON.stringify(after).includes(root), false);
    const delta = coverageChange(after, before, "HEAD");
    assert.match(delta, /src\/z.ts \| lines \| 100% \(1\/1\) \| 0% \(0\/1\) \| -100.00 pp/);
    assert.match(delta, /src\/added.ts.*added/);
    assert.match(delta, /src\/removed.ts.*removed/);
    assert.match(coverageChange(after, undefined, "HEAD"), /No committed coverage summary.*HEAD/);
    assert.match(coverageChange(after, after, "HEAD"), /total \| lines.*0.00 pp/);
    assert.equal(coverageChange(after, after, "HEAD").includes("src/z.ts"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage presents the selected committed baseline in console output and the CI job summary", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-summary-git-"));
  const consoleOutput = vi.spyOn(console, "log").mockImplementation(() => {});
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Coverage fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Coverage fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    mkdirSync(join(root, "coverage"));
    const source = join(root, "src/value.ts");
    const map = (count) => coverage.createCoverageMap({ [source]: fileCoverage(source, count) });
    const summaryPath = join(root, "coverage/coverage-summary.json");
    const jobSummary = join(root, "job-summary.md");
    git("init", "-q");
    writeFileSync(summaryPath, JSON.stringify(normalizedSummary(map(1), root)));
    git("add", "coverage/coverage-summary.json");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Coverage baseline");
    const revision = git("rev-parse", "HEAD");
    // An uncommitted or previously generated summary must not replace the committed comparison baseline.
    writeFileSync(summaryPath, JSON.stringify(normalizedSummary(map(0), root)));
    reportCoverageChange(map(0), root, summaryPath, { revision, jobSummary });
    assert.match(consoleOutput.mock.calls.at(-1)[0], /-100.00 pp/);
    assert.match(readFileSync(jobSummary, "utf8"), new RegExp(revision));
    assert.match(readFileSync(jobSummary, "utf8"), /-100.00 pp/);
    assert.equal(JSON.parse(readFileSync(summaryPath, "utf8"))["src/value.ts"].lines.covered, 0);
    assert.throws(
      () => reportCoverageChange(map(0), root, summaryPath, { revision: "--help" }),
      /invalid coverage baseline/,
    );
  } finally {
    consoleOutput.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
