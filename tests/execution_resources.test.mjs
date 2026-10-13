import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, availableParallelism } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { executionEnvironment, executionResources, allocateCPUs } from "../src/execution-resources.ts";
import { cpuBudget, cpuEnvironment, builderCPUArguments } from "../scripts/cpu-budget.mjs";
import { builderCPUArguments as exampleBuilderCPUArguments } from "../examples/languages/go/scripts/resources.mjs";
import { CILifecycle } from "../src/ci-lifecycle.ts";
import { withCacheLock, withCacheLockSync } from "../src/cache-lock.ts";
import { runCIWorkers } from "../src/local-ci-workers.ts";

const temporary = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(settings = "") {
  const root = mkdtempSync(join(tmpdir(), "workbench-execution-"));
  temporary.push(root);
  mkdirSync(join(root, "workbench"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    `schema_version = 1\n[markdown]\nwrap_width = 120\n[compatibility]\nrequired = false\n${settings}`,
  );
  return root;
}

test("validated project CPU budgets bound concurrency and propagate one allocation to language tools", () => {
  vi.stubEnv("WORKBENCH_CPUS", undefined);
  const root = fixture("[execution]\ncpus_per_job = 4\n");
  const available = availableParallelism();
  const cpus = Math.min(4, available);
  expect(executionResources(root, 49)).toEqual({
    availableCpus: available,
    cpusPerJob: cpus,
    maxJobs: Math.min(49, Math.floor(available / cpus)),
  });
  expect(executionResources(root).maxJobs).toBe(1);
  expect(executionEnvironment(root).CMAKE_BUILD_PARALLEL_LEVEL).toBe(String(cpus));
  const capped = fixture(`[execution]\ncpus_per_job = ${available + 1}\nmax_jobs = 2\n`);
  expect(executionResources(capped, 49)).toEqual({ availableCpus: available, cpusPerJob: available, maxJobs: 1 });
  const limited = fixture("[execution]\ncpus_per_job = 1\nmax_jobs = 2\n");
  expect(executionResources(limited, 49).maxJobs).toBe(Math.min(2, available));
  vi.stubEnv("WORKBENCH_CPUS", "1");
  expect(executionResources(root, 49).cpusPerJob).toBe(1);
  expect(cpuBudget({ WORKBENCH_CPUS: "4" })).toBe(4);
  const env = cpuEnvironment(4, { GOFLAGS: "-mod=readonly -p=12" });
  expect(env.GOFLAGS).toBe("-mod=readonly -p=4");
  expect(cpuEnvironment(4, env)).toEqual(env);
  for (const key of [
    "CARGO_BUILD_JOBS",
    "NEXTEST_TEST_THREADS",
    "RUST_TEST_THREADS",
    "GOMAXPROCS",
    "CTEST_PARALLEL_LEVEL",
    "VCPKG_MAX_CONCURRENCY",
    "RAYON_NUM_THREADS",
    "UV_CONCURRENT_BUILDS",
    "PYTEST_XDIST_AUTO_NUM_WORKERS",
  ])
    expect(env[key]).toBe("4");
  for (const value of [0, -1, 1.5, "four", "", "0"])
    expect(() => cpuBudget({ WORKBENCH_CPUS: String(value) })).toThrow(/positive integer/);
  for (const settings of ["cpus_per_job = 0", "max_jobs = 1.5", "unknown = 4"])
    expect(() => executionResources(fixture(`[execution]\n${settings}\n`))).toThrow(/expected|unknown/);
});

test("cache locks serialize writers, release on failure, and preserve uncertain ownership", async () => {
  const root = fixture();
  const installation = join(root, "cache/tool");
  let active = 0;
  let peak = 0;
  const order = [];
  await Promise.all(
    [1, 2, 3].map((id) =>
      withCacheLock(installation, async () => {
        active++;
        peak = Math.max(peak, active);
        await delay(30);
        order.push(id);
        active--;
      }),
    ),
  );
  expect(peak).toBe(1);
  expect(order.toSorted()).toEqual([1, 2, 3]);
  expect(existsSync(`${installation}.lock`)).toBe(false);
  await expect(
    withCacheLock(installation, async () => {
      throw new Error("failure");
    }),
  ).rejects.toThrow("failure");
  expect(() =>
    withCacheLockSync(installation, () => {
      throw new Error("failure");
    }),
  ).toThrow("failure");
  expect(existsSync(`${installation}.lock`)).toBe(false);
  mkdirSync(`${installation}.lock`);
  writeFileSync(`${installation}.lock/owner.json`, "preserve");
  await expect(withCacheLock(installation, async () => {}, 1)).rejects.toThrow(/needs recovery/);
  expect(() => withCacheLockSync(installation, () => {}, 1)).toThrow(/needs recovery/);
  expect(readFileSync(`${installation}.lock/owner.json`, "utf8")).toBe("preserve");
  rmSync(`${installation}.lock`, { recursive: true });
  expect(() =>
    withCacheLockSync(installation, () => {
      writeFileSync(`${installation}.lock/owner.json`, "replaced ownership");
    }),
  ).toThrow(/ownership changed/);
  expect(readFileSync(`${installation}.lock/owner.json`, "utf8")).toBe("replaced ownership");
});

test("concurrent workers respect the job bound, retain logs, and finish independent jobs after a failure", async () => {
  const root = fixture();
  const events = join(root, "events.jsonl");
  writeFileSync(events, "");
  const script = join(root, "worker.mjs");
  writeFileSync(
    script,
    `import {appendFileSync} from 'node:fs';\nconst event = type => appendFileSync(process.env.EVENTS, JSON.stringify({type, id:process.env.JOB, cpus:process.env.WORKBENCH_CPUS})+'\\n');\nevent('start');\nawait new Promise(resolve => setTimeout(resolve, 200));\nevent('end');\nconsole.log('job '+process.env.JOB);\nif(process.env.JOB === '1') process.exitCode=1;\n`,
  );
  const finished = [];
  const workers = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    log: join(root, `${index}.log`),
    start: async () => ({
      command: process.execPath,
      args: [script],
      env: { ...process.env, ...cpuEnvironment(4), EVENTS: events, JOB: String(index) },
    }),
    finish: async (error) => {
      finished.push({ index, failed: !!error });
    },
  }));
  const lifecycle = new CILifecycle();
  try {
    await runCIWorkers(workers, 2, lifecycle);
  } finally {
    lifecycle.close();
  }
  let active = 0;
  let peak = 0;
  for (const event of readFileSync(events, "utf8").trim().split("\n").map(JSON.parse)) {
    active += event.type === "start" ? 1 : -1;
    peak = Math.max(peak, active);
    expect(active).toBeLessThanOrEqual(2);
    expect(event.cpus).toBe("4");
  }
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(finished).toHaveLength(5);
  expect(finished.filter((entry) => entry.failed)).toEqual([{ index: 1, failed: true }]);
  for (const [index, worker] of workers.entries()) expect(readFileSync(worker.log, "utf8")).toContain(`job ${index}`);
  expect(() => appendFileSync(join(root, "0.log"), "retained")).not.toThrow();
  await expect(runCIWorkers([], 0, lifecycle)).rejects.toThrow(/positive integer/);
});

test("CPU allocation is independent of host discovery and clamps small runners without oversubscribing job admission", () => {
  for (const [available, cpus, jobs] of [
    [1, 1, 1],
    [2, 2, 1],
    [6, 4, 1],
    [64, 4, 16],
  ])
    expect(allocateCPUs(available, 49)).toEqual({ availableCpus: available, cpusPerJob: cpus, maxJobs: jobs });
  expect(allocateCPUs(64, 3).maxJobs).toBe(3);
  expect(allocateCPUs(64, 49, { max_jobs: 8 }).maxJobs).toBe(8);
  expect(allocateCPUs(2, 49, { cpus_per_job: 8 }).cpusPerJob).toBe(2);
  expect(allocateCPUs(64, 49, { cpus_per_job: 8 }, "2")).toEqual({ availableCpus: 64, cpusPerJob: 2, maxJobs: 32 });
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => allocateCPUs(invalid, 1)).toThrow(/available CPUs/);
    expect(() => allocateCPUs(64, invalid)).toThrow(/selected CI jobs/);
    expect(() => allocateCPUs(64, 49, { max_jobs: invalid })).toThrow(/max_jobs/);
  }
});

test("managed builders receive their own CLI syntax and the standalone Go helper follows the same allocation contract", () => {
  const expected = { nix: ["--cores", "4", "--max-jobs", "1"], guix: ["--cores=4", "--max-jobs=1"] };
  for (const [builder, args] of Object.entries(expected)) {
    expect(builderCPUArguments(builder, 4)).toEqual(args);
    expect(exampleBuilderCPUArguments(builder, "4")).toEqual(args);
    for (const invalid of [0, -1, 1.5, "four", "9007199254740992"]) {
      expect(() => builderCPUArguments(builder, invalid)).toThrow(/positive integer/);
      expect(() => exampleBuilderCPUArguments(builder, invalid)).toThrow(/positive integer/);
    }
  }
  vi.stubEnv("WORKBENCH_CPUS", undefined);
  expect(exampleBuilderCPUArguments("nix")).toEqual([]);
  expect(() => builderCPUArguments("other", 4)).toThrow(/Unknown managed builder/);
});

test("cache installation and release failures retain both causes and preserve changed ownership", async () => {
  const root = fixture();
  const installation = join(root, "cache/tool");
  for (const runner of [withCacheLock, withCacheLockSync]) {
    const failure = new Error("installation failed");
    const action = () => {
      writeFileSync(`${installation}.lock/owner.json`, "changed owner");
      throw failure;
    };
    try {
      await runner(installation, action);
      throw new Error("expected both failures");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.message).toContain("installation failed");
      expect(error.message).toContain("ownership changed");
      expect(error.cause.message).toContain("ownership changed");
      expect(error.errors).toEqual([
        failure,
        expect.objectContaining({ message: expect.stringContaining("ownership changed") }),
      ]);
    }
    expect(readFileSync(`${installation}.lock/owner.json`, "utf8")).toBe("changed owner");
    rmSync(`${installation}.lock`, { recursive: true });
  }
});
