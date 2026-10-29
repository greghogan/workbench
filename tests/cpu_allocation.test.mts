import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { executionEnvironment, executionResources } from "../src/execution-resources.ts";
import { cpuBudget, cpuEnvironment } from "../scripts/cpu-budget.mjs";
import { forwardedCIEnvironment } from "../scripts/ci-layout.mjs";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workbench-cpu-allocation-"));
  mkdirSync(join(root, "workbench"));
  writeFileSync(join(root, "workbench/config.toml"), "schema_version=1\n");
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "preferences"));
  for (const name of ["WORKBENCH_CPUS", "WORKBENCH_CPU_BUDGET", "WORKBENCH_MAX_JOBS"]) vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function inherit(env: NodeJS.ProcessEnv) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

test("an automatic development shell budget leaves nested check groups concurrent", () => {
  const shell = executionEnvironment(root);
  expect(shell.WORKBENCH_CPU_BUDGET).toBe("32");
  expect(shell.WORKBENCH_CPUS).toBeUndefined();
  expect(cpuBudget(shell)).toBe(32);
  inherit(shell);
  expect(executionResources(root, 9)).toEqual({ availableCpus: 32, cpusPerJob: 4, maxJobs: 8 });
  expect(executionResources(root)).toEqual({ availableCpus: 32, cpusPerJob: 32, maxJobs: 1 });
});

test("nested jobs divide their assigned budget without exceeding it", () => {
  inherit(cpuEnvironment(8));
  expect(executionResources(root, 9)).toEqual({ availableCpus: 8, cpusPerJob: 4, maxJobs: 2 });
  inherit(cpuEnvironment(2));
  expect(executionResources(root, 9)).toEqual({ availableCpus: 2, cpusPerJob: 2, maxJobs: 1 });
  expect(cpuEnvironment(32).WORKBENCH_CPU_BUDGET).toBe("2");
  expect(cpuBudget()).toBe(2);
});

test("explicit requests survive shell entry and can be changed even to the inherited budget", () => {
  vi.stubEnv("WORKBENCH_CPUS", "8");
  expect(executionResources(root, 9)).toEqual({ availableCpus: 32, cpusPerJob: 8, maxJobs: 4 });
  const shell = executionEnvironment(root);
  expect(shell).toMatchObject({ WORKBENCH_CPU_BUDGET: "8", WORKBENCH_CPUS: "8" });
  inherit(shell);
  vi.stubEnv("WORKBENCH_CPUS", "2");
  expect(executionResources(root, 9)).toEqual({ availableCpus: 8, cpusPerJob: 2, maxJobs: 4 });
  expect(cpuBudget()).toBe(2);
  vi.stubEnv("WORKBENCH_CPUS", "8");
  expect(executionResources(root, 9).maxJobs).toBe(1);
  vi.stubEnv("WORKBENCH_CPUS", "64");
  expect(executionResources(root).cpusPerJob).toBe(8);
  expect(cpuBudget()).toBe(8);
});

test("checkout preferences and job limits remain effective inside an automatic shell", () => {
  inherit(executionEnvironment(root));
  writeFileSync(join(root, "workbench/local.toml"), "[execution]\ncpus_per_job=2\nmax_jobs=3\n");
  expect(executionResources(root, 9)).toEqual({ availableCpus: 32, cpusPerJob: 2, maxJobs: 3 });
  vi.stubEnv("WORKBENCH_MAX_JOBS", "1");
  expect(executionResources(root, 9).maxJobs).toBe(1);
});

test("forwarded CI allocations keep the ceiling separate from an optional explicit request", () => {
  const automatic = cpuEnvironment(4);
  expect(forwardedCIEnvironment(automatic)).toContain("WORKBENCH_CPU_BUDGET=4");
  expect(forwardedCIEnvironment(automatic).some((value) => value.startsWith("WORKBENCH_CPUS="))).toBe(false);
  const explicit = cpuEnvironment(4, { WORKBENCH_CPUS: "8" });
  expect(forwardedCIEnvironment(explicit)).toContain("WORKBENCH_CPUS=8");
  expect(cpuBudget(explicit)).toBe(4);
});

test.each(["", "0", "-1", "1.5", "many"])("invalid inherited CPU budget %j is rejected", (budget) => {
  vi.stubEnv("WORKBENCH_CPU_BUDGET", budget);
  expect(() => executionResources(root, 9)).toThrow(/WORKBENCH_CPU_BUDGET/);
  expect(() => cpuBudget()).toThrow(/WORKBENCH_CPU_BUDGET/);
});
