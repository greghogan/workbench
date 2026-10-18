import { spawnSync } from "node:child_process";

/** Bounded metadata queries; callers own inventory lifetime and deletion revalidation. */
export function imageQuery(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? (result.stderr.trim() || `${command} exited ${String(result.status)}`));
  return result.stdout.trim();
}
