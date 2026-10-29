import { projectBuildkitLock } from "./buildkit.js";
import { existsSync } from "node:fs";
import { CacheBusy, CacheLockState, inspectCacheMetadataLock, recoverCacheMetadataLock } from "./cache-lock.js";
import { inspectProcessLock } from "./process-lock.js";
import { offlineProfile, offlineReceiptPath } from "./offline-profiles.js";
import { builderDirectory } from "../scripts/managed-contract.mjs";
import { userDirectory } from "./storage.js";
import { readConfig } from "./project-configuration.js";
import { imageQuery } from "./image-process.js";

export enum DevelopmentLock {
  Profile = "profile",
  Builder = "builder",
  Buildkit = "buildkit",
}
function directory(root: string, name: string, kind: DevelopmentLock): string {
  const profile = offlineProfile(root, name);
  if (kind === DevelopmentLock.Buildkit)
    return projectBuildkitLock(root, imageQuery("docker", ["info", "--format", "{{.ID}}"]));
  return kind === DevelopmentLock.Profile
    ? offlineReceiptPath(root, name)
    : builderDirectory(userDirectory("cache"), root, profile.builder);
}
/** Recovery proves local process scopes have drained and refuses potentially active engine work. */
function recoveryBlocker(root: string, lock: ReturnType<typeof inspectCacheMetadataLock>): string | undefined {
  if (lock.state !== CacheLockState.Abandoned) return `Lock ownership is ${lock.state}`;
  const activity = lock.owner.activity;
  const known = (readConfig(root).development?.profiles ?? [])
    .filter((profile) => profile.offline)
    .map((profile) => `${offlineReceiptPath(root, profile.name)}.activity`);
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
export function inspectDevelopmentLocks(root: string, name: string) {
  return Object.values(DevelopmentLock).map((kind) => {
    let target: string;
    try {
      target = directory(root, name, kind);
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
export function recoverDevelopmentLock(root: string, name: string, kind: DevelopmentLock, expected: string): void {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Select the digest returned by development locks");
  const target = directory(root, name, kind);
  recoverCacheMetadataLock(target, {
    expected,
    guard: () => {
      const blocker = recoveryBlocker(root, inspectCacheMetadataLock(target));
      if (blocker) throw new CacheBusy(blocker);
    },
  });
}
