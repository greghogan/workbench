import { expect, test } from "vitest";
import { measureSizes } from "../src/web/cache-measurements.ts";
import { decodeCacheSize } from "../src/web/size-protocol.ts";

test("one slow cache does not block other measurements and only two walks run concurrently", async () => {
  const started: string[] = [],
    completed: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sizes = ["slow", "fast", "next"].map((directory) => ({ directory, state: "pending" as const }));
  let active = 0,
    peak = 0,
    ready!: () => void,
    failed!: (error: Error) => void;
  const progress = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const watchdog = setTimeout(() => {
    failed(new Error("Independent measurements did not make progress"));
  }, 10_000);
  const running = measureSizes(sizes, async ({ directory }) => {
    started.push(directory);
    active++;
    peak = Math.max(peak, active);
    if (directory === "slow") await slow;
    else await Promise.resolve();
    completed.push(directory);
    active--;
    if (directory === "next") ready();
  });
  try {
    await progress;
    expect(started).toEqual(["slow", "fast", "next"]);
    expect(completed).toEqual(["fast", "next"]);
    expect(peak).toBe(2);
  } finally {
    clearTimeout(watchdog);
    release();
    await running;
  }
  expect(completed).toEqual(["fast", "next", "slow"]);
});
test("cache state messages reject coercion and incomplete ready measurements", () => {
  for (const state of [["ready"], {}, 1])
    expect(() => decodeCacheSize({ directory: "/cache", state, bytes: 1 })).toThrow();
  expect(() => decodeCacheSize({ directory: "/cache", state: "ready", bytes: 1 })).toThrow();
  expect(
    decodeCacheSize({ directory: "/cache", state: "ready", bytes: 1, measuredAt: "2026-10-28T00:00:00Z" }),
  ).toMatchObject({ bytes: 1 });
});

test("failed measurements stop admission and drain walks already in flight", async () => {
  let release!: () => void, started!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const failure = new Error("unreadable cache");
  const visited: string[] = [];
  let settled = false;
  const running = measureSizes(
    ["failed", "slow", "later"].map((directory) => ({ directory, state: "pending" as const })),
    async ({ directory }) => {
      visited.push(directory);
      if (directory === "failed") {
        await admitted;
        throw failure;
      }
      started();
      await slow;
    },
  );
  const outcome = running.then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await admitted;
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(visited).toEqual(["failed", "slow"]);
  } finally {
    release();
  }
  expect(await outcome).toBe(failure);
  expect(visited).toEqual(["failed", "slow"]);
});
