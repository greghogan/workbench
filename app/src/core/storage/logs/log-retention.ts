import { opendir, lstat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readBoundedFile } from "../../runtime/file-reads.js";
import { writeAtomic } from "../../runtime/file-publication.mjs";
import { isRecord } from "../../runtime/values.mjs";
import { dirname, join, relative } from "node:path";
import { readRun, marker, walkLogSegments, type LogReceipt } from "./log-run.js";
import {
  LogRunState,
  LogLevel,
  DiagnosticOperation,
  DiagnosticOutcome,
  diagnostic,
  restoreDiagnosticError,
} from "../../diagnostics/diagnostics.mjs";
import { DiagnosticIssues } from "../../diagnostics/diagnostic-issues.js";
import { ownedPath } from "../../runtime/paths.js";
import { CacheBusy, releaseAfterFailure, withCacheLock } from "../cache-lock.js";
import { cacheAssetProtections } from "../../projects/project-registry.js";
import { LogInventory, compareRetentionRuns } from "./log-inventory.js";
import type { LogRetention } from "./log-storage.js";
import { withCacheMeasurementLocks } from "../cache-size.js";
export interface RetentionRun {
  directory: string;
  completed: number;
  bytes: number;
  eligible: boolean;
}
export function selectLogRetention(runs: readonly RetentionRun[], policy: LogRetention, now: number, newest?: string) {
  const sorted = [...runs].sort(compareRetentionRuns);
  const protectedRun = newest ?? sorted.filter((run) => run.eligible).at(-1)?.directory;
  let retainedBytes = sorted.reduce((total, run) => total + run.bytes, 0);
  const remove: string[] = [];
  for (const run of sorted)
    if (
      run.eligible &&
      run.directory !== protectedRun &&
      ((policy.maxAgeDays > 0 && now - run.completed > policy.maxAgeDays * 86400000) ||
        (policy.maxBytes > 0 && retainedBytes > policy.maxBytes))
    ) {
      remove.push(run.directory);
      retainedBytes -= run.bytes;
    }
  return { remove, retainedBytes };
}
export const LogRetentionOutcome = {
  Disabled: "disabled",
  Busy: "busy",
  Unchanged: "unchanged",
  Pruned: "pruned",
  Uncertain: "uncertain",
} as const;
export interface LogRetentionResult {
  outcome: (typeof LogRetentionOutcome)[keyof typeof LogRetentionOutcome];
  removed: number;
  retainedBytes: number;
  uncertain: number;
  issues: ReturnType<DiagnosticIssues["snapshot"]>;
}
export interface LogRetentionOptions {
  newest?: string;
  now?: number;
  apply?: boolean;
  layout?: "runs" | "segments";
}
async function storedBytes(directory: string): Promise<number> {
  let bytes = 0;
  for await (const entry of await opendir(directory)) {
    const path = ownedPath(directory, entry.name),
      stat = await lstat(path);
    if (stat.isDirectory() && /^session-\d+$/.test(entry.name)) {
      for await (const child of await opendir(path)) {
        const nested = await lstat(ownedPath(path, child.name));
        if (!nested.isFile()) throw new Error(`${path}: uncertain log entry; preserving run`);
        bytes += nested.size;
      }
    } else if (stat.isFile()) bytes += stat.size;
    else throw new Error(`${path}: uncertain log entry; preserving run`);
  }
  return bytes;
}
function emptyResult(outcome: LogRetentionResult["outcome"]): LogRetentionResult {
  return { outcome, removed: 0, retainedBytes: 0, uncertain: 0, issues: [] };
}

async function withRetentionLock<T>(namespace: string, action: () => Promise<T>): Promise<T | undefined> {
  try {
    if (!existsSync(join(namespace, ".retention.lock")))
      return await withCacheLock(join(namespace, ".retention"), action, 0);
  } catch (error) {
    if (!(error instanceof CacheBusy)) throw error;
  }
  diagnostic(
    LogLevel.Debug,
    DiagnosticOperation.LogRetention,
    DiagnosticOutcome.Waiting,
    { directory: namespace },
    undefined,
    "another sweep owns retention; existing evidence preserved",
  );
  return undefined;
}

/** Manual pruning always takes a fresh inventory under the shared retention lease. */
export async function pruneLogRuns(
  namespace: string,
  policy: LogRetention,
  options: LogRetentionOptions = {},
): Promise<LogRetentionResult> {
  if (!policy.maxAgeDays && !policy.maxBytes) return emptyResult(LogRetentionOutcome.Disabled);
  return (
    (await withRetentionLock(namespace, () => sweepLogRuns(namespace, policy, options))) ??
    emptyResult(LogRetentionOutcome.Busy)
  );
}

function recentSweep(path: string, policy: string, now: number, interval: number): boolean {
  if (!interval) return false;
  try {
    const value: unknown = JSON.parse(readBoundedFile(path, 4096, "log maintenance timing").toString("utf8"));
    return (
      isRecord(value) &&
      value.version === 1 &&
      value.policy === policy &&
      typeof value.attempted === "number" &&
      Number.isSafeInteger(value.attempted) &&
      value.attempted >= 0 &&
      value.attempted <= now &&
      now - value.attempted < interval
    );
  } catch {
    return false;
  }
}

/** The lease covers both cadence admission and publication, including competing processes. */
export async function maintainLogRuns(
  namespace: string,
  policy: LogRetention,
  interval: number,
  options: Pick<LogRetentionOptions, "newest" | "layout"> = {},
): Promise<void> {
  if (!policy.maxAgeDays && !policy.maxBytes) return;
  const stamp = join(namespace, ".maintenance.json"),
    identity = JSON.stringify(policy);
  if (recentSweep(stamp, identity, Date.now(), interval)) return;
  await withRetentionLock(namespace, async () => {
    if (recentSweep(stamp, identity, Date.now(), interval)) return;
    await sweepLogRuns(namespace, policy, options);
    writeAtomic(stamp, JSON.stringify({ version: 1, attempted: Date.now(), policy: identity }) + "\n", 0o600);
  });
}

/** A complete fresh inventory precedes global size decisions; sorting spills to owned disposable storage. */
async function sweepLogRuns(
  namespace: string,
  policy: LogRetention,
  options: LogRetentionOptions,
): Promise<LogRetentionResult> {
  const issues = new DiagnosticIssues(),
    result = emptyResult(LogRetentionOutcome.Unchanged),
    segmented = options.layout === "segments",
    now = options.now ?? Date.now();
  const inventory = new LogInventory(),
    kept = cacheAssetProtections();
  const uncertain = (directory: string, cause: unknown) => {
    result.uncertain++;
    issues.add(new Error(`${directory}: retention inspection failed; preserved`, { cause }));
  };
  const inspect = async (directory: string, parent: string, receipt: LogReceipt): Promise<RetentionRun> => {
    const protectedAssets = kept();
    return {
      directory,
      completed: Date.parse(receipt.completed ?? receipt.started),
      eligible:
        receipt.state === LogRunState.Completed &&
        !protectedAssets.has(parent) &&
        !protectedAssets.has(directory) &&
        !existsSync(`${parent}.lock`) &&
        !existsSync(`${directory}.lock`),
      bytes: await storedBytes(directory),
    };
  };
  async function* scan(): AsyncGenerator<RetentionRun> {
    for await (const entry of await opendir(namespace)) {
      if (!/^[0-9a-f-]{32,36}$/.test(entry.name)) continue;
      const directory = ownedPath(namespace, entry.name);
      try {
        if (!entry.isDirectory() || !existsSync(ownedPath(directory, marker))) continue;
        const receipt = readRun(directory);
        if (Boolean(receipt.segmented) !== segmented) continue;
        if (segmented)
          for await (const segment of walkLogSegments(directory))
            yield await inspect(segment.directory, directory, segment.receipt);
        else yield await inspect(directory, directory, receipt);
      } catch (error) {
        uncertain(directory, error);
      }
    }
  }
  try {
    for await (const unit of scan()) await inventory.add(unit);
    result.retainedBytes = inventory.totalBytes;
    const newest = options.newest ?? inventory.newest?.directory;
    for await (const unit of inventory.sorted()) {
      if (!unit.eligible || unit.directory === newest) continue;
      if (
        !(policy.maxAgeDays > 0 && now - unit.completed > policy.maxAgeDays * 86400000) &&
        !(policy.maxBytes > 0 && result.retainedBytes > policy.maxBytes)
      )
        continue;
      if (options.apply === false) {
        result.removed++;
        result.retainedBytes -= unit.bytes;
        continue;
      }
      const directory = ownedPath(namespace, relative(namespace, unit.directory));
      const remove = async () =>
        withCacheLock(
          directory,
          async () => {
            const protectedAssets = kept();
            if (
              readRun(directory).state !== LogRunState.Completed ||
              protectedAssets.has(directory) ||
              (segmented && protectedAssets.has(dirname(directory)))
            )
              return;
            // Recheck the measured unit under its deletion lock; changed or unknown evidence survives this sweep.
            if ((await storedBytes(directory)) !== unit.bytes) {
              uncertain(directory, new Error("log contents changed during retention"));
              return;
            }
            await withCacheMeasurementLocks([directory], () => rm(directory, { recursive: true }));
            result.removed++;
            result.retainedBytes -= unit.bytes;
          },
          0,
        );
      try {
        if (existsSync(`${directory}.lock`)) continue;
        if (segmented) await withCacheLock(dirname(directory), remove, 0);
        else await remove();
      } catch (error) {
        if (!(error instanceof CacheBusy)) uncertain(directory, error);
      }
    }
    if (segmented && options.apply !== false)
      for await (const entry of await opendir(namespace)) {
        if (!entry.isDirectory() || !/^[0-9a-f-]{32,36}$/.test(entry.name)) continue;
        const directory = ownedPath(namespace, entry.name);
        if (kept().has(directory) || existsSync(`${directory}.lock`)) continue;
        try {
          await withCacheLock(
            directory,
            async () => {
              const receipt = readRun(directory);
              if (!receipt.segmented || receipt.state !== LogRunState.Completed || kept().has(directory)) return;
              for await (const child of await opendir(directory)) if (child.name !== marker) return;
              await withCacheMeasurementLocks([directory], () => rm(directory, { recursive: true }));
            },
            0,
          );
        } catch (error) {
          if (!(error instanceof CacheBusy) && (error as NodeJS.ErrnoException).code !== "ENOENT")
            uncertain(directory, error);
        }
      }
  } catch (failure) {
    releaseAfterFailure(
      () => {
        inventory.close();
      },
      failure,
      "Log retention and inventory cleanup failed",
    );
  }
  inventory.close();
  result.issues = issues.snapshot();
  result.outcome = result.uncertain
    ? LogRetentionOutcome.Uncertain
    : result.removed
      ? LogRetentionOutcome.Pruned
      : LogRetentionOutcome.Unchanged;
  if (policy.maxBytes > 0 && result.retainedBytes > policy.maxBytes)
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.LogRetention,
      DiagnosticOutcome.OverBudget,
      { directory: namespace, storedBytes: result.retainedBytes, budgetBytes: policy.maxBytes },
      undefined,
      "protected logs exceed soft budget",
    );
  if (result.uncertain)
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.LogRetention,
      DiagnosticOutcome.Preserved,
      { directory: namespace, uncertain: result.uncertain },
      new AggregateError(result.issues.map(restoreDiagnosticError), "Uncertain log units preserved"),
    );
  if (result.removed)
    diagnostic(
      LogLevel.Info,
      DiagnosticOperation.LogRetention,
      DiagnosticOutcome.Pruned,
      { directory: namespace, units: result.removed, retainedBytes: result.retainedBytes },
      undefined,
      "old complete log units removed",
    );
  return result;
}
