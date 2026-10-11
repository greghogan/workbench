import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createRunReport,
  parseRunReport,
  runReportedTarget,
  runSucceeded,
  runSummary,
  writeRunReport,
} from "../scripts/ci-results.mjs";
import { targetPhases, targetEnvironment } from "../scripts/ci-contract.mjs";
import { ciCacheEnvironment, forwardedCIEnvironment } from "../scripts/ci-layout.mjs";

const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "workbench-ci-results-"));
  temporary.push(path);
  return path;
}

test("result protocol accepts exactly the selected targets and normalizes guest report paths", () => {
  const run = createRunReport(["one", "two"], "/guest");
  run.targets[0].started = "2026-10-10T00:00:00.000Z";
  run.targets[0].finished = "2026-10-10T00:00:01.000Z";
  run.targets[0].success = true;
  delete run.targets[0].error;
  const parsed = parseRunReport(run, ["one", "two"], "/host");
  expect(parsed.targets.map(({ report }) => report.startsWith("/host/"))).toEqual([true, true]);
  expect(parsed.targets.map(({ success }) => success)).toEqual([true, false]);
  expect(() => createRunReport(["one", "one"], "/guest")).toThrow(/unique/);
  for (const mutate of [
    (r) => {
      r.targets.pop();
    },
    (r) => {
      r.targets.push(r.targets[0]);
    },
    (r) => {
      r.targets[0].id = "unselected";
    },
    (r) => {
      r.targets[0] = null;
    },
    (r) => {
      r.targets[0].success = "yes";
    },
    (r) => {
      r.targets[0].error = "contradicts success";
    },
    (r) => {
      r.targets[1].error = 42;
    },
    (r) => {
      r.targets[0].finished = "not a date";
    },
    (r) => {
      delete r.targets[0].started;
    },
    (r) => {
      r.errors.push({ phase: "cleanup", message: 42 });
    },
    (r) => {
      r.extra = true;
    },
    (r) => {
      r.version = 2;
    },
  ]) {
    const invalid = structuredClone(run);
    mutate(invalid);
    expect(() => parseRunReport(invalid, ["one", "two"], "/host")).toThrow(/invalid target results/);
  }
});

test("shared attempts retain partial evidence and atomically persist target and infrastructure outcomes", () => {
  const root = fixture();
  const coverage = join(root, "coverage");
  mkdirSync(coverage);
  writeFileSync(join(coverage, "baseline"), "unchanged");
  const run = createRunReport(["success", "failure"], root);
  runReportedTarget(run, "success", coverage, () => {
    writeFileSync(join(coverage, "new"), "evidence");
  });
  runReportedTarget(run, "failure", coverage, () => {
    writeFileSync(join(coverage, "partial"), "evidence");
    throw new Error("test failed");
  });
  expect(run.targets.map(({ success }) => success)).toEqual([true, false]);
  expect(readdirSync(join(run.targets[0].report, "coverage"))).toEqual(["new"]);
  expect(readdirSync(join(run.targets[1].report, "coverage"))).toEqual(["partial"]);
  expect(run.targets[1].error).toBe("test failed");
  run.errors.push({ phase: "cleanup:containers", message: "container still running" });
  const path = join(root, "results.json");
  writeRunReport(path, run);
  writeRunReport(path, run);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(run);
  expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(runSucceeded(run)).toBe(false);
  expect(runSummary(run, root)).toContain("1/2 Linux x64 targets passed; 1 infrastructure errors");
});

test.skipIf(process.platform === "win32")(
  "report collection failures remain distinct from successful command execution",
  () => {
    const root = fixture();
    const coverage = join(root, "coverage");
    const run = createRunReport(["one"], root);
    runReportedTarget(run, "one", coverage, () => {
      mkdirSync(coverage);
      symlinkSync("missing", join(coverage, "unsafe"));
    });
    expect(run.targets[0].success).toBe(false);
    expect(run.targets[0].error).toContain("Report collection failed");
    expect(run.errors).toEqual([expect.objectContaining({ phase: "reports:one" })]);
    let called = false;
    runReportedTarget(run, "one", coverage, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(run.targets[0].error).toContain("only real files");
  },
);

test("phase definitions and forwarded caches preserve runtime, compiler, release and isolation selections", () => {
  expect(targetPhases({ kind: "native", release: true })).toEqual(["native-install", "native-check", "release"]);
  expect(targetPhases({ kind: "native", release: false })).toEqual(["native-install", "native-check"]);
  for (const runtime of ["clang", "gcc"])
    expect(targetPhases({ kind: "compatibility", runtime })).toEqual(["compiler-install", "compiler"]);
  expect(targetPhases({ kind: "compatibility", runtime: "python" })).toEqual(["python"]);
  for (const runtime of ["node", "go", "rust"])
    expect(targetPhases({ kind: "compatibility", runtime })).toEqual(["compatibility"]);
  expect(targetPhases({ kind: "environment" })).toEqual(["environment"]);
  expect(() => targetPhases({ kind: "other" })).toThrow(/Unknown/);
  expect(() => targetPhases({ kind: "compatibility", runtime: "other" })).toThrow(/Unknown/);
  const env = ciCacheEnvironment("/cache", "/data", true);
  expect(env.CARGO_HOME).toBe("/cache/ci/cargo");
  expect(env.UV_PYTHON_INSTALL_DIR).toBe("/cache/uv-python/python");
  expect(ciCacheEnvironment("/cache").CARGO_HOME).toBeUndefined();
  expect(forwardedCIEnvironment({ ...env, SECRET: "private", WORKBENCH_CI_TARGET: "one" })).toEqual(
    Object.entries({ ...env, WORKBENCH_CI_TARGET: "one" }).flatMap(([name, value]) => [
      "--remote-env",
      `${name}=${value}`,
    ]),
  );
  expect(
    targetEnvironment({
      kind: "compatibility",
      id: "one",
      path: "app",
      runtime: "gcc",
      version: "16.2.0",
      roles: ["test", "lto"],
    }).CHECK_ROLES,
  ).toBe('["test","lto"]');
});

test("an unavailable target report directory does not cancel independent targets", () => {
  const root = fixture();
  const run = createRunReport(["blocked", "next"], root);
  writeFileSync(run.targets[0].report, "occupied");
  let attempted = false;
  runReportedTarget(run, "blocked", join(root, "coverage"), () => {
    attempted = true;
  });
  runReportedTarget(run, "next", join(root, "coverage"), () => {});
  expect(attempted).toBe(false);
  expect(run.targets.map(({ success }) => success)).toEqual([false, true]);
  expect(run.errors).toEqual([expect.objectContaining({ phase: "reports:blocked" })]);
});
