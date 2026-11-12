import { buildStorageSettings } from "../artifacts/builds.js";
import { projectRegistrySnapshot } from "../projects/project-registry.js";
import { inspectToolCache } from "../toolchains/tool-cache.js";
import { withToolCacheMaintenance } from "../toolchains/tool-cache-lock.js";
import { inspectBuildCache } from "./build-cache.js";
import { recoverCacheOperation } from "./cache-operations.js";
import type { CacheOperation } from "./cache-operation-contract.js";
import { discoverCacheSizes, withCacheMeasurementLocks } from "./cache-size.js";
import { StateConflict } from "../runtime/input-errors.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ownedPath } from "../runtime/paths.js";
import { inspectProcessLock } from "./process-lock.js";
import { userDirectory } from "./storage.js";
import { CacheBusy } from "./cache-lock.js";

function assertNoBuildUsers(): void {
  const root = join(userDirectory("cache"), "build-users");
  if (!existsSync(root)) return;
  for (const checkout of readdirSync(root)) {
    const owner = ownedPath(root, checkout);
    for (const scope of readdirSync(owner)) {
      const directory = ownedPath(owner, scope);
      for (const name of readdirSync(directory)) {
        const lease = ownedPath(directory, name);
        if (!inspectProcessLock(lease).abandoned)
          throw new CacheBusy(`${lease}: active or unresolved development session; uncertain cache cleanup preserved`);
      }
    }
  }
}

/** Discovery uses receipts and saved estimates; it never starts a recursive measurement. */
export function inspectKnownCacheOperations(): { entries: CacheOperation[]; issues: string[] } {
  return discoverCacheSizes(() => {
    const issues: string[] = [],
      entries: CacheOperation[] = [];
    const stores = new Set([buildStorageSettings().root]);
    const projects = projectRegistrySnapshot().projects;
    for (const project of projects) {
      try {
        stores.add(buildStorageSettings(project.path).root);
      } catch (error) {
        issues.push(`${project.path}: ${String(error)}`);
      }
    }
    for (const store of stores) {
      try {
        entries.push(...(inspectBuildCache(undefined, true, undefined, store).operations ?? []));
      } catch (error) {
        issues.push(`${store}: ${String(error)}`);
      }
    }
    const tools = inspectToolCache();
    entries.push(...(tools.operations ?? []));
    return { entries, issues };
  }).value;
}
/** Only destinations discovered through configured cache roots can be selected by a client. */
export async function recoverKnownCacheOperation(directory: string, digest: string): Promise<void> {
  const entry = inspectKnownCacheOperations().entries.find((entry) => entry.directory === directory);
  if (entry?.digest !== digest) throw new StateConflict("Cache cleanup selection changed; inspect again");
  if (entry.state === "uncertain") {
    await withToolCacheMaintenance(() => {
      assertNoBuildUsers();
      return entry.location === "unowned"
        ? withCacheMeasurementLocks([directory], () => recoverCacheOperation(entry, digest))
        : recoverCacheOperation(entry, digest);
    });
  } else {
    // Retired payloads are inaccessible to new builds; their own operation lock is sufficient.
    await recoverCacheOperation(entry);
  }
}
