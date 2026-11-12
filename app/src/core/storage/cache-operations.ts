import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readBoundedFile } from "../runtime/file-reads.js";
import { ownedPath } from "../runtime/paths.js";
import {
  CacheBusy,
  CacheLockState,
  inspectCacheMetadataLock,
  recoverCacheMetadataLock,
  withCacheLocksSync,
  releaseAfterFailure,
} from "./cache-lock.js";
import { cachedAmount, withCacheMeasurementLocks } from "./cache-size.js";
import type { CacheOperation } from "./cache-operation-contract.js";
import { combineFailures } from "../diagnostics/diagnostic-errors.mjs";
import { cacheDeletionIdentity } from "./cache-plan-identity.js";
import { cacheSizeMarker, cacheGenerationMarker } from "./cache-generation.mjs";
import { diagnostic, LogLevel, DiagnosticOperation, DiagnosticOutcome } from "../diagnostics/diagnostics.mjs";
import { StateConflict } from "../runtime/input-errors.js";

export const cacheOperationsDirectory = ".workbench-cache-operations";
const marker = "operation.json";
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function operationNames(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
function lockVersion(lock: ReturnType<typeof inspectCacheMetadataLock>): unknown {
  if (lock.digest || lock.state !== CacheLockState.Uncertain) return lock.digest ?? lock.state;
  const stat = lstatSync(lock.path, { throwIfNoEntry: false });
  let owner = "";
  if (stat?.isDirectory() && !stat.isSymbolicLink()) {
    try {
      owner = readBoundedFile(ownedPath(lock.path, "owner.json"), 4096, "uncertain cache owner").toString("utf8");
    } catch {
      /* Filesystem identity still detects replacement of unreadable ownership evidence. */
    }
  }
  return [stat?.dev, stat?.ino, stat?.birthtimeMs, stat?.mtimeMs, stat?.size, owner];
}
interface Receipt {
  version: 1;
  target: string;
  action: "install" | "delete";
  externalWriters: boolean;
  identity: string | null;
}
export function inspectUnownedCache(directory: string, problem: string): CacheOperation | undefined {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return;
  const lock = inspectCacheMetadataLock(directory);
  const ordinary = stat.isDirectory() && !stat.isSymbolicLink();
  const contents = ordinary
    ? operationNames(directory)
        .sort()
        .filter(
          (name) =>
            name !== cacheSizeMarker &&
            name !== cacheGenerationMarker &&
            !name.startsWith(`.${cacheSizeMarker}.`) &&
            !name.startsWith(`.${cacheGenerationMarker}.`),
        )
        .map((name) => {
          const value = lstatSync(join(directory, name), { throwIfNoEntry: false });
          return [name, value?.dev, value?.ino, value?.birthtimeMs, value?.mtimeMs, value?.size];
        })
    : [];
  return {
    directory,
    location: "unowned",
    action: "unknown",
    state: lock.state === CacheLockState.Active ? "active" : "uncertain",
    problem,
    ...(stat.isDirectory() && !stat.isSymbolicLink() ? cachedAmount(directory) : { bytes: stat.size }),
    digest: createHash("sha256")
      .update(
        JSON.stringify([
          ordinary ? cacheDeletionIdentity(directory) : [stat.dev, stat.ino, stat.birthtimeMs, stat.mtimeMs, stat.size],
          contents,
          lock.digest ?? lock.state,
        ]),
      )
      .digest("hex"),
  };
}
function identity(directory: string): string | null {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${directory}: expected an owned directory`);
  return JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs]);
}
function syncDirectory(directory: string): void {
  // Windows does not expose directory fsync through Node. File contents are synchronized on every platform.
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function readReceipt(directory: string): Receipt {
  const value: unknown = JSON.parse(
    readBoundedFile(ownedPath(directory, marker), 4096, "cache operation").toString("utf8"),
  );
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("target" in value) ||
    typeof value.target !== "string" ||
    !value.target ||
    value.target === "." ||
    value.target === ".." ||
    /[/\\]/.test(value.target) ||
    !("action" in value) ||
    !["install", "delete"].includes(String(value.action)) ||
    !("externalWriters" in value) ||
    typeof value.externalWriters !== "boolean" ||
    !("identity" in value) ||
    (value.identity !== null && typeof value.identity !== "string")
  )
    throw new Error(`${directory}: invalid cache operation receipt`);
  const names = readdirSync(directory);
  if (names.some((name) => name !== marker && name !== "payload"))
    throw new Error(`${directory}: unexpected cache operation contents`);
  const receipt = value as Receipt;
  if (existsSync(join(directory, "payload")) && identity(join(directory, "payload")) !== receipt.identity)
    throw new Error(`${directory}: cache operation payload identity changed`);
  return receipt;
}
export function inspectCacheOperations(parent: string): CacheOperation[] {
  const root = join(ownedPath(parent, "."), cacheOperationsDirectory);
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    const entry = inspectUnownedCache(root, "Operation namespace is not an ordinary directory");
    return entry ? [entry] : [];
  }
  const names = operationNames(root);
  const present = new Set(names);
  const candidates = new Set(names.filter((name) => !name.endsWith(".lock")));
  for (const name of names)
    if (name.endsWith(".lock") && !present.has(name.slice(0, -5))) candidates.add(name.slice(0, -5));
  return [...candidates].map((name) => {
    const directory = join(root, name);
    const lock = inspectCacheMetadataLock(directory);
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    const ordinary = stat?.isDirectory() && !stat.isSymbolicLink();
    let receipt: Receipt | undefined, problem: string | undefined;
    try {
      if (!uuid.test(name)) throw new Error("Unknown cache operation name");
      if (!ordinary) throw new Error("Cache operation is not an ordinary directory");
      receipt = readReceipt(directory);
      if (receipt.action === "install" && receipt.externalWriters && lock.state !== CacheLockState.Active)
        problem = "Interrupted installer may have external writers; inspect before deleting temporary files";
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (lock.state === CacheLockState.Uncertain) problem = `Cache operation lock ownership is uncertain: ${lock.path}`;
    const body = (() => {
      try {
        return ordinary ? readBoundedFile(join(directory, marker), 4096, "cache operation").toString("utf8") : "";
      } catch {
        return "";
      }
    })();
    const empty = uuid.test(name) && (!stat || (ordinary && operationNames(directory).length === 0));
    if (empty && lock.state !== CacheLockState.Uncertain) problem = undefined;
    if (lock.state === CacheLockState.Active) problem = undefined;
    const payload = ordinary ? lstatSync(join(directory, "payload"), { throwIfNoEntry: false }) : undefined;
    return {
      directory,
      location: "operation",
      ...(receipt ? { target: join(parent, receipt.target) } : {}),
      action: receipt?.action ?? "unknown",
      state: lock.state === CacheLockState.Active ? "active" : problem ? "uncertain" : "pending",
      digest: createHash("sha256")
        .update(JSON.stringify([stat?.dev, stat?.ino, stat?.birthtimeMs, stat?.mtimeMs, body, lockVersion(lock)]))
        .digest("hex"),
      ...(payload?.isDirectory() && !payload.isSymbolicLink()
        ? cachedAmount(join(directory, "payload"))
        : { bytes: payload?.size ?? (stat?.isFile() || stat?.isSymbolicLink() ? stat.size : 0) }),
      ...(problem ? { problem } : {}),
    };
  });
}
function operationLock<T>(directory: string, action: () => T): T {
  const lock = inspectCacheMetadataLock(directory);
  if (lock.state === CacheLockState.Abandoned) recoverCacheMetadataLock(directory, { expected: lock.digest });
  if (lock.state === CacheLockState.Uncertain)
    throw new CacheBusy(`${lock.path}: cache operation ownership is uncertain`);
  const cleanup = () => {
    try {
      rmdirSync(dirname(directory));
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  };
  let result: T;
  try {
    result = withCacheLocksSync([directory], action, { mutable: false });
  } catch (failure) {
    releaseAfterFailure(cleanup, failure, "Cache operation and empty-group cleanup failed");
  }
  if (result instanceof Promise)
    return result.then(
      (value: unknown) => {
        cleanup();
        return value;
      },
      (failure: unknown) => releaseAfterFailure(cleanup, failure, "Cache operation and empty-group cleanup failed"),
    ) as T;
  cleanup();
  return result;
}
function complete(directory: string): void {
  if (existsSync(join(directory, "payload"))) throw new Error(`${directory}: cache operation still has a payload`);
  rmSync(join(directory, marker), { force: true });
  rmdirSync(directory);
  syncDirectory(dirname(directory));
}
/** Only operation-owned payloads are resumed. The current target is never removed by recovery. */
function recoverOperation(
  entry: CacheOperation,
  confirmedDigest: string | undefined,
  asynchronous: true,
): Promise<void>;
function recoverOperation(entry: CacheOperation, confirmedDigest: string | undefined, asynchronous: false): void;
function recoverOperation(
  entry: CacheOperation,
  confirmedDigest: string | undefined,
  asynchronous: boolean,
): void | Promise<void> {
  if (entry.location === "unowned") {
    const current = inspectUnownedCache(entry.directory, entry.problem ?? "Uncertain cache ownership");
    if (current?.state === "active") throw new CacheBusy(`${entry.directory}: cache writer is active`);
    if (confirmedDigest !== current?.digest || entry.digest !== current?.digest)
      throw new StateConflict("Unowned cache changed; inspect and confirm its deletion again");
    const stat = lstatSync(entry.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      rmSync(entry.directory);
      return asynchronous ? Promise.resolve() : undefined;
    }
    if (asynchronous) return removeOwnedCache(entry.directory);
    removeOwnedCacheSync(entry.directory);
    return;
  }
  const parent = dirname(dirname(entry.directory));
  const current = inspectCacheOperations(parent).find((candidate) => candidate.directory === entry.directory);
  if (current?.digest !== entry.digest || (confirmedDigest !== undefined && confirmedDigest !== current.digest))
    throw new StateConflict("Cache operation changed; inspect again before cleanup");
  if (current.state === "active") throw new CacheBusy(`${entry.directory}: cache operation is active`);
  if (current.state === "uncertain" && confirmedDigest === undefined)
    throw new Error(
      `${entry.directory}: explicit confirmation is required: ${current.problem ?? "uncertain ownership"}`,
    );
  if (current.state === "uncertain" && inspectCacheMetadataLock(entry.directory).state === CacheLockState.Uncertain)
    rmSync(`${entry.directory}.lock`, { recursive: true });
  return operationLock(entry.directory, () => {
    if (current.action === "unknown" && current.state === "pending") {
      return withCacheMeasurementLocks([join(entry.directory, "payload")], () => {
        if (existsSync(entry.directory)) rmdirSync(entry.directory);
        return asynchronous ? Promise.resolve() : undefined;
      });
    }
    if (current.state !== "uncertain") readReceipt(entry.directory);
    const path = current.state === "uncertain" ? entry.directory : join(entry.directory, "payload");
    const finished = () => {
      if (current.state !== "uncertain") complete(entry.directory);
    };
    if (asynchronous)
      return withCacheMeasurementLocks([path], () => rm(path, { recursive: true, force: true }).then(finished));
    withCacheMeasurementLocks([path], () => {
      rmSync(path, { recursive: true, force: true });
    });
    finished();
    return;
  });
}
export async function recoverCacheOperation(entry: CacheOperation, confirmedDigest?: string): Promise<void> {
  await recoverOperation(entry, confirmedDigest, true);
  if (entry.target) recoverCacheAssetLock(entry.target);
  reportRecovery(entry, confirmedDigest !== undefined);
}
/** Proven dead local installation owners cannot keep the next installer waiting behind an abandoned mutex. */
export function recoverCacheAssetLock(directory: string): void {
  const lock = inspectCacheMetadataLock(directory);
  if (lock.state === CacheLockState.Abandoned) recoverCacheMetadataLock(directory, { expected: lock.digest });
}
function reportRecovery(entry: CacheOperation, confirmed: boolean): void {
  diagnostic(LogLevel.Info, DiagnosticOperation.CacheRecovery, DiagnosticOutcome.Recovered, {
    directory: entry.directory,
    action: entry.action,
    confirmedUncertain: confirmed && entry.state === "uncertain",
  });
}
/** Called under the destination's ordinary ownership lock, before installation or reuse. */
export async function recoverCacheDestination(directory: string): Promise<void> {
  for (const entry of inspectCacheOperations(dirname(directory))) {
    if (!entry.target && entry.state === "uncertain")
      throw new Error(
        `${entry.directory}: uncertain cache operation in this group requires inspection and explicit confirmation before reuse`,
      );
    if (entry.target !== directory && !(entry.action === "unknown" && entry.state === "pending")) continue;
    await recoverCacheOperation(entry);
  }
}
export function recoverCacheDestinationSync(directory: string): void {
  for (const entry of inspectCacheOperations(dirname(directory))) {
    if (!entry.target && entry.state === "uncertain")
      throw new Error(
        `${entry.directory}: uncertain cache operation in this group requires inspection and explicit confirmation before reuse`,
      );
    if (entry.target === directory || (entry.action === "unknown" && entry.state === "pending")) {
      recoverOperation(entry, undefined, false);
      if (entry.target) recoverCacheAssetLock(entry.target);
      reportRecovery(entry, false);
    }
  }
}
function begin(directory: string): string {
  const root = ownedPath(dirname(directory), cacheOperationsDirectory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const operation = join(root, randomUUID());
  mkdirSync(operation, { mode: 0o700 });
  return operation;
}
function publishReceipt(
  operation: string,
  directory: string,
  action: Receipt["action"],
  externalWriters: boolean,
): void {
  const receipt: Receipt = {
    version: 1,
    target: basename(directory),
    action,
    externalWriters,
    identity: identity(action === "delete" ? directory : join(operation, "payload")),
  };
  const fd = openSync(join(operation, marker), "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(receipt) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(operation);
  syncDirectory(dirname(operation));
}
function retire(operation: string, directory: string): void {
  try {
    publishReceipt(operation, directory, "delete", false);
    renameSync(directory, join(operation, "payload"));
    syncDirectory(dirname(directory));
    syncDirectory(operation);
  } catch (failure) {
    if (!lstatSync(join(operation, "payload"), { throwIfNoEntry: false }))
      releaseAfterFailure(
        () => {
          complete(operation);
        },
        failure,
        "Cache retirement and receipt cleanup failed",
      );
    throw failure;
  }
}
/** Ownership/activity validation and the destination's measurement lock belong to the caller. */
export async function removeOwnedCache(directory: string): Promise<void> {
  await recoverCacheDestination(directory);
  const operation = begin(directory);
  await operationLock(operation, async () => {
    await withCacheMeasurementLocks([join(operation, "payload")], async () => {
      retire(operation, directory);
      await rm(join(operation, "payload"), { recursive: true });
      complete(operation);
    });
  });
}
export function removeOwnedCacheSync(directory: string): void {
  recoverCacheDestinationSync(directory);
  const operation = begin(directory);
  operationLock(operation, () => {
    withCacheMeasurementLocks([join(operation, "payload")], () => {
      retire(operation, directory);
      rmSync(join(operation, "payload"), { recursive: true });
      complete(operation);
    });
  });
}
/** Verified activation remains the installer's responsibility; an interrupted staging area stays discoverable. */
export async function withCacheInstallation(
  directory: string,
  externalWriters: boolean,
  action: (staging: string) => void | Promise<void>,
): Promise<void> {
  await recoverCacheDestination(directory);
  const operation = begin(directory);
  await operationLock(operation, async () => {
    const staging = join(operation, "payload");
    await withCacheMeasurementLocks([staging], async () => {
      let failure: unknown;
      let failed = false;
      try {
        mkdirSync(staging, { mode: 0o700 });
        publishReceipt(operation, directory, "install", externalWriters);
        await action(staging);
      } catch (error) {
        failure = error;
        failed = true;
      }
      try {
        await rm(staging, { recursive: true, force: true });
        complete(operation);
      } catch (cleanup) {
        if (failed) throw combineFailures(failure, cleanup, "Installation and temporary cache cleanup failed");
        throw cleanup;
      }
      if (failed) throw failure;
    });
  });
}
