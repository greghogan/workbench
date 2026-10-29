import { readBoundedFile } from "./file-reads.js";
import { combineFailures } from "../scripts/diagnostic-errors.mjs";
import { performance } from "node:perf_hooks";
import { LogLevel, DiagnosticOperation, DiagnosticOutcome } from "../scripts/diagnostic-contract.mjs";
/** Busy caches have a distinct retry/recovery outcome. */
export class CacheBusy extends Error {}
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { diagnostic } from "../scripts/diagnostics.mjs";
import { invalidateCacheSize } from "../scripts/cache-generation.mjs";

const activity = new AsyncLocalStorage<string>();
export const withCacheActivity = <T>(path: string, action: () => T): T => activity.run(path, action);

const deadlineMilliseconds = 30 * 60 * 1000;

export function releaseAfterFailure(
  release: () => void,
  failure: unknown,
  message = "Cache installation and lock release both failed",
): never {
  try {
    release();
  } catch (cleanup) {
    throw combineFailures(failure, cleanup, `${message}: ${String(failure)}; ${String(cleanup)}`);
  }
  throw failure;
}

/** A synchronous acquisition may guard asynchronous work; retain ownership until it settles. */
function releaseWhenSettled<T>(result: T, release: () => void): T {
  if (result instanceof Promise)
    return result.then(
      (value: unknown) => {
        release();
        return value;
      },
      (failure: unknown) => releaseAfterFailure(release, failure),
    ) as T;
  release();
  return result;
}

function acquire(directory: string, mutable = true, beforeRelease?: () => void): (() => void) | undefined {
  const lock = `${directory}.lock`;
  if (lstatSync(lock, { throwIfNoEntry: false })) return undefined;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    // Empty-group pruning can remove the parent between the two mkdir calls; retry acquisition.
    if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
  const owner = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    started: new Date().toISOString(),
    ...(activity.getStore() ? { activity: activity.getStore() } : {}),
  });
  const identity = lstatSync(lock);
  try {
    // codeql[js/insecure-temporary-file] Exclusive creation inside the newly acquired mode-0700 lock directory; no shared temporary filename is used.
    writeFileSync(`${lock}/owner.json`, owner, {
      flag: "wx",
    });
    if (mutable) invalidateCacheSize(directory);
  } catch (error) {
    rmSync(lock, { recursive: true });
    throw error;
  }
  return () => {
    beforeRelease?.();
    const current = lstatSync(lock);
    if (!current.isDirectory() || current.ino !== identity.ino || readFileSync(`${lock}/owner.json`, "utf8") !== owner)
      throw new Error(`Cache lock ownership changed; preserving ${lock}`);
    try {
      if (mutable) invalidateCacheSize(directory);
    } finally {
      rmSync(lock, { recursive: true });
    }
  };
}

/** Explicit metadata recovery preserves old/foreign owners and every owner whose death cannot be proven. */
export function recoverCacheMetadataLock(
  directory: string,
  options: { expected?: string; guard?: () => void } = {},
): void {
  withCacheLockSync(
    `${directory}.recovery`,
    () => {
      const lock = `${directory}.lock`,
        stat = lstatSync(lock),
        file = `${lock}/owner.json`;
      if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(lock).join() !== "owner.json")
        throw new CacheBusy("Metadata lock ownership is uncertain; preserving it");
      const metadata = lstatSync(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096)
        throw new CacheBusy("Metadata lock ownership is uncertain; preserving it");
      const body = readBoundedFile(file, 4096, "cache lock owner").toString("utf8"),
        owner: unknown = JSON.parse(body);
      if (
        !owner ||
        typeof owner !== "object" ||
        !("host" in owner) ||
        owner.host !== hostname() ||
        !("pid" in owner) ||
        typeof owner.pid !== "number" ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        !("token" in owner) ||
        typeof owner.token !== "string" ||
        !/^[a-f0-9-]{36}$/.test(owner.token)
      )
        throw new CacheBusy("Metadata lock ownership is uncertain; preserving it");
      try {
        process.kill(owner.pid, 0);
        throw new CacheBusy("Metadata writer is still active; preserving its lock");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      if (options.expected !== undefined && inspectCacheMetadataLock(directory).digest !== options.expected)
        throw new CacheBusy("Lock changed since inspection; inspect again");
      options.guard?.();
      const current = lstatSync(lock);
      if (
        current.ino !== stat.ino ||
        current.dev !== stat.dev ||
        readBoundedFile(file, 4096, "cache lock owner").toString("utf8") !== body
      )
        throw new CacheBusy("Metadata lock changed during recovery; preserving it");
      const retired = `${lock}.recovered-${randomUUID()}`;
      renameSync(lock, retired);
      rmSync(retired, { recursive: true });
    },
    0,
  );
}

export const CacheLockState = {
  Unlocked: "unlocked",
  Active: "active",
  Abandoned: "abandoned",
  Uncertain: "uncertain",
} as const;
export type CacheLockState = (typeof CacheLockState)[keyof typeof CacheLockState];
/** Bounded read-only observation; incomplete owners and foreign hosts remain uncertain. */
export function inspectCacheMetadataLock(directory: string) {
  const path = `${directory}.lock`;
  const identity = lstatSync(path, { throwIfNoEntry: false });
  if (!identity) return { path, state: CacheLockState.Unlocked };
  try {
    const file = `${path}/owner.json`;
    if (!identity.isDirectory() || identity.isSymbolicLink() || readdirSync(path).join() !== "owner.json")
      throw new Error("Unknown lock layout");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Invalid owner file");
    const body = readBoundedFile(file, 4096, "cache lock owner").toString("utf8");
    const owner: unknown = JSON.parse(body);
    if (
      !owner ||
      typeof owner !== "object" ||
      !("pid" in owner) ||
      !Number.isSafeInteger(owner.pid) ||
      Number(owner.pid) <= 0 ||
      !("host" in owner) ||
      typeof owner.host !== "string" ||
      !("token" in owner) ||
      typeof owner.token !== "string" ||
      !/^[a-f0-9-]{36}$/.test(owner.token)
    )
      throw new Error("Unknown lock owner");
    const digest = createHash("sha256")
      .update(JSON.stringify([identity.dev, identity.ino, body]))
      .digest("hex");
    let state: CacheLockState = CacheLockState.Uncertain;
    if (owner.host === hostname()) {
      try {
        process.kill(Number(owner.pid), 0);
        state = CacheLockState.Active;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") state = CacheLockState.Abandoned;
      }
    }
    return {
      path,
      state,
      digest,
      owner: {
        pid: Number(owner.pid),
        host: owner.host,
        started: "started" in owner && typeof owner.started === "string" ? owner.started : undefined,
        activity: "activity" in owner && typeof owner.activity === "string" ? owner.activity : undefined,
      },
    };
  } catch {
    return { path, state: CacheLockState.Uncertain };
  }
}

function lockOwner(directory: string): Record<string, string | number> {
  try {
    const path = `${directory}.lock/owner.json`,
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return { owner: "unavailable" };
    const value: unknown = JSON.parse(readBoundedFile(path, 4096, "cache lock owner").toString("utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid)
    )
      return { owner: "unavailable" };
    return {
      ownerPid: value.pid,
      ...("started" in value && typeof value.started === "string" ? { ownerStarted: value.started.slice(0, 64) } : {}),
    };
  } catch {
    return { owner: "unavailable" };
  }
}
/** Both waiting mechanisms share observations and a monotonic deadline. */
class LockWait {
  private readonly started = performance.now();
  private attempts = 0;
  private waiting = false;
  private readonly directory: string;
  private readonly timeout: number;
  constructor(directory: string, timeout: number) {
    this.directory = directory;
    this.timeout = timeout;
  }
  attempt(): void {
    this.attempts++;
  }
  fields() {
    return {
      directory: this.directory,
      elapsedMs: Math.max(0, performance.now() - this.started),
      attempts: this.attempts,
    };
  }
  acquired(): void {
    if (this.waiting)
      diagnostic(
        LogLevel.Info,
        DiagnosticOperation.CacheLock,
        DiagnosticOutcome.Acquired,
        this.fields(),
        undefined,
        "acquired after waiting",
      );
  }
  blocked(): void {
    if (!this.waiting) {
      this.waiting = true;
      diagnostic(LogLevel.Info, DiagnosticOperation.CacheLock, DiagnosticOutcome.Waiting, {
        directory: this.directory,
        timeoutMs: this.timeout,
        ...lockOwner(this.directory),
      });
    }
    const fields = this.fields();
    if (fields.elapsedMs >= this.timeout) {
      const error = new CacheBusy(
        `Cache installation is busy or needs recovery: ${this.directory}.lock; waited ${String(Math.round(fields.elapsedMs))} ms (${String(fields.attempts)} attempts)`,
      );
      diagnostic(LogLevel.Warn, DiagnosticOperation.CacheLock, DiagnosticOutcome.Exhausted, fields, error);
      throw error;
    }
  }
  cancelled(error: unknown): void {
    if (this.waiting)
      diagnostic(LogLevel.Info, DiagnosticOperation.CacheLock, DiagnosticOutcome.Cancelled, this.fields(), error);
  }
}
/** Never steal an uncertain cache writer's lock; abandoned locks require explicit recovery. */
export async function withCacheLock<T>(
  directory: string,
  action: () => Promise<T>,
  timeout = deadlineMilliseconds,
  signal?: AbortSignal,
  options: { mutable?: boolean; beforeRelease?: () => void } = {},
): Promise<T> {
  const observation = new LockWait(directory, timeout);
  for (;;) {
    observation.attempt();
    if (signal?.aborted) {
      observation.cancelled(signal.reason);
      signal.throwIfAborted();
    }
    const release = acquire(directory, options.mutable ?? true, options.beforeRelease);
    if (release) {
      observation.acquired();
      let result: T;
      try {
        result = await action();
      } catch (failure) {
        releaseAfterFailure(release, failure);
      }
      return releaseWhenSettled(result, release);
    }
    observation.blocked();
    try {
      await delay(100, undefined, { signal });
    } catch (error) {
      observation.cancelled(error);
      throw error;
    }
  }
}

export function withCacheLockSync<T>(directory: string, action: () => T, timeout = deadlineMilliseconds): T {
  const observation = new LockWait(directory, timeout);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    observation.attempt();
    const release = acquire(directory);
    if (release) {
      observation.acquired();
      let result: T;
      try {
        result = action();
      } catch (failure) {
        releaseAfterFailure(release, failure);
      }
      return releaseWhenSettled(result, release);
    }
    observation.blocked();
    Atomics.wait(sleeper, 0, 0, 100);
  }
}

/** Acquire a deletion set without waiting; release partial acquisitions without recursive lock nesting. */
export function withCacheLocksSync<T>(directories: string[], action: () => T, options: { mutable?: boolean } = {}): T {
  const releases: (() => void)[] = [];
  const releaseAll = () => {
    const errors: unknown[] = [];
    for (const release of releases.reverse()) {
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Cache lock release failed");
  };
  let result: T;
  try {
    for (const directory of directories) {
      const release = acquire(directory, options.mutable ?? true);
      if (!release) throw new CacheBusy(`Cache is busy or needs recovery: ${directory}.lock`);
      releases.push(release);
    }
    result = action();
  } catch (error) {
    releaseAfterFailure(releaseAll, error);
  }
  return releaseWhenSettled(result, releaseAll);
}
