import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const deadlineMilliseconds = 30 * 60 * 1000;

function releaseAfterFailure(release: () => void, failure: unknown): never {
  try {
    release();
  } catch (cleanup) {
    throw new AggregateError(
      [failure, cleanup],
      `Cache installation and lock release both failed: ${String(failure)}; ${String(cleanup)}`,
      { cause: cleanup },
    );
  }
  throw failure;
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
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const release = acquire(directory);
    if (release) {
      let result: T;
      try {
        result = await action();
      } catch (failure) {
        releaseAfterFailure(release, failure);
      }
      release();
      return result;
    }
    if (Date.now() >= deadline) throw new Error(`Cache installation is busy or needs recovery: ${directory}.lock`);
    await delay(100);
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
      release();
      return result;
    }
    if (Date.now() >= deadline) throw new Error(`Cache installation is busy or needs recovery: ${directory}.lock`);
    Atomics.wait(sleeper, 0, 0, 100);
  }
}
