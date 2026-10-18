import { required } from "../src/invariants.ts";
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { runChecks, readChecks } from "../src/checks.ts";
import { planChecks, type CheckSelection } from "../src/check-plan.ts";
import { ciTargets } from "../src/ci-targets.ts";
import { ciMatrix } from "../src/ci.ts";
import { stageFixtures } from "./fixtures/check-stages.mjs";

const distribution = resolve(import.meta.dirname, "..");

const fixture = stageFixtures();

test("commit, CI and manual runs execute one test variant with fresh setup", async () => {
  const { root, events, clear, config, save } = fixture();
  await runChecks(root, { path: "." });
  expect(events()).toEqual(["setup", "test"]);
  clear();
  const alias = join(root, "checkout-alias");
  symlinkSync(root, alias, "junction");
  await runChecks(alias, { path: "." });
  expect(events()).toEqual(["setup", "test"]);
  clear();
  await runChecks(root, { path: ".", stage: "ci", operatingSystem: "linux" });
  expect(events()).toEqual(["setup", "coverage"]);
  expect(
    required(
      required(
        planChecks(root, readChecks(root), { path: ".", stage: "ci", operatingSystem: "linux" }).sessions[0],
        'Expected fixture value: planChecks(root, readChecks(root), { path: ".", stage: "ci", operatingSystem: "linux" }).sessions[0]',
      ).checks[1],
      'Expected fixture value: planChecks(root, readChecks(root), { path: ".", stage: "ci", operatingSystem: "linux" }).sessions[0]',
    ).warnSeconds,
  ).toBeUndefined();
  clear();
  await runChecks(root, { path: ".", stage: "ci", operatingSystem: "macos" });
  expect(events()).toEqual(["setup", "test"]);
  clear();
  required(
    required(config.check[1], "Expected fixture value: config.check[1]").coverage,
    'Fixture value required(config.check[1], "Expected fixture value: config.check[1]").c',
  ).stages = [];
  save();
  await expect(runChecks(root, { path: ".", role: ["coverage"], stage: "ci" })).rejects.toThrow(/no configured checks/);
  expect(existsSync(join(root, "events"))).toBe(false);
  await runChecks(root, { path: ".", role: ["coverage"] });
  expect(events()).toEqual(["setup", "coverage"]);
  clear();
  writeFileSync(join(root, "fail-coverage"), "fail");
  mkdirSync(join(root, "coverage"));
  const previous = '{"saved":"baseline"}\n';
  writeFileSync(join(root, "coverage/coverage-summary.json"), previous);
  writeFileSync(join(root, "emit-coverage"), "emit");
  await expect(runChecks(root, { path: ".", role: ["coverage"] })).rejects.toThrow(/failed/);
  expect(events()).toEqual(["setup", "coverage"]);
  expect(readFileSync(join(root, "coverage/coverage-summary.json"), "utf8")).toBe(previous);
});

test("language command suites retain gate stages, coverage variants, and manual commands", () => {
  const { root, config, save } = fixture();
  config.check = config.check.filter((check) => check.path !== "web");
  config.check_suite = [{ language: "typescript", path: "web" }];
  save();
  const checks = readChecks(root);
  const roles = (options: CheckSelection | undefined) =>
    required(
      planChecks(root, checks, { path: "web", environment: "native", ...options }).sessions[0],
      'Expected fixture value: planChecks(root, checks, { path: "web", environment: "native", ...options }).sessions[0]',
    ).checks.map((check) => check.role);
  expect(roles({ stage: "commit" })).toEqual(["setup", "format", "lint", "type", "coverage", "build", "docs"]);
  expect(roles({ role: ["test"] })).toEqual(["setup", "test"]);
  expect(roles({ role: ["release"] })).toEqual(["setup", "release"]);
  expect(roles({ role: ["clean"] })).toEqual(["clean"]);
  const ci = planChecks(root, checks, {
    path: "web",
    environment: "native",
    stage: "ci",
    operatingSystem: "linux",
    architecture: "x64",
  });
  expect(
    required(
      required(ci.sessions[0], "Expected fixture value: ci.sessions[0]").checks.find(
        (check) => check.role === "coverage",
      ),
      'Expected fixture value: ci.sessions[0].checks.find((check) => check.role === "coverage")',
    ).command,
  ).toEqual(["{packageManager}", "run", "coverage"]);
});

test.each(["c", "cpp"])(
  "%s keeps its LTO matrix in CI and explicit runs while release preparation stays selectable",
  (language) => {
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    const checks = readChecks(distribution);
    const roles = (selection: CheckSelection | undefined) =>
      planChecks(distribution, checks, {
        path: `examples/languages/${language}`,
        environment: "native",
        operatingSystem: "linux",
        architecture: "x64",
        toolchain: false,
        ...selection,
      }).sessions.flatMap((session) => session.checks.map((check) => check.role));
    const commit = roles({ stage: "commit" });
    expect(commit).toContain("coverage");
    expect(commit).not.toContain("lto");
    expect(roles({ stage: "ci" })).toContain("lto");
    expect(roles({ role: ["lto"] })).toEqual(["lto"]);
    expect(roles({ role: ["release"] })).toEqual(["release"]);
  },
);

test("CI coverage selectors preserve commit coverage and execute one selected variant", async () => {
  const { root, config, save, events, clear } = fixture();
  const coverage = required(config.check[1], "Expected fixture value: config.check[1]").coverage;
  delete required(coverage, "Fixture value coverage").stages;
  delete required(coverage, "Fixture value coverage").operating_systems;
  required(coverage, "Fixture value coverage").ci = {
    operating_systems: ["linux"],
    architectures: ["x64"],
    toolchain: false,
  };
  save();
  for (const operatingSystem of ["linux", "macos", "windows"]) {
    await runChecks(root, { path: ".", operatingSystem });
    expect(events()).toEqual(["setup", "coverage"]);
    clear();
  }
  for (const [operatingSystem, architecture, expected] of [
    ["linux", "x64", "coverage"],
    ["linux", "arm64", "test"],
    ["macos", "arm64", "test"],
    ["windows", "x64", "test"],
  ] as const) {
    await runChecks(root, { path: ".", stage: "ci", operatingSystem, architecture });
    expect(events()).toEqual(["setup", expected]);
    clear();
  }
  await runChecks(root, { path: ".", role: ["test"] });
  expect(events()).toEqual(["setup", "test"]);

  config.toolchains = { profiles: [{ name: "alternate", paths: ["."], tools: { node: "22.23.3" } }] };
  required(coverage, "Fixture value coverage").ci = {
    operating_systems: ["linux"],
    architectures: ["x64"],
    toolchain: "alternate",
  };
  save();
  const roles = (toolchain: string | false, environment = "native") =>
    required(
      planChecks(root, readChecks(root), {
        path: ".",
        stage: "ci",
        operatingSystem: "linux",
        architecture: "x64",
        toolchain,
        environment,
      }).sessions[0],
      'Expected fixture value: planChecks(root, readChecks(root), { path: ".", stage: "ci", operatingSystem: "linux", architecture:',
    ).checks.map((check) => check.role);
  expect(roles("alternate")).toEqual(["setup", "coverage"]);
  expect(roles(false)).toEqual(["setup", "test"]);
  expect(roles("alternate", "nix")).toEqual(["setup", "test"]);
  Reflect.deleteProperty(required(coverage, "Fixture value coverage").ci as object, "toolchain");
  save();
  expect(roles("alternate")).toEqual(["setup", "coverage"]);
  expect(roles(false)).toEqual(["setup", "coverage"]);
});

test("reference roots retain one Linux x64 CI coverage target across compiler and runtime profiles", () => {
  const targets = ciTargets(distribution);
  const owners = targets.filter((target) => target.checks.some((check) => check.role === "coverage"));
  const coverageChecks = readChecks(distribution).filter((check) => check.coverage?.stages.includes("ci"));
  expect(owners).toHaveLength(coverageChecks.length);
  expect(new Set(owners.map((target) => target.path)).size).toBe(owners.length);
  expect(
    owners.every(
      (target) =>
        target.kind === "native" && target.os === "linux" && target.architecture === "x64" && !target.toolchain,
    ),
  ).toBe(true);
  expect(targets.some((target) => target.kind === "native" && target.toolchain)).toBe(true);
  const configured = readChecks(distribution);
  for (const operatingSystem of ["macos", "windows"]) {
    const plan = planChecks(distribution, configured, {
      path: "examples/languages/php",
      environment: "native",
      operatingSystem,
      toolchain: false,
    });
    expect(
      required(plan.sessions[0], "Expected fixture value: plan.sessions[0]").checks.some(
        (check: { role: string }) => check.role === "test",
      ),
    ).toBe(true);
    expect(
      required(plan.sessions[0], "Expected fixture value: plan.sessions[0]").checks.some(
        (check: { role: string }) => check.role === "coverage",
      ),
    ).toBe(false);
  }
  expect(
    targets
      .filter((target) => target.kind === "native" && target.toolchain)
      .every((target) => target.checks.some((check) => check.role === "test")),
  ).toBe(true);
});

test("invalid or unreachable CI coverage selectors fail explicitly", () => {
  const { root, config, save } = fixture();
  const coverage = required(config.check[1], "Expected fixture value: config.check[1]").coverage;
  for (const ci of [
    { architectures: [] },
    { architectures: ["riscv64"] },
    { architectures: ["x64", "x64"] },
    { operating_systems: [] },
    { environments: [] },
    { toolchain: true },
    { toolchain: "" },
    { unknown: "x64" },
  ]) {
    required(coverage, "Fixture value coverage").ci = ci;
    save();
    expect(() => readChecks(root)).toThrow(/coverage|architectures|toolchain|unknown/);
  }
  required(coverage, "Fixture value coverage").ci = { architectures: ["arm64"] };
  save();
  expect(() => ciMatrix(root)).toThrow(/no matching matrix target/);
});

test("invalid schedules and unreachable CI coverage are rejected", () => {
  const { root, config, save } = fixture();
  const coverage = required(config.check[1], "Expected fixture value: config.check[1]").coverage;
  required(coverage, "Fixture value coverage").operating_systems = ["windows"];
  save();
  expect(() => ciMatrix(root)).toThrow(/no matching matrix target/);
  required(coverage, "Fixture value coverage").operating_systems = ["linux"];
  for (const stages of [["commti"], ["ci", "ci"], "ci"]) {
    required(config.check[1], "Expected fixture value: config.check[1]").stages = stages;
    save();
    expect(() => readChecks(root)).toThrow(/stages/);
  }
  required(config.check[1], "Expected fixture value: config.check[1]").stages = ["commit"];
  save();
  expect(() => readChecks(root)).toThrow(/coverage stages/);
});

test("container coverage selection follows the Linux target on a macOS host", () => {
  const { root, config, save } = fixture();
  for (const check of config.check) if (check.coverage) check.coverage.environments = ["devcontainer"];
  save();
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { ...original, value: "darwin" });
    const plan = planChecks(root, readChecks(root), { path: ".", stage: "ci", environment: "devcontainer" });
    expect(
      required(plan.sessions[0], "Expected fixture value: plan.sessions[0]").checks.map(({ role }) => role),
    ).toEqual(["setup", "coverage"]);
  } finally {
    Object.defineProperty(process, "platform", required(original, "Fixture value original"));
  }
});
