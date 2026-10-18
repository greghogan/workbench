import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { coordinationFixtures } from "./fixtures/check-coordination.mjs";

const { fixture, until, waiting } = coordinationFixtures();

test.each(["SIGINT", "SIGTERM"] as const)(
  "%s cancels a waiter without stopping the owner or the next waiter",
  async (signal) => {
    const f = await fixture(),
      first = f.start();
    try {
      await until(first, () => f.count("test") === 1, "owner readiness");
      const second = f.start();
      await waiting(second);
      second.child.kill(signal);
      expect(await second.closed, second.output()).toBe(process.platform === "win32" ? null : 130);
      expect(first.child.exitCode).toBeNull();
      expect(f.count("cancelled")).toBe(0);
      const third = f.start();
      await waiting(third);
      f.release();
      expect(await first.closed, first.output()).toBe(0);
      expect(await third.closed, third.output()).toBe(0);
      expect(f.count("test")).toBe(1);
      expect(f.count("secret")).toBe(2);
      expect(third.output()).toContain("Reused 1/3 checks");
    } finally {
      await f.cleanup();
    }
  },
);

test("a failed owner provides no reusable evidence to the waiting gate", async () => {
  const f = await fixture();
  writeFileSync(join(f.control, "fail-once"), "fail");
  const first = f.start();
  try {
    await until(first, () => f.count("test") === 1, "owner readiness");
    const second = f.start();
    await waiting(second);
    f.release();
    expect(await first.closed, first.output()).toBe(1);
    expect(await second.closed, second.output()).toBe(0);
    expect(f.count("test")).toBe(2);
    expect(second.output()).not.toContain("Reused");
  } finally {
    await f.cleanup();
  }
});

test.each(["SIGTERM", "SIGKILL"] as const)(
  "%s of the owner cleans up workers before the waiting gate runs fresh",
  async (signal) => {
    const f = await fixture(),
      first = f.start();
    try {
      await until(first, () => existsSync(join(f.control, "running")), "owner command readiness");
      const pid = Number(readFileSync(join(f.control, "running"), "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      const second = f.start();
      await waiting(second);
      first.child.kill(signal);
      expect(await first.closed, first.output()).toBe(
        signal === "SIGKILL" || process.platform === "win32" ? null : 130,
      );
      await until(second, () => f.count("test") === 2, "waiting gate admission after cleanup");
      expect(() => process.kill(pid, 0)).toThrow();
      f.release();
      expect(await second.closed, second.output()).toBe(0);
      expect(f.count("secret")).toBe(1);
      expect(second.output()).not.toContain("Reused");
    } finally {
      await f.cleanup();
    }
  },
);
