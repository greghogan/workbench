import { describeError } from "../../scripts/diagnostics.mjs";
import type { SpawnSyncReturns } from "node:child_process";
import { processFailure } from "../../scripts/process-outcome.mjs";

/** Complete successful child-process result, with per-test failure/output overrides. */
export function completedProcess(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  const result = { pid: 1, signal: null, status: 0, stdout: "", stderr: "", ...overrides };
  return { output: [null, result.stdout, result.stderr], ...result };
}

// Node returns null streams when a process could not be spawned, despite its string-output typings.
interface CapturedProcess extends Pick<SpawnSyncReturns<string>, "pid" | "status" | "signal" | "error"> {
  stdout: string | null;
  stderr: string | null;
}

/** Require normal success and retain bounded child output when a fixture launch fails. */
export function assertProcessSuccess(operation: string, result: CapturedProcess): void {
  const failure = processFailure(operation, result);
  if (!failure) return;
  const output = Buffer.from((result.stdout ?? "") + (result.stderr ?? ""));
  const limit = 8192;
  const context = output.subarray(-limit).toString("utf8");
  throw new Error(
    `${describeError(failure)}\n${output.length > limit ? "Earlier child output omitted.\n" : ""}${context}`,
    {
      cause: failure,
    },
  );
}
