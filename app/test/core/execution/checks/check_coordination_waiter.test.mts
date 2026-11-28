import { expect, test } from "vitest";
import { coordinationFixtures } from "../../../fixtures/check-coordination.mjs";

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
