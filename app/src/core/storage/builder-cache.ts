import { describeError } from "../diagnostics/diagnostic-errors.mjs";
import { inspectBuildkitCache, removeBuildkitCache } from "../artifacts/buildkit.js";
import { withCIProcessOwner } from "../execution/ci/support/ci-lifecycle.mjs";
import { managedStoreCleanupActivity, type StoreManager } from "../execution/environments/managed/managed-contract.mjs";
import { keptCacheAssets } from "../projects/project-registry.js";
import { releaseAfterFailure, withCacheActivity, withCacheLocksSync } from "./cache-lock.js";
import { withToolCacheAdmission } from "../toolchains/tool-cache-lock.js";
import { pruneItem, type CachePruneObserver } from "./cache-prune-progress.js";
import { inspectManagedBuilderStores } from "./managed-builder-store.js";
import { inspectManagedStorePins, retireManagedStorePin, type ManagedStoreCleanup } from "./managed-store-pins.js";
import { acquireProcessLock } from "./process-lock.js";
import { userDirectory } from "./storage.js";

export interface BuilderCacheEntry {
  key: string;
  builder: string;
  volumes: string[];
  bytes: number | undefined;
  directory?: string;
  checkout?: string;
  receipt?: string;
  lock?: string;
  identity?: string;
  label?: string;
  status?: string;
  blockedBy?: string;
  cleanup?: ManagedStoreCleanup;
}
export interface BuilderCacheReport {
  entries: BuilderCacheEntry[];
  issues: string[];
}
/** Inventory owned Docker builders and independently pinned profiles in shared stores. */
export async function inspectBuilderCache(
  checkout?: string,
  signal?: AbortSignal,
  measure = true,
  held: ReadonlySet<string> = new Set(),
): Promise<BuilderCacheReport> {
  signal?.throwIfAborted();
  const report = await inspectBuildkitCache(checkout, signal, measure);
  if (!checkout) {
    try {
      report.entries.push(...(await inspectManagedBuilderStores(signal, measure)));
    } catch (error) {
      signal?.throwIfAborted();
      report.issues.push(describeError(error));
    }
  }
  const pins = await inspectManagedStorePins(checkout, signal, held);
  report.entries.push(...pins.entries);
  report.issues.push(...pins.issues);
  return report;
}

export async function pruneBuilderCache(
  report: BuilderCacheReport,
  progress?: CachePruneObserver,
  validate?: () => void,
): Promise<void> {
  const groups = new Map<StoreManager | undefined, { entries: BuilderCacheEntry[]; locks: Set<string> }>();
  for (const entry of report.entries) {
    if (!entry.lock || !entry.receipt || entry.blockedBy) throw new Error(`Builder ${entry.key} is not removable`);
    const manager = entry.cleanup?.pin.builder;
    const group = groups.get(manager) ?? { entries: [], locks: new Set<string>() };
    group.entries.push(entry);
    group.locks.add(entry.lock);
    if (entry.cleanup) group.locks.add(entry.cleanup.profileLock);
    groups.set(manager, group);
  }
  for (const [manager, { entries, locks }] of groups) {
    const prune = async () => {
      const current = await inspectBuilderCache(undefined, undefined, false, locks);
      if (current.issues.length)
        throw new Error(`Cannot revalidate Docker builder caches: ${current.issues.join("; ")}`);
      const selected = entries.map((entry) => {
        if (entry.receipt && keptCacheAssets().has(entry.receipt))
          throw new Error(`Builder ${entry.key} is explicitly retained`);
        const actual = current.entries.find((candidate) => candidate.key === entry.key);
        // The lock above is ours; attached containers and changed ownership still forbid deletion.
        if (
          !actual ||
          (actual.blockedBy &&
            (actual.cleanup || actual.blockedBy !== "active or recovery-required preparation lock")) ||
          actual.receipt !== entry.receipt ||
          actual.identity !== entry.identity ||
          actual.lock !== entry.lock ||
          actual.cleanup?.profileLock !== entry.cleanup?.profileLock ||
          JSON.stringify(actual.volumes) !== JSON.stringify(entry.volumes)
        )
          throw new Error(`Builder ${entry.key} changed or became active; inspect the cache again`);
        return actual;
      });
      validate?.();
      for (const entry of selected) {
        await pruneItem(
          `Builders / ${entry.label ?? entry.key}`,
          async () => {
            if (entry.cleanup) await retireManagedStorePin({ ...entry, cleanup: entry.cleanup }, validate);
            else await removeBuildkitCache(entry);
          },
          progress,
        );
      }
    };
    const directories = [...locks].sort();
    if (!manager) await withToolCacheAdmission(() => withCacheLocksSync(directories, prune));
    else {
      const activity = managedStoreCleanupActivity(userDirectory("cache"), manager);
      await withCacheActivity(activity, () =>
        withCacheLocksSync(directories, async () => {
          const owner = acquireProcessLock(activity, true);
          if (!owner) throw new Error(`Managed store cleanup is active or needs recovery: ${activity}`);
          try {
            await withCIProcessOwner(owner, prune);
          } catch (failure) {
            releaseAfterFailure(() => {
              owner.release();
            }, failure);
          }
          owner.release();
        }),
      );
    }
  }
}
