import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ConfiguredCheck } from "./check-configuration.js";
import { systemRuntimeDirectory } from "../../distribution/unix-system-authority.js";
import { cpuBudget } from "./cpu-budget.mjs";
import { maximumJobserverWorkers, unixWorkerFifoSupported } from "./unix-jobserver-protocol.js";

export type WorkerTool = "cargo" | "make" | "gmake" | "ninja" | "cmake-ninja";

const parallelOption = /^(?:-j|--jobs|--parallel)(?:$|[=0-9])/;
const existingJobserver = /(?:^|\s)(?:-j(?:[0-9]+)?|--jobs(?:=\S+)?|--jobserver-(?:auth|fds)=\S+)(?:\s|$)/;
// Only include GNU Make options that take no argument before a grouped -j.
const groupedMakeJobs = /^-[bBdehikLmnpqrRsStvw]+j[0-9]*$/;

export function workerTool(check: ConfiguredCheck): WorkerTool | undefined {
  const [command, subcommand, , runner] = check.command;
  if (check.command.some((arg) => parallelOption.test(arg))) return undefined;
  if (command === "make" || command === "gmake")
    return check.command.some((arg) => groupedMakeJobs.test(arg)) ? undefined : command;
  if (command === "ninja") return command;
  if (command === "cargo" && ["build", "check", "clippy", "doc", "test"].includes(subcommand ?? "")) return command;
  if (
    command === "node" &&
    subcommand === "scripts/check.mjs" &&
    runner === "{workbench}" &&
    ["c", "cpp"].some((language) => check.source?.endsWith(join("languages", language, "automation.toml")))
  )
    return "cmake-ninja";
  return undefined;
}

const verifiedVersions = {
  make: { pattern: /^GNU Make (\d+)\.(\d+)/, major: 4, minor: 4 },
  ninja: { pattern: /^(\d+)\.(\d+)/, major: 1, minor: 13 },
  cargo: { pattern: /^cargo (\d+)\.(\d+)/, major: 1, minor: 100 },
} as const;

export function nativeWorkerLimit(tool: WorkerTool | undefined, env: NodeJS.ProcessEnv): number | undefined {
  if (!unixWorkerFifoSupported || !tool || /\s/.test(systemRuntimeDirectory())) return undefined;
  const makeFlags = tool === "make" || tool === "gmake" ? env.GNUMAKEFLAGS : undefined;
  if ([env.MAKEFLAGS, env.CARGO_MAKEFLAGS, makeFlags].some((flags) => flags && existingJobserver.test(flags)))
    return undefined;
  const executable = tool === "cmake-ninja" ? "ninja" : tool;
  const { pattern, major, minor } = verifiedVersions[executable === "gmake" ? "make" : executable];
  const version = spawnSync(executable, ["--version"], { env, encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
  if (version.status !== 0) return undefined;
  const parts = pattern.exec(version.stdout.trim());
  if (!parts || Number(parts[1]) < major || (Number(parts[1]) === major && Number(parts[2]) < minor)) return undefined;
  const requestedCargoJobs = tool === "cargo" ? env.CARGO_BUILD_JOBS : undefined;
  if (requestedCargoJobs && !/^[1-9][0-9]*$/.test(requestedCargoJobs)) return undefined;
  return Math.min(cpuBudget(env), requestedCargoJobs ? Number(requestedCargoJobs) : Infinity, maximumJobserverWorkers);
}

export function workerEnvironment(tool: WorkerTool | undefined, pipe: string | undefined, env: NodeJS.ProcessEnv) {
  const result = { ...env };
  delete result.WORKBENCH_JOBSERVER_FIFO;
  delete result.WORKBENCH_SYSTEM_RUNTIME_DIRECTORY;
  if (!tool || !pipe) return result;
  result.WORKBENCH_JOBSERVER_FIFO = pipe;
  if (tool === "cmake-ninja") return result;
  const flags = `${env.MAKEFLAGS ?? ""} -j --jobserver-auth=fifo:${pipe}`.trim();
  result.MAKEFLAGS = flags;
  if (tool === "cargo") {
    delete result.CARGO_BUILD_JOBS;
    result.CARGO_MAKEFLAGS = flags;
  }
  return result;
}
