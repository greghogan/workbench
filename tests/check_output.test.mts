import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { checkDetailPrefix } from "../scripts/check-detail-data.mjs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  checkOutput,
  checkOutputPrelude,
  checkLogDirectory,
  checkFailureExcerpt,
  checkDetailLines,
} from "../src/check-output.ts";
afterEach(() => vi.unstubAllEnvs());

const shellModes = ["command", "file"] as const;
type ShellMode = (typeof shellModes)[number];
function runScript(root: string, script: string, mode: ShellMode) {
  const path = join(root, "checks.sh");
  if (mode === "file") writeFileSync(path, script);
  return spawnSync("sh", ["-eu", ...(mode === "file" ? [path] : ["-c", script])], {
    env: { ...process.env, WORKBENCH_BUILD_DIR: root },
    encoding: "utf8",
  });
}

test("completion details present compact coverage deltas and sanitize warning text", () => {
  const metric = (pct: number) => ({ total: 100, covered: pct, skipped: 0, pct });
  expect(
    checkDetailLines({
      version: 1,
      kind: "coverage",
      root: ".",
      revision: "HEAD",
      current: { lines: metric(80.94), branches: metric(71) },
      baseline: { lines: metric(80.63), branches: metric(70.64) },
    }),
  ).toEqual(["Coverage vs HEAD: lines 80.94% (+0.31 pp); branches 71% (+0.36 pp)"]);
  expect(
    checkDetailLines({
      version: 1,
      kind: "coverage",
      root: ".",
      revision: "HEAD",
      notice: "partial",
      current: { lines: metric(50) },
    }),
  ).toEqual(["partial", "Coverage vs HEAD: lines 50% (change unavailable); no committed baseline"]);
  expect(
    checkDetailLines({
      version: 1,
      kind: "slow",
      scope: "suite",
      name: "advisory\u001b[2J\nname",
      elapsedSeconds: 3,
      thresholdSeconds: 2,
    }),
  ).toEqual(["SLOW suite advisory name: 3.00s (soft cap 2s; advisory only)"]);
  expect(checkDetailLines({ version: 1, kind: "coverage-unavailable", root: ".", reason: "no baseline" })).toEqual([
    "Coverage change unavailable: no baseline",
  ]);
});

test.each(["/efs/devel/workbench", "C:\\Users\\developer\\workbench", "/"])(
  "log archive paths safely identify checkout %s",
  (checkout) => {
    const base = tmpdir();
    const path = checkLogDirectory(base, checkout, "examples/python", "run");
    const inside = relative(base, path);
    expect(isAbsolute(inside)).toBe(false);
    expect(inside.startsWith("..")).toBe(false);
    expect(inside).not.toContain(":");
    expect(path).not.toBe(checkLogDirectory(base, checkout, ".", "run"));
  },
);

test("failure excerpts omit protocol noise and bound large logs while preserving their cause", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-check-excerpt-"));
  try {
    const log = join(root, "failure.log");
    const contents =
      "unrelated earlier output\n".repeat(2000) +
      "WORKBENCH_CHECK_EVENT\tstart\t2\n" +
      checkDetailPrefix +
      JSON.stringify({ version: 1, kind: "coverage-unavailable", root: "fixture", reason: "test fixture" }) +
      "\n" +
      "compiler: missing required library\n";
    writeFileSync(log, contents);
    const excerpt = await checkFailureExcerpt(log);
    expect(excerpt).toContain("Earlier output omitted");
    expect(excerpt).toContain("compiler: missing required library");
    expect(excerpt).not.toContain("WORKBENCH_CHECK_EVENT");
    expect(excerpt).not.toContain(checkDetailPrefix);
    expect(excerpt.split("\n").length).toBeLessThanOrEqual(42);
    expect(Buffer.byteLength(excerpt)).toBeLessThan(8300);
    expect(readFileSync(log, "utf8")).toBe(contents);
    writeFileSync(log, "short failure\n");
    expect(await checkFailureExcerpt(log)).toBe("short failure\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.each(shellModes)("%s shell execution", (mode) => {
  test.each([false, true])("check output preserves successful results with verbose=%s", (verbose) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-check-output-"));
    try {
      const commands = [
        "printf 'private command output\\n'",
        "printf '%s\\n' '" +
          checkDetailPrefix +
          JSON.stringify({
            version: 1,
            kind: "slow",
            scope: "suite",
            name: "advisory",
            elapsedSeconds: 3,
            thresholdSeconds: 2,
          }) +
          "'",
        "printf 'Coverage root: nested-fixture\\n| total | lines | fake | fake | fake |\\n'",
      ];
      const result = runScript(
        root,
        [
          ...checkOutputPrelude(4, verbose, "run"),
          ...checkOutput(commands, "test", 2, verbose, [
            "printf 'Coverage root: .\\n| total | lines | 90 | 100 | +10 pp |\\n'",
          ]),
        ].join("\n"),
        mode,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("[2/4 completed] Passed test");
      expect(result.stdout).toContain(checkDetailPrefix);
      expect(result.stdout).toContain("| total | lines | 90 | 100 | +10 pp |");
      if (verbose) expect(result.stdout).toContain("private command output");
      else {
        expect(result.stdout).not.toContain("private command output");
        expect(result.stdout).not.toContain("nested-fixture");
        expect(result.stdout).not.toContain("fake | fake");
        const logs = join(root, "check-logs/run");
        expect(
          readFileSync(join(logs, required(readdirSync(logs)[0], "Fixture value readdirSync(logs)[0]")), "utf8"),
        ).toContain("private command output");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([false, true])("check failure keeps its exit code and diagnostics with verbose=%s", (verbose) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-check-output-"));
    try {
      const result = runScript(
        root,
        [
          ...checkOutputPrelude(2, verbose, "run"),
          ...checkOutput(["printf 'failure cause\\n' >&2", "false", "echo must-not-run"], "test", 1, verbose),
        ].join("\n"),
        mode,
      );
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain("failure cause");
      expect(result.stdout + result.stderr).not.toContain("must-not-run");
      expect(result.stdout).not.toContain("Passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("concise checks retain setup exports in the shared session", () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-check-state-"));
    try {
      const script = [
        ...checkOutputPrelude(2, false, "run"),
        ...checkOutput(["export SHARED_CHECK_INPUT=42"], "setup", 1, false),
        ...checkOutput(['test "$SHARED_CHECK_INPUT" = 42'], "test", 2, false),
      ];
      const result = runScript(root, script.join("\n"), mode);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("[2/2 completed] Passed test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("worker events remain separate from unterminated output (verbose=%s, failure=%s)", (verbose, failure) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-check-events-"));
    vi.stubEnv("WORKBENCH_CHECK_EVENTS", "1");
    try {
      const commands = ["printf unterminated", ...(failure ? ["exit 29"] : [])];
      const result = runScript(
        root,
        [...checkOutputPrelude(1, verbose, "events"), ...checkOutput(commands, "test", 1, verbose)].join("\n"),
        mode,
      );
      expect(result.status, result.stderr).toBe(failure ? 29 : 0);
      expect(result.stdout.split(/\r?\n/).filter((line) => line.startsWith("WORKBENCH_CHECK_EVENT\t"))).toEqual([
        "WORKBENCH_CHECK_EVENT\tstart\t1",
        `WORKBENCH_CHECK_EVENT\t${failure ? "fail" : "pass"}\t1`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([0, 17])("presentation failures preserve their own cause and primary command status %s", (status) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-presentation-failure-"));
    try {
      const result = runScript(
        root,
        [
          ...checkOutputPrelude(1, false, "run"),
          ...checkOutput(
            ["printf 'original command output\\n'", `coverage_status=${String(status)}`],
            "coverage",
            1,
            false,
            [
              "workbench_check_replay=$coverage_status",
              "printf 'presentation failure cause\\n' >&2",
              `exit ${String(status || 23)}`,
            ],
          ),
        ].join("\n"),
        mode,
      );
      expect(result.status).toBe(status || 23);
      expect(result.stdout + result.stderr).toContain("presentation failure cause");
      if (status) expect(result.stdout).toContain("original command output");
      else expect(result.stdout).not.toContain("original command output");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failure control and diagnostics survive redirected commands", () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-script-exit-"));
    try {
      const token = "a".repeat(32);
      const script = [
        ...checkOutputPrelude(1, false, "run", token),
        ...checkOutput(["printf 'underlying failure\\n' >&2", "exit 23"], "fixture", 1, false),
      ].join("\n");
      const result = runScript(root, script, mode);
      expect(result.status).toBe(23);
      expect(result.stdout).toContain(`WORKBENCH_CHECK_CONTROL\t${token}\tfail\t1`);
      expect(result.stdout).toContain("underlying failure");
      expect(result.stdout + result.stderr).not.toContain("input file is output file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
