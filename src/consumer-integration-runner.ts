import { readBoundedFile } from "./file-reads.js";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { processFailure } from "../scripts/process-outcome.mjs";
import { runOwnedChild } from "../scripts/owned-child.mjs";
import { RetainedProcessLogs } from "./retained-process-logs.js";
import { ChecksCancelled } from "./check-cancellation.js";
import { required } from "./invariants.js";
import { describeError } from "./diagnostics.js";
import type { ProcessLock } from "./process-lock.js";

export type IntegrationState = "pending" | "running" | "passed" | "failed" | "cancelled";
export interface ConsumerInvocation {
  command: string[];
  windowsVerbatimArguments: boolean;
}
export interface ConsumerCommandResult {
  name: string;
  command: string[];
  cwd: string;
  state: IntegrationState;
  status: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  started: string;
  finished?: string;
  stdout: string;
  stderr: string;
  error?: string;
}
function tail(path: string): string {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size,
        bytes = Buffer.alloc(Math.min(size, 16000));
      readSync(fd, bytes, 0, bytes.length, size - bytes.length);
      return `${size > bytes.length ? `Earlier output omitted; see ${path}\n` : ""}${bytes.toString("utf8")}`;
    } finally {
      closeSync(fd);
    }
  } catch {
    return `\nLog unavailable: ${path}\n`;
  }
}

export function consumerCommandDiagnostics(result: ConsumerCommandResult): { stdout: string; stderr: string } {
  return { stdout: tail(result.stdout), stderr: tail(result.stderr) };
}

/** Commands retain full logs; only explicit queries read bounded output back into memory. */
export class ConsumerCommands {
  readonly results: ConsumerCommandResult[] = [];
  constructor(
    private readonly logs: string,
    private readonly signal: AbortSignal,
    private readonly options: { owner?: ProcessLock; observe?: (result: ConsumerCommandResult) => void } = {},
  ) {}
  async run(
    name: string,
    command: string[] | ConsumerInvocation,
    cwd: string,
    env: NodeJS.ProcessEnv,
    expectedFailure = false,
  ): Promise<ConsumerCommandResult> {
    return (await this.execute(name, command, cwd, env, expectedFailure, false)).result;
  }
  async capture(
    name: string,
    command: string[] | ConsumerInvocation,
    cwd: string,
    env: NodeJS.ProcessEnv,
    expectedFailure = false,
  ): Promise<string> {
    return (await this.execute(name, command, cwd, env, expectedFailure, true)).captured;
  }
  private async execute(
    name: string,
    invocation: string[] | ConsumerInvocation,
    cwd: string,
    env: NodeJS.ProcessEnv,
    expectedFailure: boolean,
    capture: boolean,
  ): Promise<{ result: ConsumerCommandResult; captured: string }> {
    this.signal.throwIfAborted();
    const command = Array.isArray(invocation) ? invocation : invocation.command;
    const executable = required(command[0], "Consumer command executable");
    const prefix = join(this.logs, `${String(this.results.length + 1).padStart(3, "0")}-${name}`);
    const result: ConsumerCommandResult = {
      name,
      command,
      cwd,
      state: "running",
      status: null,
      signal: null,
      durationMs: 0,
      started: new Date().toISOString(),
      stdout: `${prefix}.stdout.log`,
      stderr: `${prefix}.stderr.log`,
    };
    this.results.push(result);
    this.options.observe?.(result);
    const issues: unknown[] = [];
    const retained = new RetainedProcessLogs(result.stdout, result.stderr, (error) => {
      issues.push(error);
    });
    const started = performance.now();
    let problem: unknown;
    try {
      await retained.open();
      const outcome = await runOwnedChild(executable, command.slice(1), {
        cwd,
        env,
        signal: this.signal,
        windowsVerbatimArguments: !Array.isArray(invocation) && invocation.windowsVerbatimArguments,
        ...(this.options.owner ? { owner: this.options.owner } : {}),
        output: (stdout, stderr) => {
          retained.attach(stdout, "stdout");
          retained.attach(stderr, "stderr");
        },
      });
      result.status = outcome.status;
      result.signal = outcome.signal;
      problem = processFailure(executable, outcome);
      if (expectedFailure && outcome.status !== 0 && outcome.status !== null && !outcome.signal && !outcome.error)
        problem = undefined;
      if (expectedFailure && outcome.status === 0) problem = new Error("expected rejection, command succeeded");
    } catch (error) {
      problem = error;
    }
    await retained.close();
    if (this.signal.aborted) problem = new ChecksCancelled("Consumer integration");
    if (issues.length)
      problem = new AggregateError(
        [...(problem ? [problem] : []), ...issues],
        "Consumer command and log finalization failed",
      );
    let captured = "";
    if (!problem && capture) {
      try {
        captured = readBoundedFile(result.stdout, 8 * 1024 * 1024, "captured query (8 MB limit)").toString("utf8");
      } catch (error) {
        problem = error;
      }
    }
    result.durationMs = performance.now() - started;
    result.finished = new Date().toISOString();
    result.state = this.signal.aborted ? "cancelled" : problem ? "failed" : "passed";
    if (problem) result.error = describeError(problem);
    try {
      this.options.observe?.(result);
    } catch (error) {
      throw new AggregateError([...(problem ? [problem] : []), error], "Consumer command report could not be saved", {
        cause: error,
      });
    }
    if (problem)
      throw new Error(
        `${name}: ${describeError(problem)}\n${tail(result.stdout)}${tail(result.stderr)}\nLogs: ${result.stdout}; ${result.stderr}`,
        { cause: problem },
      );
    return { result, captured };
  }
}
