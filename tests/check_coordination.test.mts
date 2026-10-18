import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { waitForCondition } from "./fixtures/coordination.mjs";
import { required } from "../src/invariants.ts";
import { coordinationFixtures } from "./fixtures/check-coordination.mjs";

const { fixture, until, waiting } = coordinationFixtures();

test("a staged gate waits for matching working-tree evidence and refreshes only setup and security", async () => {
  const f = await fixture();
  const first = f.start();
  try {
    await waitForCondition(
      () => f.count("test") === 1,
      first.closed.then(() => {
        throw new Error(first.output());
      }),
      "first gate readiness",
    );
    const snapshot = join(f.base, "snapshot");
    mkdirSync(snapshot);
    f.git("checkout-index", "--all", `--prefix=${snapshot}/`);
    const second = f.start(snapshot, { WORKBENCH_EPHEMERAL_CHECKOUT: "1", WORKBENCH_LOCAL_CONFIG_ROOT: f.root });
    await waitForCondition(
      () => second.output().includes("Waiting for another check gate") || f.count("test") > 1,
      second.closed,
      "gate waiting acknowledgment",
    );
    expect(second.output()).toContain("Waiting for another check gate");
    expect(f.count("test")).toBe(1);
    f.release();
    expect(await first.closed, first.output()).toBe(0);
    expect(await second.closed, second.output()).toBe(0);
    expect(f.count("test")).toBe(1);
    expect(f.count("secret")).toBe(2);
    expect(second.output()).toContain("Reused 1/3 checks");
  } finally {
    await f.cleanup();
  }
});

test("independent checkouts sharing a cache can run gates concurrently", async () => {
  const f = await fixture(),
    first = f.start();
  try {
    await until(first, () => f.count("test") === 1, "owner readiness");
    const other = join(f.base, "other-checkout");
    mkdirSync(other);
    f.git("checkout-index", "--all", `--prefix=${other}/`);
    expect(spawnSync("git", ["-C", other, "init", "-q"]).status).toBe(0);
    const second = f.start(other);
    await until(second, () => f.count("test") === 2, "independent checkout admission");
    expect(second.output()).not.toContain("Waiting for another check gate");
    f.release();
    expect(await first.closed, first.output()).toBe(0);
    expect(await second.closed, second.output()).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("--no-cache waits for ownership and then runs every check fresh", async () => {
  const f = await fixture(),
    first = f.start();
  try {
    await until(first, () => f.count("test") === 1, "owner readiness");
    const second = f.start(f.root, {}, ["--no-cache"]);
    await waiting(second);
    f.release();
    expect(await first.closed, first.output()).toBe(0);
    expect(await second.closed, second.output()).toBe(0);
    expect(f.count("test")).toBe(2);
    expect(f.count("secret")).toBe(2);
    expect(second.output()).toContain("Running fresh checks (--no-cache)");
  } finally {
    await f.cleanup();
  }
});

test("waiting gates reread edited commands and inputs before deciding whether evidence matches", async () => {
  const f = await fixture(),
    first = f.start();
  try {
    await until(first, () => f.count("test") === 1, "owner readiness");
    const second = f.start();
    await waiting(second);
    required(
      f.config.check.find((check) => check.role === "test"),
      "fixture test check",
    ).command[3] = "replacement";
    f.save();
    f.release();
    expect(await first.closed, first.output()).toBe(0);
    expect(await second.closed, second.output()).toBe(0);
    expect(f.count("test")).toBe(1);
    expect(f.count("replacement")).toBe(1);
    expect(second.output()).not.toContain("Reused");
  } finally {
    await f.cleanup();
  }
});

test("waiting gates validate records again after admission", async () => {
  const f = await fixture(),
    first = f.start();
  try {
    await until(first, () => f.count("test") === 1, "owner readiness");
    const second = f.start();
    await waiting(second);
    rmSync(join(f.root, "workbench/CHARTER.md"));
    f.release();
    expect(await first.closed, first.output()).toBe(0);
    expect(await second.closed, second.output()).toBe(1);
    expect(second.output()).toContain("CHARTER.md");
    expect(f.count("setup")).toBe(1);
  } finally {
    await f.cleanup();
  }
});
