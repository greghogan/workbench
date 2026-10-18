import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { planChecks } from "../src/check-plan.ts";
import { readChecks } from "../src/checks.ts";
import { CheckReport, writeCheckReport, checkReportDestination } from "../src/check-report.ts";
import { checkDetailPrefix } from "../scripts/check-detail-data.mjs";
import { stageFixtures } from "./fixtures/check-stages.mjs";

const fixture = stageFixtures();
const distribution = resolve(import.meta.dirname, "..");

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
  const data: unknown = JSON.parse(readFileSync(report, "utf8"));
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
  const logs = /Full check logs: (.+)/.exec(result.stdout)?.[1]?.trim();
  expect(logs).toBeTruthy();
  expect(existsSync(join(logs ?? "", "results.json"))).toBe(true);
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
    { status: "pending" },
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
    checks: [{ status: "failed" }, { status: "pending" }, { status: "pending" }],
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
  expect(JSON.parse(readFileSync(join(root, "coverage-report.json"), "utf8"))).toMatchObject({
    success: true,
    runs: [
      {
        checks: [
          { role: "setup" },
          {
            role: "coverage",
            status: "passed",
            details: [{ version: 1, kind: "coverage", current: { lines: { total: 2, covered: 1, pct: 50 } } }],
          },
        ],
      },
    ],
  });
  writeFileSync(join(root, "fail-coverage"), "fail");
  const failed = invoke("failure-report.json");
  expect(failed.status).not.toBe(0);
  expect(JSON.parse(readFileSync(join(root, "failure-report.json"), "utf8"))).toMatchObject({
    success: false,
    runs: [{ status: "failed", checks: [{ status: "passed" }, { role: "coverage", status: "failed" }] }],
  });
});

test("oversized diagnostic records remain in logs and produce a visible omission count", () => {
  const { root } = fixture();
  const step = join(root, "step.cjs");
  writeFileSync(
    step,
    readFileSync(step, "utf8") +
      `\nif (mode === 'test') console.log(${JSON.stringify(checkDetailPrefix)} + JSON.stringify({version: 1, kind: 'slow', scope: 'test', name: 'x'.repeat(70000), elapsedSeconds: 3, thresholdSeconds: 2}));\n`,
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
  expect(JSON.parse(readFileSync(join(root, "report.json"), "utf8"))).toMatchObject({
    success: true,
    runs: [{ checks: [{ role: "setup" }, { role: "test", details: [], omittedDetails: 1 }] }],
  });
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
    `if (process.argv[2] === 'test') {console.log(${JSON.stringify(checkDetailPrefix + JSON.stringify(detail))}); process.exitCode = 9;}`,
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
  expect(result.status).not.toBe(0);
  expect(JSON.parse(readFileSync(join(root, "report.json"), "utf8"))).toMatchObject({
    success: false,
    error: expect.stringContaining("failed") as unknown,
    runs: [
      {
        status: "failed",
        error: expect.stringContaining("failed") as unknown,
        checks: [{ status: "passed" }, { status: "failed", details: [detail] }],
      },
    ],
  });
});
