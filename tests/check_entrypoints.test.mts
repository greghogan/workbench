import { required } from "../src/invariants.ts";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { expect, test, vi } from "vitest";
import { runChecks, readChecks, inspectChecks, listChecks } from "../src/checks.ts";
import { planChecks } from "../src/check-plan.ts";
import { quote } from "../src/toolchains.ts";
import { stageFixtures } from "./fixtures/check-stages.mjs";

const distribution = resolve(import.meta.dirname, "..");

const fixture = stageFixtures();

test("checks executes by default while list, JSON, and excluded-plan inspection never execute", () => {
  const { root, events } = fixture();
  const invoke = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [join(distribution, "bundle/main.cjs"), "check", ...args, "--path", ".", "--role", "test"],
      {
        cwd: root,
        env: { ...process.env, WORKBENCH_PROJECT_ROOT: root },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  expect(invoke("--list")).toContain(". test");
  expect(JSON.parse(invoke("--json"))).toBeTruthy();
  expect(invoke("--all")).toContain(". test");
  expect(existsSync(join(root, "events"))).toBe(false);
  expect(existsSync(join(root, "dependency"))).toBe(false);
  invoke();
  expect(events()).toEqual(["setup", "test"]);
});

test.skipIf(process.platform === "win32")(
  "a copied reference Makefile runs selected commands without a parent Makefile",
  () => {
    const { root, events, clear } = fixture();
    copyFileSync(join(distribution, "examples/languages/typescript/Makefile"), join(root, "Makefile"));
    const make = (role: string) =>
      spawnSync(
        "make",
        [
          "--no-print-directory",
          `WORKBENCH=${quote(process.execPath)} ${quote(join(distribution, "bundle/main.cjs"))}`,
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

test("project selection includes descendants, isolates siblings and rejects empty or invalid plans", async () => {
  const { root, events, config, save, clear } = fixture();
  await runChecks(root, { role: ["build"], project: "service" });
  expect(events("service")).toEqual(["setup", "build"]);
  expect(events("service/worker")).toEqual(["setup", "build"]);
  expect(existsSync(join(root, "events"))).toBe(false);
  expect(existsSync(join(root, "web/events"))).toBe(false);
  clear();
  for (const options of [
    { role: ["build"], stage: "ci" },
    { role: ["build"], project: "missing" },
    { role: ["build"], project: "service", path: "web" },
    { stage: "commti" },
    { role: ["build"], environment: "nix-docker" },
  ])
    await expect(runChecks(root, options)).rejects.toThrow();
  expect(existsSync(join(root, "events"))).toBe(false);
  required(config.check[0], "Expected fixture value: config.check[0]").stages = [];
  save();
  await expect(runChecks(root, { path: "." })).rejects.toThrow(/setup is excluded/);
  expect(existsSync(join(root, "events"))).toBe(false);
  config.check = config.check.filter((check) => check.role === "setup");
  save();
  await expect(runChecks(root)).rejects.toThrow(/no configured check commands/);
});

test.skipIf(process.platform === "win32")(
  "one unchanged Makefile builds all roots or a named project and newly registered descendants",
  () => {
    const { root, config, save, events, clear } = fixture();
    copyFileSync(join(distribution, "Makefile"), join(root, "Makefile"));
    const original = readFileSync(join(root, "Makefile"));
    const make = (...args: string[]) => {
      const result = spawnSync(
        "make",
        [
          "--no-print-directory",
          `WORKBENCH=${quote(process.execPath)} ${quote(join(distribution, "bundle/main.cjs"))}`,
          ...args,
        ],
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
    const registry = parse(readFileSync(registryPath, "utf8")) as {
      project: { id: string; path: string }[];
      language_root: { path: string; language: string }[];
    };
    required(registry.project, "Expected fixture value: registry.project").push({ id: "jobs", path: "service/jobs" });
    required(registry.language_root, "Expected fixture value: registry.language_root").push({
      path: "service/jobs",
      language: "typescript",
    });
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
    required(
      config.check.find((check) => check.name === "web build"),
      'Expected fixture value: config.check.find((check) => check.name === "web build")',
    ).command[2] = "release";
    save();
    clear();
    make("build/web");
    expect(events("web")).toEqual(["setup", "release"]);
    expect(readFileSync(join(root, "Makefile"))).toEqual(original);
  },
);

test("one active Dev Container shell checks every workspace root with its selected native tools", async () => {
  const { root, events } = fixture();
  vi.stubEnv("WORKBENCH_DEVCONTAINER", "1");
  vi.stubEnv("WORKBENCH_SHELL_ENVIRONMENT", "devcontainer");
  vi.stubEnv("WORKBENCH_SHELL_ROOT", root);
  vi.stubEnv("WORKBENCH_PROJECT_ROOT", root);
  await runChecks(root);
  for (const path of [".", "service", "service/worker", "web"]) expect(events(path)).toEqual(["setup", "test"]);
});

test("inspection resolves the execution plan, including coverage, setup, exclusions, and provenance", () => {
  const { root } = fixture();
  const selected = { path: ".", stage: "ci", operatingSystem: "linux" };
  const execution = planChecks(root, readChecks(root), selected);
  const inspected = inspectChecks(root, selected);
  expect(inspected.stage).toBe("ci");
  expect(inspected.structuralValidation).toBe(true);
  expect(inspected.selected.map(({ name, role, command }) => ({ name, role, command }))).toEqual(
    execution.sessions.flatMap(({ checks }) => checks.map(({ name, role, command }) => ({ name, role, command }))),
  );
  expect(inspected.selected.map(({ role }) => role)).toEqual(["setup", "coverage"]);
  expect(inspected.selected.every(({ source }) => source === `project: ${join(root, "workbench/config.toml")}`)).toBe(
    true,
  );
  expect(inspected.excluded).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: ". build", reason: "excluded from ci stage" }),
      expect.objectContaining({ name: "web test", reason: "outside selected scope" }),
    ]),
  );
  expect(inspectChecks(root, { path: ".", role: ["test"] }).structuralValidation).toBe(false);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    listChecks(root, { ...selected, json: true });
    expect(JSON.parse(String(required(log.mock.calls[0], "Expected fixture value: log.mock.calls[0]")[0]))).toEqual(
      inspected,
    );
    log.mockClear();
    listChecks(root, { ...selected, all: true });
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Excluded checks:");
    expect(output).toContain("SOURCE");
    expect(output).toContain("coverage");
    expect(existsSync(join(root, "events"))).toBe(false);
  } finally {
    log.mockRestore();
  }
});
