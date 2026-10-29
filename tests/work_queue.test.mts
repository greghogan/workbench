import { expect, test, vi } from "vitest";
import { admittedWork, mapWork, workQueue } from "../scripts/work-admission.mjs";

test("available workers claim independent queued work without exceeding capacity", async () => {
  const gates = {
    slow: Promise.withResolvers<undefined>(),
    fast: Promise.withResolvers<undefined>(),
    next: Promise.withResolvers<undefined>(),
  };
  const started: string[] = [];
  let active = 0,
    peak = 0;
  const run = workQueue(["slow", "fast", "next"] as const, { capacity: 2 }, async (name) => {
    started.push(name);
    peak = Math.max(peak, ++active);
    try {
      await gates[name].promise;
    } finally {
      active--;
    }
  });
  await vi.waitFor(() => {
    expect(started).toEqual(["slow", "fast"]);
  });
  gates.fast.resolve(undefined);
  await vi.waitFor(() => {
    expect(started).toEqual(["slow", "fast", "next"]);
  });
  gates.next.resolve(undefined);
  gates.slow.resolve(undefined);
  await run;
  expect(peak).toBe(2);
  expect(active).toBe(0);
});

test("failure stops new admission and drains active work before returning", async () => {
  const slow = Promise.withResolvers<undefined>(),
    fast = Promise.withResolvers<undefined>();
  const started: string[] = [];
  let active = 0,
    finished = false;
  const run = workQueue(["slow", "fast", "unadmitted"], { capacity: 2 }, async (name) => {
    started.push(name);
    active++;
    try {
      await (name === "slow" ? slow.promise : fast.promise);
    } finally {
      active--;
    }
  }).finally(() => {
    finished = true;
  });
  const rejected = expect(run).rejects.toThrow("fixture failure");
  await vi.waitFor(() => {
    expect(started).toEqual(["slow", "fast"]);
  });
  fast.reject(new Error("fixture failure"));
  await vi.waitFor(() => {
    expect(active).toBe(1);
  });
  expect(finished).toBe(false);
  expect(started).toEqual(["slow", "fast"]);
  slow.resolve(undefined);
  await rejected;
  expect(active).toBe(0);
});

test("cancellation prevents queued work and validates capacity even for empty queues", async () => {
  const controller = new AbortController(),
    gate = Promise.withResolvers<undefined>();
  const visit = vi.fn(async () => {
    await gate.promise;
  });
  const run = workQueue(["active", "unadmitted"], { capacity: 1, signal: controller.signal }, visit);
  const rejected = expect(run).rejects.toThrow("cancelled");
  await vi.waitFor(() => {
    expect(visit).toHaveBeenCalledTimes(1);
  });
  controller.abort(new Error("cancelled"));
  gate.resolve(undefined);
  await rejected;
  expect(visit).toHaveBeenCalledTimes(1);
  await expect(workQueue([], { capacity: 0 }, visit)).rejects.toThrow(/positive integer/);
  await expect(workQueue([], { capacity: 1 }, visit)).resolves.toBeUndefined();
});

test("capacity is released after cancellation and preserves work and cleanup errors", async () => {
  const controller = new AbortController(),
    primary = new Error("operation failed"),
    cleanup = new Error("release failed");
  let released = 0;
  const admission = {
    acquire: () =>
      Promise.resolve({
        release: () => {
          released++;
          throw cleanup;
        },
      }),
  };
  await expect(admittedWork(admission, undefined, () => Promise.reject(primary))).rejects.toMatchObject({
    cause: primary,
    errors: [primary, cleanup],
  });
  expect(released).toBe(1);
  const cancelDuringAcquire = {
    acquire: () => {
      controller.abort();
      return Promise.resolve({
        release: () => {
          released++;
        },
      });
    },
  };
  let ran = false;
  await expect(
    admittedWork(cancelDuringAcquire, controller.signal, () => {
      ran = true;
      return Promise.resolve();
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(ran).toBe(false);
  expect(released).toBe(2);
});

test("ordered mapping retains input order when later work finishes first", async () => {
  const release = Promise.withResolvers<undefined>();
  const later = Promise.withResolvers<undefined>();
  const result = mapWork(["first", "second"], { capacity: 2 }, async (item) => {
    if (item === "first") await release.promise;
    else later.resolve(undefined);
    return item.toUpperCase();
  });
  try {
    await later.promise;
  } finally {
    release.resolve(undefined);
  }
  expect(await result).toEqual(["FIRST", "SECOND"]);
});
