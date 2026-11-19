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
} from "../execution/environments/managed/managed-contract.mjs";
import { userDirectory } from "../storage/storage.js";
import { readConfig } from "../projects/project-configuration.js";
import { imageQuery } from "./image-process.js";

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
/** Recovery proves local process scopes have drained and refuses potentially active engine work. */
function recoveryBlocker(root: string, lock: ReturnType<typeof inspectCacheMetadataLock>): string | undefined {
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
    .filter((profile) => profile.offline)
    .flatMap((profile) =>
      ["x64", "arm64"].map((architecture) => `${imageProfileLock(root, profile.name, architecture)}.activity`),
    );
  if (!activity || !known.includes(activity)) return "Preparation has no recognized child-process ownership evidence";
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
      const blocker = recoveryBlocker(root, lock);
      return { kind, ...lock, recoverable: blocker === undefined, ...(blocker ? { reason: blocker } : {}) };
    });
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
  recoverCacheMetadataLock(target, {
    expected,
    guard: () => {
      const blocker = recoveryBlocker(root, inspectCacheMetadataLock(target));
      if (blocker) throw new CacheBusy(blocker);
    },
  });
}
