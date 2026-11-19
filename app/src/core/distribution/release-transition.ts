import { closeSync, fsyncSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { writeAtomic, writeNew } from "../runtime/file-publication.mjs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { isRecord } from "../runtime/values.mjs";
import { CacheLockState, inspectCacheMetadataLock, recoverCacheMetadataLock } from "../storage/cache-lock.js";

export const archiveDigest = /^[a-f0-9]{64}$/;
export const releaseTransitionFile = "update.json";
export const maximumTransitionBytes = 16 * 1024;

export interface ReleaseSelection {
  version: 1;
  sha256: string;
  previous?: string;
}

export interface ReleaseServiceRegistration {
  manager: "systemd" | "launchd";
  scope: "user" | "system";
  path: string;
  digest: string;
}

interface ReleaseTransition {
  version: 1;
  before: string;
  after: string;
  service?: ReleaseServiceRegistration;
  launchdMayStart?: true;
}

export function validArchiveDigest(value: unknown): value is string {
  return typeof value === "string" && archiveDigest.test(value);
}

export function parseReleaseSelection(contents: string): ReleaseSelection {
  const value: unknown = JSON.parse(contents);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !validArchiveDigest(value.sha256) ||
    (value.previous !== undefined && (!validArchiveDigest(value.previous) || value.previous === value.sha256))
  )
    throw new Error("Invalid active Workbench release. Use the external installer to repair it.");
  const { sha256, previous } = value;
  return { version: 1, sha256, ...(previous ? { previous } : {}) };
}

export function readReleaseTransition(path: string): ReleaseTransition | undefined {
  let bytes: Buffer;
  try {
    bytes = readBoundedFile(path, maximumTransitionBytes, "Workbench release update receipt");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseTransition(bytes);
}

function parseTransition(bytes: Buffer): ReleaseTransition {
  const value: unknown = JSON.parse(bytes.toString());
  if (!isRecord(value) || value.version !== 1 || typeof value.before !== "string" || typeof value.after !== "string")
    throw new Error("Invalid Workbench release update receipt");
  const before = parseReleaseSelection(value.before);
  const after = parseReleaseSelection(value.after);
  if (before.sha256 !== after.previous) throw new Error("Invalid replaceable Workbench release selection");
  let service: ReleaseServiceRegistration | undefined;
  if (value.service !== undefined) {
    const entry = value.service;
    if (
      !isRecord(entry) ||
      (entry.manager !== "systemd" && entry.manager !== "launchd") ||
      (entry.scope !== "user" && entry.scope !== "system") ||
      typeof entry.path !== "string" ||
      !isAbsolute(entry.path) ||
      !validArchiveDigest(entry.digest)
    )
      throw new Error("Invalid Workbench service update receipt");
    service = { manager: entry.manager, scope: entry.scope, path: entry.path, digest: entry.digest };
  }
  if (
    value.launchdMayStart !== undefined &&
    (value.launchdMayStart !== true || service?.manager !== "launchd" || service.scope !== "system")
  )
    throw new Error("Invalid Workbench LaunchDaemon update receipt");
  return {
    version: 1,
    before: value.before,
    after: value.after,
    ...(service ? { service } : {}),
    ...(value.launchdMayStart === true ? { launchdMayStart: true } : {}),
  };
}

function syncParent(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(dirname(path), "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Make the receipt or selected release durable before changing a service's state. */
export function publishReleaseState(path: string, contents: string, expected: Buffer | undefined, mode: number): void {
  const write = (descriptor: number) => {
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  };
  if (expected === undefined) writeNew(path, write, mode);
  else
    writeAtomic(path, write, mode, () => {
      if (!readBoundedFile(path, expected.byteLength, "previous Workbench release selection").equals(expected))
        throw new Error("The active Workbench release changed before replacement");
    });
  syncParent(path);
}

export function recordReleaseTransition(
  path: string,
  before: string,
  after: string,
  service?: ReleaseServiceRegistration,
): void {
  publishReleaseState(
    path,
    JSON.stringify({ version: 1, before, after, ...(service ? { service } : {}) }) + "\n",
    undefined,
    0o600,
  );
}

export function finishReleaseTransition(path: string): void {
  unlinkSync(path);
  syncParent(path);
}

/** Keep launchd's sockets registered while an update stops and replaces its process. */
export function permitLaunchDaemonStart(path: string, allowed: boolean): void {
  const existing = readBoundedFile(path, maximumTransitionBytes, "Workbench release update receipt");
  const { launchdMayStart, ...transition } = parseTransition(existing);
  if (transition.service?.manager !== "launchd" || transition.service.scope !== "system")
    throw new Error("The update receipt does not select a Workbench LaunchDaemon");
  if (Boolean(launchdMayStart) === allowed) return;
  publishReleaseState(
    path,
    JSON.stringify({ ...transition, ...(allowed ? { launchdMayStart: true } : {}) }) + "\n",
    existing,
    0o600,
  );
}

/** Resume only a lock whose writer is known to have exited. */
export function recoverReleaseLock(path: string): void {
  const owner = inspectCacheMetadataLock(path);
  if (owner.state === CacheLockState.Unlocked) return;
  if (owner.state !== CacheLockState.Abandoned)
    throw new Error(`${path}: the Workbench update may still be running. Finish it before recovering.`);
  recoverCacheMetadataLock(path, { expected: owner.digest });
}
