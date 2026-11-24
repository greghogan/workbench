import { projectBuildkitLock } from "./buildkit.js";
import { existsSync } from "node:fs";
import {
  CacheBusy,
  CacheLockState,
  inspectCacheMetadataLock,
  recoverCacheMetadataLock,
} from "../storage/cache-lock.js";
import { inspectProcessLock } from "../storage/process-lock.js";
import { offlineProfile } from "./offline-profiles.js";
import { imageProfileLock } from "./image-contract.js";
import {
  builderDirectory,
  managedStoreCleanupActivity,
  managedStoreCleanupLabel,
  managedStoreDirectory,
  type StoreManager,
} from "../execution/environments/managed/managed-contract.mjs";
import { userDirectory } from "../storage/storage.js";
import { readConfig } from "../projects/project-configuration.js";
import { imageQuery } from "./image-process.js";
import { records } from "../runtime/values.mjs";
import { sep } from "node:path";
import { assertManagedStoreEngine } from "../storage/managed-builder-store.js";

export enum DevelopmentLock {
  Profile = "profile",
  Builder = "builder",
  Store = "store",
  Buildkit = "buildkit",
}
function directory(root: string, name: string, kind: DevelopmentLock, architecture: string): string {
  const profile = offlineProfile(root, name);
  if (kind === DevelopmentLock.Buildkit)
    return projectBuildkitLock(root, imageQuery("docker", ["info", "--format", "{{.ID}}"]));
  if (kind === DevelopmentLock.Store) return managedStoreDirectory(userDirectory("cache"), profile.builder);
  return kind === DevelopmentLock.Profile
    ? imageProfileLock(root, name, architecture)
    : builderDirectory(userDirectory("cache"), root, profile.builder);
}
function storeInUse(store: StoreManager): boolean {
  assertManagedStoreEngine(store, imageQuery("docker", ["info", "--format", "{{.ID}}"]));
  const containers = imageQuery("docker", ["ps", "--all", "--quiet", "--no-trunc"]);
  if (!containers) return false;
  const ids = containers.split("\n");
  if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw new Error("Invalid container inventory");
  const mounts = imageQuery("docker", ["container", "inspect", "--format", "{{json .Mounts}}", ...ids]).split("\n");
  if (mounts.length !== ids.length) throw new Error("Incomplete container mount inventory");
  const backing = managedStoreDirectory(userDirectory("cache"), store);
  const volumePrefix = `workbench-managed-${store}-`;
  return mounts.some((line) =>
    records(JSON.parse(line) ?? [], "Invalid container mount inventory").some(
      ({ Name, Source }) =>
        (typeof Name === "string" && Name.startsWith(volumePrefix)) ||
        (typeof Source === "string" && (Source === backing || Source.startsWith(backing + sep))),
    ),
  );
}

/** Recovery proves local process scopes have drained and refuses potentially active engine work. */
function recoveryBlocker(
  root: string,
  lock: ReturnType<typeof inspectCacheMetadataLock>,
  store?: StoreManager,
): string | undefined {
  if (lock.state !== CacheLockState.Abandoned) return `Lock ownership is ${lock.state}`;
  const activity = lock.owner.activity;
  const manager = (["nix", "guix"] as const).find(
    (builder) => activity === managedStoreCleanupActivity(userDirectory("cache"), builder),
  );
  if (activity && manager) {
    if (existsSync(activity) && !inspectProcessLock(activity).abandoned)
      return "Store cleanup processes are active or uncertain";
    try {
      if (imageQuery("docker", ["ps", "--all", "--quiet", "--filter", `label=${managedStoreCleanupLabel}=${manager}`]))
        return "Managed store cleanup container is still present";
    } catch {
      return "Store cleanup container activity could not be established";
    }
    return undefined;
  }
  const known = (readConfig(root).development?.profiles ?? [])
    .filter((profile) => profile.offline && (!store || profile.builder === store))
    .flatMap((profile) =>
      ["x64", "arm64"].map((architecture) => `${imageProfileLock(root, profile.name, architecture)}.activity`),
    );
  if (!activity || !known.includes(activity)) return "Preparation has no recognized child-process ownership evidence";
  if (store) {
    if (existsSync(activity)) {
      const process = inspectProcessLock(activity);
      if (!process.abandoned || process.pid !== lock.owner.pid) return "Owned child processes are active or uncertain";
    }
    try {
      return storeInUse(store) ? `Managed ${store} store is still mounted by a Docker container` : undefined;
    } catch {
      return "Managed store container activity could not be established";
    }
  }
  if (existsSync(activity))
    return inspectProcessLock(activity).abandoned
      ? "Preparation ended before releasing its activity scope; detached descendants remain uncertain"
      : "Owned child processes are active or uncertain";
  try {
    const names = imageQuery("docker", ["ps", "--format", "{{.Names}}"]);
    if (names.split(/\s+/).some((name) => /^(?:workbench-|buildx_buildkit_workbench-)/.test(name)))
      return "Workbench containers are running; drain and stop them before recovery";
  } catch {
    return "Container activity could not be established";
  }
  return undefined;
}
export function inspectDevelopmentLocks(root: string, name: string, architecture: string = process.arch) {
  const manager = offlineProfile(root, name).builder;
  return Object.values(DevelopmentLock)
    .filter((kind) => kind !== DevelopmentLock.Store || manager === "nix" || manager === "guix")
    .map((kind) => {
      let target: string;
      try {
        target = directory(root, name, kind, architecture);
      } catch (error) {
        if (kind !== DevelopmentLock.Buildkit) throw error;
        return {
          kind,
          path: undefined,
          digest: undefined,
          owner: undefined,
          state: CacheLockState.Uncertain,
          recoverable: false,
          reason: error instanceof Error ? error.message : "BuildKit ownership is unavailable",
        };
      }
      const lock = inspectCacheMetadataLock(target);
      const blocker = recoveryBlocker(root, lock, storeManager(kind, manager));
      return { kind, ...lock, recoverable: blocker === undefined, ...(blocker ? { reason: blocker } : {}) };
    });
}

function storeManager(kind: DevelopmentLock, builder: string): StoreManager | undefined {
  return kind === DevelopmentLock.Store && (builder === "nix" || builder === "guix") ? builder : undefined;
}
export function recoverDevelopmentLock(
  root: string,
  name: string,
  kind: DevelopmentLock,
  expected: string,
  architecture: string = process.arch,
): void {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Select the digest returned by development locks");
  const target = directory(root, name, kind, architecture);
  const store = storeManager(kind, offlineProfile(root, name).builder);
  recoverCacheMetadataLock(target, {
    expected,
    guard: () => {
      const blocker = recoveryBlocker(root, inspectCacheMetadataLock(target), store);
      if (blocker) throw new CacheBusy(blocker);
    },
  });
}
