import { basename } from "node:path";
import { mkdirSync } from "node:fs";
import { processCancellation, captureOwnedChild, runOwnedChild } from "./owned-child.mjs";
import { createOwnedScratch, type OwnedScratch } from "./owned-scratch.mjs";
import { DiagnosticCapture, clipped } from "./diagnostic-text.mjs";
import { processFailure } from "./process-outcome.mjs";
import { combineFailures } from "./diagnostic-errors.mjs";

export interface EngineeringCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
  input?: string;
  limit?: number;
}
export class EngineeringRun {
  readonly cancellation = processCancellation();
  readonly scratch: OwnedScratch;
  get directory() {
    return this.scratch.directory;
  }
  get signal() {
    return this.cancellation.signal;
  }
  constructor(parent: string, kind: string) {
    mkdirSync(parent, { recursive: true });
    try {
      this.scratch = createOwnedScratch(parent, kind);
    } catch (error) {
      this.cancellation.close();
      throw error;
    }
  }
  async command(command: string, args: string[], options: EngineeringCommandOptions = {}) {
    const context = {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      signal: this.signal,
      owner: this.scratch.owner,
      stopDescendantsOnExit: true,
      ...(options.input === undefined ? {} : { input: options.input }),
    };
    if (options.capture) return captureOwnedChild(command, args, context, options.limit ?? 8 * 1024 * 1024);
    const out = new DiagnosticCapture(),
      err = new DiagnosticCapture();
    const outcome = await runOwnedChild(command, args, {
      ...context,
      output: (stdout, stderr) => {
        stdout.on("data", (bytes: Buffer) => {
          out.add(bytes);
          process.stdout.write(bytes);
        });
        stderr.on("data", (bytes: Buffer) => {
          err.add(bytes);
          process.stderr.write(bytes);
        });
      },
    });
    return { ...outcome, stdout: out.rawText(), stderr: err.rawText() };
  }
  async run(command: string, args: string[], options: EngineeringCommandOptions = {}): Promise<string> {
    const outcome = await this.command(command, args, options);
    const failure = processFailure(basename(command), outcome, outcome);
    if (failure) throw failure;
    return outcome.stdout;
  }
  close(): void {
    try {
      this.scratch.release();
    } finally {
      this.cancellation.close();
    }
  }
}
export async function withEngineeringRun<T>(
  parent: string,
  kind: string,
  action: (run: EngineeringRun) => Promise<T>,
): Promise<T> {
  const run = new EngineeringRun(parent, kind);
  let result: T;
  try {
    result = await action(run);
  } catch (failure) {
    try {
      run.close();
    } catch (cleanup) {
      throw combineFailures(failure, cleanup, "Engineering operation and cleanup failed");
    }
    throw failure;
  }
  run.close();
  return result;
}

/** Keep the operation failure if publishing its diagnostic report also fails. */
export async function withEngineeringReport<T>(
  report: { status: "running" | "passed" | "failed"; error?: string },
  save: () => void,
  action: () => Promise<T>,
): Promise<T> {
  save();
  let result: T;
  try {
    result = await action();
    report.status = "passed";
  } catch (failure) {
    report.status = "failed";
    report.error = clipped(String(failure)).text;
    try {
      save();
    } catch (publication) {
      throw combineFailures(failure, publication, "Engineering operation and report publication failed");
    }
    throw failure;
  }
  save();
  return result;
}
