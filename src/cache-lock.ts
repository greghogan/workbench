import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const deadlineMilliseconds = 30 * 60 * 1000;

export function releaseAfterFailure(
  release: () => void,
  failure: unknown,
  message = "Cache installation and lock release both failed",
): never {
  try {
    release();
  } catch (cleanup) {
    throw new AggregateError([failure, cleanup], `${message}: ${String(failure)}; ${String(cleanup)}`, {
      cause: cleanup,
    });
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

function acquire(directory: string): (() => void) | undefined {
  const lock = `${directory}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID(), started: new Date().toISOString() });
  const identity = lstatSync(lock);
  try {
    writeFileSync(`${lock}/owner.json`, owner, {
      flag: "wx",
    });
  } catch (error) {
    rmSync(lock, { recursive: true });
    throw error;
  }
  return () => {
    const current = lstatSync(lock);
    if (!current.isDirectory() || current.ino !== identity.ino || readFileSync(`${lock}/owner.json`, "utf8") !== owner)
      throw new Error(`Cache lock ownership changed; preserving ${lock}`);
    rmSync(lock, { recursive: true });
  };
}

/** Never steal an uncertain cache writer's lock; abandoned locks require explicit recovery. */
export async function withCacheLock<T>(
  directory: string,
  action: () => Promise<T>,
  timeout = deadlineMilliseconds,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    signal?.throwIfAborted();
    const release = acquire(directory);
    if (release) {
      let result: T;
      try {
        result = await action();
      } catch (failure) {
        releaseAfterFailure(release, failure);
      }
      return releaseWhenSettled(result, release);
    }
    if (Date.now() >= deadline) throw new Error(`Cache installation is busy or needs recovery: ${directory}.lock`);
    await delay(100, undefined, { signal });
  }
}

export function withCacheLockSync<T>(directory: string, action: () => T, timeout = deadlineMilliseconds): T {
  const deadline = Date.now() + timeout;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const release = acquire(directory);
    if (release) {
      let result: T;
      try {
        result = action();
      } catch (failure) {
        releaseAfterFailure(release, failure);
      }
      return releaseWhenSettled(result, release);
    }
    if (Date.now() >= deadline) throw new Error(`Cache installation is busy or needs recovery: ${directory}.lock`);
    Atomics.wait(sleeper, 0, 0, 100);
  }
}

/** Acquire a deletion set without waiting; release partial acquisitions without recursive lock nesting. */
export function withCacheLocksSync<T>(directories: string[], action: () => T): T {
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
      const release = acquire(directory);
      if (!release) throw new Error(`Cache is busy or needs recovery: ${directory}.lock`);
      releases.push(release);
    }
    result = action();
  } catch (error) {
    releaseAfterFailure(releaseAll, error);
  }
  return releaseWhenSettled(result, releaseAll);
}
