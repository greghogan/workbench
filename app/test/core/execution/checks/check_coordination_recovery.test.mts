import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { coordinationFixtures, processInstance } from "../../../fixtures/check-coordination.mjs";

const { fixture, until, waiting } = coordinationFixtures();

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
      const original = processInstance(pid);
      expect(original).toBeDefined();
      const second = f.start();
      await waiting(second);
      first.child.kill(signal);
      expect(await first.closed, first.output()).toBe(
        signal === "SIGKILL" || process.platform === "win32" ? null : 130,
      );
      await until(second, () => f.count("test") === 2, "waiting gate admission after cleanup");
      expect(processInstance(pid)).not.toBe(original);
      f.release();
      expect(await second.closed, second.output()).toBe(0);
      expect(f.count("secret")).toBe(1);
      expect(second.output()).not.toContain("Reused");
    } finally {
      await f.cleanup();
    }
  },
);
