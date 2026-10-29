import { localConfiguration } from "./environments.js";
import { userConfigValues } from "./user-config.js";
import { cpuCapacity, cpuEnvironment, positiveInteger } from "../scripts/cpu-budget.mjs";

export interface ExecutionSettings {
  cpus_per_job?: number | undefined;
  max_jobs?: number | undefined;
}

/** Pure allocation policy; discovery stays at the caller boundary. */
export function allocateCPUs(
  available: number,
  selectedJobs: number,
  settings: ExecutionSettings = {},
  override?: string,
  jobsOverride?: string,
) {
  const availableCpus = positiveInteger(available, "available CPUs");
  positiveInteger(selectedJobs, "selected CI jobs");
  const defaultCPUs = selectedJobs === 1 ? availableCpus : 4;
  const requested = positiveInteger(override ?? settings.cpus_per_job ?? defaultCPUs, "execution.cpus_per_job");
  const cpusPerJob = Math.min(availableCpus, requested);
  const maxJobs = Math.min(
    selectedJobs,
    positiveInteger(jobsOverride ?? settings.max_jobs ?? selectedJobs, "execution.max_jobs"),
    Math.max(1, Math.floor(availableCpus / cpusPerJob)),
  );
  return { availableCpus, cpusPerJob, maxJobs };
}

function executionSettings(root: string) {
  const user = userConfigValues();
  const local = localConfiguration(root).execution;
  return {
    cpus_per_job: local?.cpus_per_job ?? (user["execution.cpus_per_job"] as number | undefined),
    max_jobs: local?.max_jobs ?? (user["execution.max_jobs"] as number | undefined),
  };
}

export function executionResources(root: string, selectedJobs = 1) {
  const settings = executionSettings(root);
  return allocateCPUs(
    cpuCapacity(),
    selectedJobs,
    settings,
    process.env.WORKBENCH_CPUS,
    process.env.WORKBENCH_MAX_JOBS,
  );
}

/** Check admission counts ready groups; a worker limit is an explicit preference, never a CPU reservation. */
export function allocateCheckResources(
  available: number,
  selectedJobs: number,
  settings: ExecutionSettings = {},
  override?: string,
  jobsOverride?: string,
  inherited?: string,
) {
  const availableCpus = Math.min(
    positiveInteger(available, "available CPUs"),
    inherited === undefined ? available : positiveInteger(inherited, "WORKBENCH_CPU_BUDGET"),
  );
  positiveInteger(selectedJobs, "selected check groups");
  const requested = override ?? settings.cpus_per_job ?? inherited;
  const cpuLimit =
    requested === undefined ? null : Math.min(availableCpus, positiveInteger(requested, "execution.cpus_per_job"));
  const maxJobs = Math.min(
    selectedJobs,
    availableCpus,
    positiveInteger(jobsOverride ?? settings.max_jobs ?? availableCpus, "execution.max_jobs"),
  );
  return { availableCpus, cpuLimit, maxJobs };
}

export function checkExecutionResources(root: string, selectedJobs = 1) {
  return allocateCheckResources(
    cpuCapacity(),
    selectedJobs,
    executionSettings(root),
    process.env.WORKBENCH_CPUS,
    process.env.WORKBENCH_MAX_JOBS,
    process.env.WORKBENCH_CPU_BUDGET,
  );
}

export function checkExecutionEnvironment(root: string): Record<string, string> {
  const { cpuLimit } = checkExecutionResources(root);
  return cpuLimit === null ? {} : cpuEnvironment(cpuLimit);
}

/** The managed builder owns one dependency graph; its job limit is independent of each build's worker budget. */
export function builderExecutionResources(root: string) {
  const allocation = executionResources(root);
  return {
    cores: allocation.cpusPerJob,
    maxJobs: Math.min(
      allocation.availableCpus,
      positiveInteger(
        process.env.WORKBENCH_MAX_JOBS ?? executionSettings(root).max_jobs ?? allocation.availableCpus,
        "execution.max_jobs",
      ),
    ),
  };
}

export function executionEnvironment(root: string): Record<string, string> {
  return cpuEnvironment(executionResources(root).cpusPerJob);
}
