import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withCacheLock, withCacheLockSync } from "../src/cache-lock.ts";

// Keep timer control in this unit suite; real interprocess exclusion has separate integration coverage.
vi.mock("node:timers/promises", () => ({
  setTimeout: (milliseconds: number | undefined) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
}));
const temporary: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-lock-clock-"));
  temporary.push(root);
  const target = join(root, "tool");
  mkdirSync(`${target}.lock`);
  writeFileSync(`${target}.lock/owner.json`, "another owner");
  vi.useFakeTimers();
  return target;
}

test("async lock expiration follows controlled time and preserves uncertain ownership", async () => {
  const target = fixture();
  const action = vi.fn<() => Promise<undefined>>();
  const pending = withCacheLock(target, action, 200);
  const rejected = expect(pending).rejects.toThrow(/needs recovery/);
  await vi.advanceTimersByTimeAsync(199);
  expect(action).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(readFileSync(`${target}.lock/owner.json`, "utf8")).toBe("another owner");
});

test("a released lock can be acquired before its deadline", async () => {
  const target = fixture();
  const action = vi.fn(() => promised(() => "accepted"));
  const pending = withCacheLock(target, action, 200);
  rmSync(`${target}.lock`, { recursive: true });
  await vi.advanceTimersByTimeAsync(100);
  await expect(pending).resolves.toBe("accepted");
  expect(action).toHaveBeenCalledOnce();
  expect(existsSync(`${target}.lock`)).toBe(false);
});

test("sync lock expiration advances a controlled clock instead of sleeping", () => {
  const target = fixture();
  const action = vi.fn<() => undefined>();
  const sleep = vi.spyOn(Atomics, "wait").mockImplementation(() => {
    vi.advanceTimersByTime(100);
    return "timed-out";
  });
  expect(() => {
    withCacheLockSync(target, action, 200);
  }).toThrow(/needs recovery/);
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(action).not.toHaveBeenCalled();
  expect(readFileSync(`${target}.lock/owner.json`, "utf8")).toBe("another owner");
});

test.each([false, true])(
  "synchronous lock acquisition retains ownership until async work settles (failure: %s)",
  async (failure) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-lock-async-action-"));
    temporary.push(root);
    const target = join(root, "tool");
    const { withCacheLocksSync } = await import("../src/cache-lock.ts");
    for (const lock of [
      (action: () => unknown) => withCacheLockSync(target, action, 0),
      (action: () => unknown) => withCacheLocksSync([target], action),
    ]) {
      let finish: (() => void) | undefined;
      const action = () =>
        new Promise((resolve, reject) => {
          finish = () => {
            if (failure) reject(new Error("removal failed"));
            else resolve("removed");
          };
        });
      const pending = lock(action);
      expect(existsSync(`${target}.lock`)).toBe(true);
      expect(() => {
        withCacheLockSync(target, () => undefined, 0);
      }).toThrow(/busy|recovery/);
      const outcome = failure
        ? expect(pending).rejects.toThrow("removal failed")
        : expect(pending).resolves.toBe("removed");
      required(finish, "Deferred completion")();
      await outcome;
      expect(existsSync(`${target}.lock`)).toBe(false);
    }
  },
);
