import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, expect, test, vi } from "vitest";
import { runChecks, readChecks } from "../src/checks.ts";
import { planChecks } from "../src/check-plan.ts";
import { ciMatrix } from "../src/ci.ts";

const distribution = resolve(import.meta.dirname, "..");
const temporary = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-stages-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  mkdirSync(join(root, "workbench"));
  const paths = [".", "service", "service/worker", "web"];
  const projects = paths.map((path, index) => ({ id: ["demo", "service", "worker", "web"][index], path }));
  writeFileSync(
    join(root, "workbench/projects.toml"),
    stringify({
      project: projects,
      language_root: paths.map((path) => ({ path, language: "typescript" })),
    }),
  );
  const config = {
    schema_version: 1,
    markdown: { wrap_width: 120 },
    compatibility: { required: false },
    check: [],
    ci: { operating_systems: ["linux", "macos"], environments: [] },
  };
  for (const path of paths) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(
      join(root, path, "step.cjs"),
      `
const fs = require('node:fs');
const mode = process.argv[2];
if (mode === 'setup') fs.writeFileSync('dependency', 'ready');
else if (fs.readFileSync('dependency', 'utf8') !== 'ready') process.exit(9);
fs.appendFileSync('events', mode + '\\n');
if (mode === 'coverage' && fs.existsSync('emit-coverage')) {
  fs.mkdirSync('coverage', {recursive: true});
  const metric = {total: 2, covered: 1, skipped: 0, pct: 50};
  fs.writeFileSync('coverage/coverage-summary.json', JSON.stringify({total: {lines: metric}, 'value.ts': {lines: metric}}));
}
if (mode === 'coverage' && fs.existsSync('fail-coverage')) process.exit(31);
`,
    );
    const command = (mode) => [process.execPath, "step.cjs", mode];
    config.check.push(
      { name: `${path} setup`, role: "setup", path, command: command("setup") },
      {
        name: `${path} test`,
        role: "test",
        path,
        command: command("test"),
        warn_seconds: 2,
        coverage: {
          command: command("coverage"),
          stages: ["ci"],
          operating_systems: ["linux"],
          environments: ["native"],
        },
      },
      { name: `${path} build`, role: "build", path, command: command("build"), stages: [] },
    );
  }
  const save = () => writeFileSync(join(root, "workbench/config.toml"), stringify(config));
  save();
  const events = (path = ".") =>
    readFileSync(join(root, path, "events"), "utf8")
      .trim()
      .split("\n");
  const clear = () => {
    for (const path of paths)
      for (const file of ["events", "dependency"]) rmSync(join(root, path, file), { force: true });
  };
  return { root, config, save, events, clear };
}

test("commit, CI and manual runs execute one test variant with fresh setup", () => {
  const { root, events, clear, config, save } = fixture();
  runChecks(root, { path: "." });
  expect(events()).toEqual(["setup", "test"]);
  clear();
  runChecks(root, { path: ".", stage: "ci", operatingSystem: "linux" });
  expect(events()).toEqual(["setup", "coverage"]);
  expect(
    planChecks(root, readChecks(root), { path: ".", stage: "ci", operatingSystem: "linux" }).sessions[0].checks[1]
      .warnSeconds,
  ).toBeUndefined();
  clear();
  runChecks(root, { path: ".", stage: "ci", operatingSystem: "macos" });
  expect(events()).toEqual(["setup", "test"]);
  clear();
  config.check[1].coverage.stages = [];
  save();
  expect(() => runChecks(root, { path: ".", role: "coverage", stage: "ci" })).toThrow(/no configured checks/);
  expect(existsSync(join(root, "events"))).toBe(false);
  runChecks(root, { path: ".", role: "coverage" });
  expect(events()).toEqual(["setup", "coverage"]);
  clear();
  writeFileSync(join(root, "fail-coverage"), "fail");
  mkdirSync(join(root, "coverage"));
  const previous = '{"saved":"baseline"}\n';
  writeFileSync(join(root, "coverage/coverage-summary.json"), previous);
  writeFileSync(join(root, "emit-coverage"), "emit");
  expect(() => runChecks(root, { path: ".", role: "coverage" })).toThrow(/failed/);
  expect(events()).toEqual(["setup", "coverage"]);
  expect(readFileSync(join(root, "coverage/coverage-summary.json"), "utf8")).toBe(previous);
});

test("language command suites retain gate stages, coverage variants, and manual commands", () => {
  const { root, config, save } = fixture();
  config.check = config.check.filter((check) => check.path !== "web");
  config.check_suite = [{ language: "typescript", path: "web" }];
  save();
  const checks = readChecks(root);
  const roles = (options) =>
    planChecks(root, checks, { path: "web", environment: "native", ...options }).sessions[0].checks.map(
      (check) => check.role,
    );
  expect(roles({ stage: "commit" })).toEqual(["setup", "format", "lint", "type", "test", "build", "docs"]);
  expect(roles({ role: "release" })).toEqual(["setup", "release"]);
  expect(roles({ role: "clean" })).toEqual(["clean"]);
  const ci = planChecks(root, checks, { path: "web", environment: "native", stage: "ci", operatingSystem: "linux" });
  expect(ci.sessions[0].checks.find((check) => check.role === "coverage").command).toEqual([
    "{packageManager}",
    "run",
    "coverage",
  ]);
});

test.skipIf(process.platform === "win32")(
  "a copied reference Makefile runs selected commands without a parent Makefile",
  () => {
    const { root, events, clear } = fixture();
    copyFileSync(join(distribution, "examples/languages/typescript/Makefile"), join(root, "Makefile"));
    const make = (role) =>
      spawnSync(
        "make",
        [
          "--no-print-directory",
          `WORKBENCH=${process.execPath} ${join(distribution, "bundle/main.cjs")}`,
          "ROOT=web",
          role,
        ],
        { cwd: root, env: { ...process.env, WORKBENCH_PROJECT_ROOT: root }, encoding: "utf8" },
      );
    for (const role of ["test", "coverage"]) {
      const result = make(role);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(events("web")).toEqual(["setup", role]);
      expect(existsSync(join(root, "events"))).toBe(false);
      clear();
    }
    writeFileSync(join(root, "web/fail-coverage"), "fail");
    const result = make("coverage");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/failed/);
    expect(events("web")).toEqual(["setup", "coverage"]);
  },
);

test("project selection includes descendants, isolates siblings and rejects empty or invalid plans", () => {
  const { root, events, config, save, clear } = fixture();
  runChecks(root, { role: "build", project: "service" });
  expect(events("service")).toEqual(["setup", "build"]);
  expect(events("service/worker")).toEqual(["setup", "build"]);
  expect(existsSync(join(root, "events"))).toBe(false);
  expect(existsSync(join(root, "web/events"))).toBe(false);
  clear();
  for (const options of [
    { role: "build", stage: "ci" },
    { role: "build", project: "missing" },
    { role: "build", project: "service", path: "web" },
    { stage: "commti" },
    { role: "build", environment: "nix-docker" },
  ])
    expect(() => runChecks(root, options)).toThrow();
  expect(existsSync(join(root, "events"))).toBe(false);
  config.check[0].stages = [];
  save();
  expect(() => runChecks(root, { path: "." })).toThrow(/setup is excluded/);
  expect(existsSync(join(root, "events"))).toBe(false);
  config.check = config.check.filter((check) => check.role === "setup");
  save();
  expect(() => runChecks(root)).toThrow(/no configured check commands/);
});

test("invalid schedules and unreachable CI coverage are rejected", () => {
  const { root, config, save } = fixture();
  const coverage = config.check[1].coverage;
  coverage.operating_systems = ["windows"];
  save();
  expect(() => ciMatrix(root)).toThrow(/no matching matrix target/);
  coverage.operating_systems = ["linux"];
  for (const stages of [["commti"], ["ci", "ci"], "ci"]) {
    config.check[1].stages = stages;
    save();
    expect(() => readChecks(root)).toThrow(/stages/);
  }
  config.check[1].stages = ["commit"];
  save();
  expect(() => readChecks(root)).toThrow(/coverage stages/);
});

test.skipIf(process.platform === "win32")(
  "one unchanged Makefile builds all roots or a named project and newly registered descendants",
  () => {
    const { root, config, save, events, clear } = fixture();
    copyFileSync(join(distribution, "Makefile"), join(root, "Makefile"));
    const original = readFileSync(join(root, "Makefile"));
    const make = (...args) => {
      const result = spawnSync(
        "make",
        ["--no-print-directory", `WORKBENCH=${process.execPath} ${join(distribution, "bundle/main.cjs")}`, ...args],
        {
          cwd: root,
          env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    make();
    for (const path of [".", "service", "service/worker", "web"]) expect(events(path)).toEqual(["setup", "build"]);
    clear();
    const registryPath = join(root, "workbench/projects.toml");
    const registry = parse(readFileSync(registryPath, "utf8"));
    registry.project.push({ id: "jobs", path: "service/jobs" });
    registry.language_root.push({ path: "service/jobs", language: "typescript" });
    writeFileSync(registryPath, stringify(registry));
    mkdirSync(join(root, "service/jobs"));
    copyFileSync(join(root, "step.cjs"), join(root, "service/jobs/step.cjs"));
    config.check.push(
      ...config.check
        .filter((check) => check.path === ".")
        .map((check) => ({
          ...check,
          name: `jobs ${check.role}`,
          path: "service/jobs",
        })),
    );
    save();
    make("build/service");
    expect(events("service")).toEqual(["setup", "build"]);
    expect(events("service/worker")).toEqual(["setup", "build"]);
    expect(events("service/jobs")).toEqual(["setup", "build"]);
    expect(existsSync(join(root, "web/events"))).toBe(false);
    clear();
    make("build", "PROJECT=web");
    expect(events("web")).toEqual(["setup", "build"]);
    expect(existsSync(join(root, "service/events"))).toBe(false);
    clear();
    make("build", "ROOT=service/worker");
    expect(events("service/worker")).toEqual(["setup", "build"]);
    expect(existsSync(join(root, "service/events"))).toBe(false);
    // Changing the configured operation changes Make's result without changing the wrapper.
    config.check.find((check) => check.name === "web build").command[2] = "release";
    save();
    clear();
    make("build/web");
    expect(events("web")).toEqual(["setup", "release"]);
    expect(readFileSync(join(root, "Makefile"))).toEqual(original);
  },
);

test("container coverage selection follows the Linux target on a macOS host", () => {
  const { root, config, save } = fixture();
  for (const check of config.check) if (check.coverage) check.coverage.environments = ["devcontainer"];
  save();
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { ...original, value: "darwin" });
    const plan = planChecks(root, readChecks(root), { path: ".", stage: "ci", environment: "devcontainer" });
    expect(plan.sessions[0].checks.map(({ role }) => role)).toEqual(["setup", "coverage"]);
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("one active Dev Container shell checks every workspace root with its selected native tools", () => {
  const { root, events } = fixture();
  vi.stubEnv("WORKBENCH_DEVCONTAINER", "1");
  vi.stubEnv("WORKBENCH_SHELL_ENVIRONMENT", "devcontainer");
  vi.stubEnv("WORKBENCH_SHELL_ROOT", root);
  vi.stubEnv("WORKBENCH_PROJECT_ROOT", root);
  runChecks(root);
  for (const path of [".", "service", "service/worker", "web"]) expect(events(path)).toEqual(["setup", "test"]);
});
