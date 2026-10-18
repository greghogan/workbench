import { required } from "../src/invariants.ts";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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
import { ciBuildCachePaths, ciCacheEnvironment, forwardedCIEnvironment } from "../scripts/ci-layout.mjs";

interface ReportInput {
  version: unknown;
  targets: (Record<string, unknown> | null | undefined)[];
  errors: unknown[];
  [key: string]: unknown;
}
const temporary: string[] = [];
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
  required(run.targets[0], "Expected fixture value: run.targets[0]").started = "2026-10-10T00:00:00.000Z";
  required(run.targets[0], "Expected fixture value: run.targets[0]").finished = "2026-10-10T00:00:01.000Z";
  required(run.targets[0], "Expected fixture value: run.targets[0]").success = true;
  delete required(run.targets[0], "Expected fixture value: run.targets[0]").error;
  const parsed = parseRunReport(run, ["one", "two"], "/host");
  expect(parsed.targets.map(({ report }) => report.startsWith(join("/host") + sep))).toEqual([true, true]);
  expect(parsed.targets.map(({ success }) => success)).toEqual([true, false]);
  expect(() => createRunReport(["one", "one"], "/guest")).toThrow(/unique/);
  for (const mutate of [
    (r: ReportInput) => {
      r.targets.pop();
    },
    (r: ReportInput) => {
      r.targets.push(r.targets[0]);
    },
    (r: ReportInput) => {
      required(r.targets[0], "Expected fixture value: r.targets[0]").id = "unselected";
    },
    (r: ReportInput) => {
      r.targets[0] = null;
    },
    (r: ReportInput) => {
      required(r.targets[0], "Expected fixture value: r.targets[0]").success = "yes";
    },
    (r: ReportInput) => {
      required(r.targets[0], "Expected fixture value: r.targets[0]").error = "contradicts success";
    },
    (r: ReportInput) => {
      required(r.targets[1], "Expected fixture value: r.targets[1]").error = 42;
    },
    (r: ReportInput) => {
      required(r.targets[0], "Expected fixture value: r.targets[0]").finished = "not a date";
    },
    (r: ReportInput) => {
      delete required(r.targets[0], "First result").started;
    },
    (r: ReportInput) => {
      r.errors.push({ phase: "cleanup", message: 42 });
    },
    (r: ReportInput) => {
      r.extra = true;
    },
    (r: ReportInput) => {
      r.version = 2;
    },
  ]) {
    const invalid: ReportInput = { ...structuredClone(run), targets: run.targets.map((target) => ({ ...target })) };
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
  expect(
    readdirSync(join(required(run.targets[0], "Expected fixture value: run.targets[0]").report, "coverage")),
  ).toEqual(["new"]);
  expect(
    readdirSync(join(required(run.targets[1], "Expected fixture value: run.targets[1]").report, "coverage")),
  ).toEqual(["partial"]);
  expect(required(run.targets[1], "Expected fixture value: run.targets[1]").error).toBe("test failed");
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
    expect(required(run.targets[0], "Expected fixture value: run.targets[0]").success).toBe(false);
    expect(required(run.targets[0], "Expected fixture value: run.targets[0]").error).toContain(
      "Report collection failed",
    );
    expect(run.errors).toEqual([expect.objectContaining({ phase: "reports:one" })]);
    let called = false;
    runReportedTarget(run, "one", coverage, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(required(run.targets[0], "Expected fixture value: run.targets[0]").error).toContain("only real files");
  },
);

test("phase definitions and forwarded caches preserve runtime, compiler, release and isolation selections", () => {
  expect(targetPhases({ kind: "native", release: true })).toEqual(["native-install", "native-check", "release"]);
  expect(targetPhases({ kind: "native", release: false })).toEqual(["native-install", "native-check"]);
  for (const runtime of ["clang", "gcc"] as const)
    expect(targetPhases({ kind: "compatibility", runtime, version: "1", roles: ["test"], release: false })).toEqual([
      "compiler-install",
      "compiler",
    ]);
  expect(
    targetPhases({ kind: "compatibility", runtime: "python", version: "1", roles: ["test"], release: false }),
  ).toEqual(["python"]);
  for (const runtime of ["node", "go", "rust"] as const)
    expect(targetPhases({ kind: "compatibility", runtime, version: "1", roles: ["test"], release: false })).toEqual([
      "compatibility",
    ]);
  expect(targetPhases({ kind: "environment", release: false })).toEqual(["environment"]);
  expect(() => {
    Reflect.apply(targetPhases, undefined, [{ kind: "other" }]);
  }).toThrow(/Unknown/);
  expect(() => {
    Reflect.apply(targetPhases, undefined, [{ kind: "compatibility", runtime: "other" }]);
  }).toThrow(/Unknown/);
  const env = ciCacheEnvironment("/cache", "/data", true);
  expect(env.CARGO_HOME).toBe(join("/cache", "ci", "cargo"));
  expect(env.UV_PYTHON_INSTALL_DIR).toBe(join("/cache", "uv-python", "python"));
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
      release: false,
      environment: "native",
      id: "one",
      path: "app",
      runtime: "gcc",
      version: "16.2.0",
      roles: ["test", "lto"],
    }).CHECK_ROLES,
  ).toBe('["test","lto"]');
});

test("Windows caches Python archives and rebuilds dependency trees containing junctions", () => {
  const windows = ciCacheEnvironment("/cache", "/data", true, "win32");
  expect(windows.UV_PYTHON_CACHE_DIR).toBe(join("/cache", "downloads", "uv-python"));
  expect(ciBuildCachePaths("/cache", "native", "win32")).toEqual([join("/cache", "go-build")]);
  const linux = ciCacheEnvironment("/cache", "/data", true, "linux");
  expect(linux.UV_PYTHON_CACHE_DIR).toBeUndefined();
  expect(ciBuildCachePaths("/cache", "devcontainer", "linux")).toEqual(
    ["builds", "go-build", "container-tools"].map((name) => join("/cache", name)),
  );
});

test("an unavailable target report directory does not cancel independent targets", () => {
  const root = fixture();
  const run = createRunReport(["blocked", "next"], root);
  writeFileSync(required(run.targets[0], "Expected fixture value: run.targets[0]").report, "occupied");
  let attempted = false;
  runReportedTarget(run, "blocked", join(root, "coverage"), () => {
    attempted = true;
  });
  runReportedTarget(run, "next", join(root, "coverage"), () => undefined);
  expect(attempted).toBe(false);
  expect(run.targets.map(({ success }) => success)).toEqual([false, true]);
  expect(run.errors).toEqual([expect.objectContaining({ phase: "reports:blocked" })]);
});

test("container CI forwarding keeps local credentials private and explicitly forwards the hosted job token", () => {
  expect(forwardedCIEnvironment({ GH_TOKEN: "local-private" })).toEqual([]);
  expect(forwardedCIEnvironment({ GITHUB_ACTIONS: "true", GH_TOKEN: "job-read-only", SECRET: "private" })).toEqual([
    "--remote-env",
    "GITHUB_ACTIONS=true",
    "--remote-env",
    "GH_TOKEN=job-read-only",
  ]);
});
