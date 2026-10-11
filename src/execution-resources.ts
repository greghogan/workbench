import { availableParallelism } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "./core.js";
import { cpuEnvironment, positiveInteger } from "../scripts/cpu-budget.mjs";

export interface ExecutionSettings {
  cpus_per_job?: number;
  max_jobs?: number;
}

/** Pure allocation policy; discovery stays at the caller boundary. */
export function allocateCPUs(
  available: number,
  selectedJobs: number,
  settings: ExecutionSettings = {},
  override?: string,
) {
  const availableCpus = positiveInteger(available, "available CPUs");
  positiveInteger(selectedJobs, "selected CI jobs");
  const requested = positiveInteger(override ?? settings.cpus_per_job ?? 4, "execution.cpus_per_job");
  const cpusPerJob = Math.min(availableCpus, requested);
  const maxJobs = Math.min(
    selectedJobs,
    positiveInteger(settings.max_jobs ?? selectedJobs, "execution.max_jobs"),
    Math.max(1, Math.floor(availableCpus / cpusPerJob)),
  );
  return { availableCpus, cpusPerJob, maxJobs };
}

/** CPU worker budgets are independent of benchd's benchmark admission and memory accounting. */
export function executionResources(root: string, selectedJobs = 1) {
  const settings = existsSync(join(root, "workbench/config.toml")) ? readConfig(root).execution : undefined;
  return allocateCPUs(availableParallelism(), selectedJobs, settings, process.env.WORKBENCH_CPUS);
}

export function executionEnvironment(root: string): Record<string, string> {
  return cpuEnvironment(executionResources(root).cpusPerJob);
}
