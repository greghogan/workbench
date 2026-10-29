import { opendir, lstat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRun, marker } from "./log-run.js";
import { LogRunState, LogLevel, DiagnosticOperation, DiagnosticOutcome, diagnostic } from "./diagnostics.js";
import { ownedPath } from "./paths.js";
import { withCacheLock } from "./cache-lock.js";
import type { LogRetention } from "./log-storage.js";
export interface RetentionRun {
  directory: string;
  completed: number;
  bytes: number;
  eligible: boolean;
}
export function selectLogRetention(runs: readonly RetentionRun[], policy: LogRetention, now: number, newest?: string) {
  const sorted = [...runs].sort((a, b) => a.completed - b.completed);
  const protectedRun = newest ?? sorted.filter((run) => run.eligible).at(-1)?.directory;
  let retainedBytes = sorted.reduce((total, run) => total + run.bytes, 0);
  const remove: string[] = [];
  for (const run of sorted) {
    if (!run.eligible || run.directory === protectedRun) continue;
    const expired = policy.maxAgeDays > 0 && now - run.completed > policy.maxAgeDays * 86400000;
    if (expired || (policy.maxBytes > 0 && retainedBytes > policy.maxBytes)) {
      remove.push(run.directory);
      retainedBytes -= run.bytes;
    }
  }
  return { remove, retainedBytes };
}
async function list(directory: string): Promise<{ names: string[]; omitted: boolean }> {
  const names: string[] = [];
  const reader = await opendir(directory);
  for await (const entry of reader) {
    if (names.length === 10000) return { names, omitted: true };
    names.push(entry.name);
  }
  return { names, omitted: false };
}
async function storedBytes(directory: string): Promise<number> {
  const folders = [""];
  let bytes = 0,
    entries = 0;
  for (const prefix of folders) {
    const inventory = await list(prefix ? ownedPath(directory, prefix) : directory);
    if (inventory.omitted) throw new Error("log inventory limit exceeded");
    for (const name of inventory.names) {
      if (++entries > 10000) throw new Error("log inventory limit exceeded");
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(ownedPath(directory, relative));
      if (stat.isDirectory() && !prefix && /^session-\d+$/.test(name)) folders.push(relative);
      else if (stat.isFile()) bytes += stat.size;
      else throw new Error("uncertain log entry; preserving run");
    }
  }
  return bytes;
}
export async function pruneLogRuns(
  namespace: string,
  policy: LogRetention,
  newest?: string,
  now = Date.now(),
): Promise<string[]> {
  return await withCacheLock(join(namespace, ".retention"), async () => {
    const runs: RetentionRun[] = [];
    let uncertain = 0;
    const inventory = await list(namespace);
    for (const name of inventory.names) {
      if (!/^[0-9a-f-]{32,36}$/.test(name)) continue;
      try {
        const directory = ownedPath(namespace, name);
        if (!(await lstat(directory)).isDirectory() || !existsSync(ownedPath(directory, marker))) continue;
        const receipt = readRun(directory);
        const completed = receipt.state === LogRunState.Completed && receipt.completed !== undefined;
        runs.push({
          directory,
          completed: Date.parse(receipt.completed ?? receipt.started),
          eligible: completed && !existsSync(`${directory}.lock`),
          bytes: await storedBytes(directory),
        });
      } catch {
        uncertain++;
      }
    }
    const plan = selectLogRetention(runs, policy, now, newest);
    const removed: string[] = [];
    for (const directory of plan.remove) {
      if (existsSync(`${directory}.lock`)) continue;
      await withCacheLock(
        directory,
        async () => {
          if (readRun(directory).state !== LogRunState.Completed) return;
          await rm(directory, { recursive: true });
          removed.push(directory);
        },
        0,
      );
    }
    const retainedBytes = runs
      .filter((run) => !removed.includes(run.directory))
      .reduce((total, run) => total + run.bytes, 0);
    if (policy.maxBytes > 0 && retainedBytes > policy.maxBytes)
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.LogRetention,
        DiagnosticOutcome.OverBudget,
        { storedBytes: retainedBytes, budgetBytes: policy.maxBytes },
        undefined,
        "protected logs exceed soft budget",
      );
    if (uncertain || inventory.omitted)
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.LogRetention,
        DiagnosticOutcome.Preserved,
        { uncertain, scanLimit: 10000 },
        undefined,
        "uncertain runs preserved",
      );
    if (removed.length)
      diagnostic(
        LogLevel.Info,
        DiagnosticOperation.LogRetention,
        DiagnosticOutcome.Pruned,
        { runs: removed.length, retainedBytes },
        undefined,
        "old complete runs removed",
      );
    return removed;
  });
}
