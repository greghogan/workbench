import { availableParallelism } from "node:os";

export function positiveInteger(value: unknown, location: string): number {
  const number = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new Error(`${location}: expected a positive integer`);
  return number;
}

/** A parent's assigned budget limits the aggregate work admitted by a nested coordinator. */
export function cpuCapacity(env: NodeJS.ProcessEnv = process.env): number {
  const available = availableParallelism();
  return env.WORKBENCH_CPU_BUDGET === undefined
    ? available
    : Math.min(available, positiveInteger(env.WORKBENCH_CPU_BUDGET, "WORKBENCH_CPU_BUDGET"));
}

/** Direct tools honor an explicit request within the inherited job's capacity. */
export function cpuBudget(env: NodeJS.ProcessEnv = process.env): number {
  const capacity = cpuCapacity(env);
  return env.WORKBENCH_CPUS === undefined
    ? capacity
    : Math.min(capacity, positiveInteger(env.WORKBENCH_CPUS, "WORKBENCH_CPUS"));
}

export function builderCPUArguments(builder: string, cpus: number | string): string[] {
  const value = String(positiveInteger(cpus, "CPU budget"));
  if (builder === "nix") return ["--cores", value, "--max-jobs", "1"];
  if (builder === "guix") return [`--cores=${value}`, "--max-jobs=1"];
  throw new Error(`Unknown managed builder: ${builder}`);
}

export function cpuEnvironment(cpus: number, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const value = String(Math.min(positiveInteger(cpus, "CPU budget"), cpuBudget(env)));
  return {
    WORKBENCH_CPU_BUDGET: value,
    ...(env.WORKBENCH_CPUS === undefined ? {} : { WORKBENCH_CPUS: env.WORKBENCH_CPUS }),
    CMAKE_BUILD_PARALLEL_LEVEL: value,
    CTEST_PARALLEL_LEVEL: value,
    VCPKG_MAX_CONCURRENCY: value,
    CARGO_BUILD_JOBS: value,
    NEXTEST_TEST_THREADS: value,
    RUST_TEST_THREADS: value,
    GOMAXPROCS: value,
    GOFLAGS: [
      ...(env.GOFLAGS ?? "").split(/\s+/).filter((flag) => flag && !/^-p(?:=|$)/.test(flag)),
      `-p=${value}`,
    ].join(" "),
    RAYON_NUM_THREADS: value,
    UV_THREADPOOL_SIZE: value,
    UV_CONCURRENT_BUILDS: value,
    UV_CONCURRENT_INSTALLS: value,
    npm_config_child_concurrency: value,
    PYTEST_XDIST_AUTO_NUM_WORKERS: value,
    NIX_CONFIG: [
      ...(env.NIX_CONFIG ?? "").split("\n").filter((line) => !/^\s*(?:cores|max-jobs)\s*=/.test(line)),
      `cores = ${value}`,
      "max-jobs = 1",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
