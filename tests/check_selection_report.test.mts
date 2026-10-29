import { Writable } from "node:stream";
import { readLog } from "../src/log-storage.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { planChecks } from "../src/check-plan.ts";
import { readChecks } from "../src/check-configuration.ts";
import { CheckReport, writeCheckReport, checkReportDestination, type CheckRunResult } from "../src/check-report.ts";
import { required } from "../src/invariants.ts";
import { checkDetailPrefix, type CheckDetail } from "../scripts/check-detail-data.mjs";
import { stageFixtures } from "./fixtures/check-stages.mjs";

const fixture = stageFixtures();
const distribution = resolve(import.meta.dirname, "..");

function contractDetails(report: { runs: CheckRunResult[] }, role: string): CheckDetail[] {
  const run = required(report.runs[0], "Expected fixture run");
  const check = required(
    run.checks.find((check) => check.role === role),
    `Expected ${role} check`,
  );
  return check.details.filter((detail) => detail.kind !== "slow" || detail.scope !== "suite");
}

function emitFixtureSuiteWarning(root: string): CheckDetail {
  const warning: CheckDetail = {
    version: 1,
    kind: "slow",
    scope: "suite",
    name: "fixture suite warning",
    elapsedSeconds: 3,
    thresholdSeconds: 2,
  };
  const step = join(root, "step.cjs");
  writeFileSync(
    step,
    readFileSync(step, "utf8") +
      `\nif (mode !== 'setup') console.log(${JSON.stringify(checkDetailPrefix + JSON.stringify(warning))});\n`,
  );
  return warning;
}

test("role unions preserve configured order and insert setup once; exclusions retain safe stage defaults", () => {
  const { root, config, save } = fixture();
  config.check.push({
    name: "cleanup",
    path: ".",
    role: "clean",
    stages: [],
    command: [process.execPath, "step.cjs", "clean"],
  });
  save();
  const checks = readChecks(root);
  const roles = (selection: Parameters<typeof planChecks>[2]) =>
    planChecks(root, checks, { path: ".", ...selection }).sessions.flatMap((session) =>
      session.checks.map((check) => check.role),
    );
  expect(roles({ role: ["build", "test", "build", "setup"] })).toEqual(["setup", "test", "build"]);
  expect(roles({ excludeRole: ["build"] })).toEqual(["setup", "test"]);
  expect(roles({ role: ["build", "test"], excludeRole: ["coverage"] })).toEqual(["setup", "test", "build"]);
  expect(roles({ role: ["clean"] })).toEqual(["clean"]);
  for (const selection of [
    { role: ["typo"] },
    { excludeRole: ["typo"] },
    { role: ["test"], excludeRole: ["test"] },
    { role: ["clean", "test"] },
    { role: ["test"], excludeRole: ["setup"] },
  ]) {
    expect(() => roles(selection)).toThrow();
  }
});

test("CI-only target filters select compatible variants without restricting manual execution", () => {
  const { root, config, save } = fixture();
  const build = required(
    config.check.find((check) => check.name === ". build"),
    "Missing build fixture",
  );
  build.stages = ["ci"];
  build.ci = { operating_systems: ["linux"], architectures: ["x64"], environments: ["native"] };
  save();
  const roles = (selection: Parameters<typeof planChecks>[2]) =>
    planChecks(root, readChecks(root), {
      path: ".",
      environment: "native",
      ...selection,
    }).sessions.flatMap((session) => session.checks.map((check) => check.role));
  expect(roles({ stage: "ci", operatingSystem: "linux", architecture: "x64" })).toContain("build");
  expect(roles({ stage: "ci", operatingSystem: "macos", architecture: "x64" })).not.toContain("build");
  expect(roles({ stage: "ci", operatingSystem: "linux", architecture: "arm64" })).not.toContain("build");
  expect(roles({ stage: "ci", operatingSystem: "linux", architecture: "x64", environment: "guix" })).not.toContain(
    "build",
  );
  expect(roles({ role: ["build"], operatingSystem: "macos", architecture: "arm64" })).toEqual(["setup", "build"]);
  build.ci.architectures = [];
  save();
  expect(() => readChecks(root)).toThrow(/CI targets must not be empty/);
});

test("the real CLI accepts repeatable selection flags, writes execution reports, and refuses overwrites", () => {
  const { root, events } = fixture();
  const report = join(root, "report.json");
  const invoke = (...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), "check", "--path", ".", ...args], {
      cwd: root,
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
      encoding: "utf8",
    });
  const result = invoke("--role", "build", "--role", "test", "--exclude-role", "coverage", "--report", report);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(events()).toEqual(["setup", "test", "build"]);
  const data = JSON.parse(readFileSync(report, "utf8")) as { runs: CheckRunResult[] };
  expect(data).toMatchObject({
    version: 1,
    kind: "workbench-check-report",
    success: true,
    runs: [
      {
        status: "passed",
        checks: [
          { role: "setup", status: "passed", durationMs: expect.any(Number) as unknown },
          { role: "test", status: "passed" },
          { role: "build", status: "passed" },
        ],
      },
    ],
  });
  const logs = required(data.runs[0]?.logs, "Missing retained check logs in the execution report");
  expect(result.stderr).toContain("Full check logs:");
  expect(existsSync(join(logs, "results.json"))).toBe(true);
  const again = invoke("--role", "test", "--report", report);
  expect(again.status).not.toBe(0);
  expect(again.stderr).toContain("already exists");
  expect(events()).toEqual(["setup", "test", "build"]);
  expect(invoke("--role", "test", "--report", join(root, "unused.json"), "--json").status).not.toBe(0);
});

test("execution records retain partial failure, cancellation, bounded details and elapsed time", () => {
  const { root } = fixture();
  const plan = planChecks(root, readChecks(root), { path: ".", role: ["test", "build"] });
  let clock = 10;
  const report = new CheckReport("id", plan, () => clock);
  report.event(0, 1, "start");
  clock = 25;
  report.event(0, 1, "pass");
  report.event(0, 2, "start");
  const line =
    checkDetailPrefix +
    JSON.stringify({
      version: 1,
      kind: "slow",
      scope: "test",
      name: "nested test",
      elapsedSeconds: 3,
      thresholdSeconds: 2,
    });
  report.detail(0, line);
  report.detail(0, line);
  expect(report.result.checks[1]?.details).toHaveLength(1);
  for (let i = 1; i < 34; i++) report.detail(0, line.replace("nested test", `nested test ${String(i)}`));
  expect(() => {
    report.detail(0, checkDetailPrefix + "{}");
  }).not.toThrow(); // Already full; omitted records are counted.
  clock = 30;
  report.finish(false, true);
  expect(report.result.status).toBe("cancelled");
  expect(report.result.checks).toMatchObject([
    { status: "passed", durationMs: 15 },
    { status: "cancelled", durationMs: 5, omittedDetails: 3 },
    { status: "cancelled" },
  ]);
  expect(report.result.checks[1]?.details).toHaveLength(32);
  const failed = new CheckReport("failure", plan);
  failed.event(0, 1, "start");
  expect(() => {
    failed.detail(0, checkDetailPrefix + "{}");
  }).toThrow("version");
  failed.event(0, 1, "fail");
  failed.finish(false, false);
  expect(failed.result).toMatchObject({
    status: "failed",
    checks: [{ status: "failed" }, { status: "blocked" }, { status: "blocked" }],
  });
});

test("report publication is atomic and preserves an existing destination", () => {
  const { root } = fixture();
  const path = join(root, "report.json");
  checkReportDestination(path);
  writeCheckReport(path, { version: 1 });
  expect(readFileSync(path, "utf8")).toBe('{\n  "version": 1\n}\n');
  expect(() => {
    checkReportDestination(path);
  }).toThrow("already exists");
  expect(() => {
    writeCheckReport(path, {});
  }).toThrow();
  expect(readFileSync(path, "utf8")).toContain('"version": 1');
});

test("execution reports contain coverage data and preserve the failed check on a nonzero exit", () => {
  const { root } = fixture();
  const warning = emitFixtureSuiteWarning(root);
  writeFileSync(join(root, "emit-coverage"), "emit");
  const invoke = (name: string) =>
    spawnSync(
      process.execPath,
      [
        join(distribution, "bundle/main.cjs"),
        "check",
        "--path",
        ".",
        "--role",
        "coverage",
        "--report",
        join(root, name),
      ],
      { cwd: root, env: { ...process.env, WORKBENCH_PROJECT_ROOT: root }, encoding: "utf8" },
    );
  const passed = invoke("coverage-report.json");
  expect(passed.status, passed.stdout + passed.stderr).toBe(0);
  expect(passed.stdout).toContain("Coverage vs HEAD: lines 50% (change unavailable)");
  expect(passed.stdout).not.toMatch(/Check details:|Coverage root:|\| Source \|/);
  expect(passed.stdout.indexOf("Coverage vs HEAD:")).toBeLessThan(passed.stdout.indexOf("Passed 2/2 checks"));
  const report = JSON.parse(readFileSync(join(root, "coverage-report.json"), "utf8")) as { runs: CheckRunResult[] };
  expect(report).toMatchObject({
    success: true,
    runs: [
      {
        checks: [
          { role: "setup" },
          {
            role: "coverage",
            status: "passed",
          },
        ],
      },
    ],
  });
  expect(contractDetails(report, "coverage")).toMatchObject([
    { version: 1, kind: "coverage", current: { lines: { total: 2, covered: 1, pct: 50 } } },
  ]);
  expect(report.runs[0]?.checks[1]?.details).toContainEqual(warning);
  writeFileSync(join(root, "fail-coverage"), "fail");
  const failed = invoke("failure-report.json");
  expect(failed.status).not.toBe(0);
  expect(JSON.parse(readFileSync(join(root, "failure-report.json"), "utf8"))).toMatchObject({
    success: false,
    runs: [{ status: "failed", checks: [{ status: "passed" }, { role: "coverage", status: "failed" }] }],
  });
});

test("oversized diagnostic records remain in logs and produce a visible omission count", async () => {
  const { root } = fixture();
  const step = join(root, "step.cjs");
  const oversizedName = "x".repeat(70000);
  const retained = {
    version: 1,
    kind: "slow",
    scope: "suite",
    name: "fixture warning",
    elapsedSeconds: 3,
    thresholdSeconds: 2,
  };
  writeFileSync(
    step,
    readFileSync(step, "utf8") +
      `\nif (mode === 'test') {
        console.log(${JSON.stringify(checkDetailPrefix + JSON.stringify(retained))});
        console.log(${JSON.stringify(checkDetailPrefix)} + JSON.stringify({version: 1, kind: 'slow', scope: 'test', name: 'x'.repeat(70000), elapsedSeconds: 3, thresholdSeconds: 2}));
      }\n`,
  );
  const result = spawnSync(
    process.execPath,
    [
      join(distribution, "bundle/main.cjs"),
      "check",
      "--path",
      ".",
      "--role",
      "test",
      "--report",
      join(root, "report.json"),
    ],
    { cwd: root, env: { ...process.env, WORKBENCH_PROJECT_ROOT: root }, encoding: "utf8" },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain("1 check details omitted");
  const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8")) as { runs: CheckRunResult[] };
  expect(report).toMatchObject({
    success: true,
    runs: [{ checks: [{ role: "setup" }, { role: "test", omittedDetails: 1 }] }],
  });
  const run = required(report.runs[0], "Expected fixture run");
  const check = required(
    run.checks.find((check) => check.role === "test"),
    "Expected fixture check",
  );
  expect(check.details).toContainEqual(retained);
  // A loaded host may also emit a real suite timing advisory; the oversized test detail must be omitted.
  expect(check.details.every((detail) => detail.kind === "slow" && detail.scope === "suite")).toBe(true);
  const chunks: Buffer[] = [];
  await readLog(
    required(run.groups[0]?.stdout, "Expected stdout log"),
    new Writable({
      write(bytes: Buffer, _encoding, callback) {
        chunks.push(bytes);
        callback();
      },
    }),
  );
  expect(Buffer.concat(chunks).toString("utf8")).toContain(oversizedName);
});

test("failed commands retain structured diagnostics replayed after their failure event", () => {
  const { root } = fixture();
  const detail = {
    version: 1,
    kind: "slow",
    scope: "test",
    name: "failed test",
    elapsedSeconds: 3,
    thresholdSeconds: 2,
  };
  writeFileSync(
    join(root, "step.cjs"),
    `const mode=process.argv[2]; if (mode === 'test') {console.log(${JSON.stringify(checkDetailPrefix + JSON.stringify(detail))}); process.exitCode = 9;}`,
  );
  const warning = emitFixtureSuiteWarning(root);
  const result = spawnSync(
    process.execPath,
    [
      join(distribution, "bundle/main.cjs"),
      "check",
      "--path",
      ".",
      "--role",
      "test",
      "--report",
      join(root, "report.json"),
    ],
    { cwd: root, env: { ...process.env, WORKBENCH_PROJECT_ROOT: root }, encoding: "utf8" },
  );
  expect(result.status).not.toBe(0);
  const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8")) as { runs: CheckRunResult[] };
  expect(report).toMatchObject({
    success: false,
    error: expect.stringContaining("failed") as unknown,
    runs: [
      {
        status: "failed",
        error: expect.stringContaining("failed") as unknown,
        checks: [{ status: "passed" }, { status: "failed" }],
      },
    ],
  });
  expect(contractDetails(report, "test")).toEqual([detail]);
  expect(report.runs[0]?.checks[1]?.details).toContainEqual(warning);
});

test("run finalization stamps a running check with a terminal time and stable duration", () => {
  const report = new CheckReport(
    "terminal",
    {
      sessions: [{ directory: ".", environment: "native", checks: [{ name: "work", role: "test" }] }],
    } as unknown as ConstructorParameters<typeof CheckReport>[1],
    () => 25,
    () => "2026-10-26T00:00:00.000Z",
  );
  report.event(0, 1, "start");
  report.finish(false, true);
  expect(report.result.checks[0]).toMatchObject({
    status: "cancelled",
    finished: "2026-10-26T00:00:00.000Z",
    durationMs: 0,
  });
});

test("a started group becomes failed rather than blocked during exceptional run finalization", () => {
  const report = new CheckReport("failed-group", {
    sessions: [{ directory: ".", environment: "native", checks: [] }],
  } as unknown as ConstructorParameters<typeof CheckReport>[1]);
  report.startGroup(0, "stdout.log", "stderr.log");
  report.finish(false, false);
  expect(report.result.groups[0]?.status).toBe("failed");
  expect(typeof report.result.groups[0]?.finished).toBe("string");
});

test("automatic CI never inserts setup excluded by the current CI target; manual selection remains available", () => {
  const { root, config, save } = fixture();
  const setup = required(
    config.check.find((check) => check.role === "setup" && check.path === "."),
    "Missing setup fixture",
  );
  setup.ci = { architectures: ["arm64"] };
  save();
  expect(() =>
    planChecks(root, readChecks(root), {
      path: ".",
      stage: "ci",
      environment: "native",
      operatingSystem: "linux",
      architecture: "x64",
    }),
  ).toThrow(/required setup.*excludes this architecture/);
  expect(
    planChecks(root, readChecks(root), { path: ".", role: ["build"], architecture: "x64" }).sessions.flatMap(
      (session) => session.checks.map((check) => check.role),
    ),
  ).toEqual(["setup", "build"]);
});
