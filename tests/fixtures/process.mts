import type { SpawnSyncReturns } from "node:child_process";

/** Complete successful child-process result, with per-test failure/output overrides. */
export function completedProcess(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  const result = { pid: 1, signal: null, status: 0, stdout: "", stderr: "", ...overrides };
  return { output: [null, result.stdout, result.stderr], ...result };
}
