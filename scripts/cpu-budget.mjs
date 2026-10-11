import { availableParallelism } from "node:os";

export function positiveInteger(value, location) {
  const number = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${location}: expected a positive integer`);
  return number;
}

/** An explicit allocation travels with the job, including across container boundaries. */
export function cpuBudget(env = process.env) {
  return env.WORKBENCH_CPUS === undefined
    ? availableParallelism()
    : positiveInteger(env.WORKBENCH_CPUS, "WORKBENCH_CPUS");
}

export function builderCPUArguments(builder, cpus) {
  const value = String(positiveInteger(cpus, "CPU budget"));
  if (builder === "nix") return ["--cores", value, "--max-jobs", "1"];
  if (builder === "guix") return [`--cores=${value}`, "--max-jobs=1"];
  throw new Error(`Unknown managed builder: ${builder}`);
}

export function cpuEnvironment(cpus, env = process.env) {
  const value = String(positiveInteger(cpus, "CPU budget"));
  return {
    WORKBENCH_CPUS: value,
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
