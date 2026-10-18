import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { expect, test } from "vitest";
import { readConfig } from "../src/core.ts";
import { required } from "../src/invariants.ts";
import { coordinationFixtures } from "./fixtures/check-coordination.mjs";

const { fixture, until, waiting } = coordinationFixtures();

test.skipIf(process.platform === "win32" || availableParallelism() < 2).each(["SIGINT", "SIGKILL"] as const)(
  "%s drains overlapping parent and child sessions before a waiting gate proceeds",
  async (signal) => {
    const f = await fixture();
    const childRoot = join(f.root, "child"),
      childControl = join(f.base, "child-control");
    mkdirSync(childRoot);
    mkdirSync(childControl);
    writeFileSync(join(childRoot, "source.txt"), "child input");
    const config = readConfig(f.root);
    const checks = required(config.check, "configured checks");
    checks.push(
      ...checks.map((check) => ({
        ...check,
        name: `child ${check.name}`,
        path: "child",
        command: [process.execPath, join(f.root, "step.mjs"), childControl, check.role],
      })),
    );
    config.check_order = [{ root: "child", after: ".", phase: "setup" }];
    writeFileSync(join(f.root, "workbench/config.toml"), stringify(config));
    f.git("add", ".");
    const first = f.start();
    try {
      await until(
        first,
        () => [f.control, childControl].every((path) => existsSync(join(path, "running"))),
        "both overlapping commands",
      );
      const pids = [f.control, childControl].map((path) => Number(readFileSync(join(path, "running"), "utf8")));
      const second = f.start();
      await waiting(second);
      first.child.kill(signal);
      expect(await first.closed, first.output()).toBe(signal === "SIGKILL" ? null : 130);
      await until(second, () => f.count("test") === 2, "waiting gate admission after overlapping cleanup");
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      expect([f.control, childControl].every((path) => existsSync(join(path, "cancelled")))).toBe(true);
      f.release();
      writeFileSync(join(childControl, "release"), "release");
      expect(await second.closed, second.output()).toBe(0);
      expect(second.output()).not.toContain("Reused");
    } finally {
      writeFileSync(join(childControl, "release"), "release");
      await f.cleanup();
    }
  },
);
