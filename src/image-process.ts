import { spawnSync } from "node:child_process";
import { processFailure } from "../scripts/process-outcome.mjs";

/** Bounded metadata queries; callers own inventory lifetime and deletion revalidation. */
export function imageQuery(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  const failure = processFailure(command, result, { stdout: result.stdout, stderr: result.stderr });
  if (failure) throw failure;
  return result.stdout.trim();
}
