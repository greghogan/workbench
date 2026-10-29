import { required } from "../src/invariants.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runLocalCI } from "../src/local-ci.ts";
import { CIWorkspace } from "../src/ci-workspace.ts";
import { localCIFixture } from "./fixtures/local-ci-execution.mjs";
import type { CILifecycle } from "../src/ci-lifecycle.ts";

const { fixture } = localCIFixture();

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "interruption during preparation cleans the partial run without admitting jobs and restores signal handlers",
  async () => {
    const f = fixture();
    const counts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const snapshot = required(Object.getOwnPropertyDescriptor(CIWorkspace.prototype, "snapshot"), "Workspace method")
      .value as CIWorkspace["snapshot"];
    vi.spyOn(CIWorkspace.prototype, "snapshot").mockImplementation(async function (this: CIWorkspace, lifecycle) {
      expect(process.listenerCount("SIGINT")).toBe(required(counts[0], "Expected fixture value: counts[0]") + 1);
      const trees = await snapshot.call(this, lifecycle);
      lifecycle.interrupted = true;
      return trees;
    });
    await expect(runLocalCI(f.root)).rejects.toThrow(/Local CI failed/);
    const run = JSON.parse(
      readFileSync(join(f.reports(), "results.json"), "utf8"),
    ) as import("../scripts/ci-results.mjs").RunReport;
    expect(run.targets.every((target) => target.started === undefined)).toBe(true);
    expect(run.errors).toEqual([
      { phase: "interruption", message: expect.stringContaining("active mutations") as unknown },
    ]);
    expect(existsSync(join(f.slot, "workspace"))).toBe(false);
    expect(existsSync(join(f.slot, "jobs"))).toBe(false);
    expect(existsSync(join(f.slot, "active"))).toBe(false);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(counts);
  },
);

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "active and abandoned workspaces are preserved",
  async () => {
    const f = fixture();
    mkdirSync(join(f.slot, "active"), { recursive: true, mode: 0o700 });
    await expect(runLocalCI(f.root)).rejects.toThrow(/busy or needs recovery/);
    expect(existsSync(join(f.slot, "active"))).toBe(true);
    rmSync(join(f.slot, "active"), { recursive: true });
    mkdirSync(join(f.slot, "workspace"));
    writeFileSync(join(f.slot, "workspace/user-data"), "preserve");
    await expect(runLocalCI(f.root)).rejects.toThrow(/Preserving an existing/);
    expect(readFileSync(join(f.slot, "workspace/user-data"), "utf8")).toBe("preserve");
    expect(existsSync(join(f.slot, "active"))).toBe(false);
  },
);

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "the shutdown scope remains active through final cleanup and records an interruption without losing completed outcomes",
  async () => {
    const f = fixture();
    const counts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    let lifecycle: CILifecycle;
    const snapshot = required(Object.getOwnPropertyDescriptor(CIWorkspace.prototype, "snapshot"), "Workspace method")
      .value as CIWorkspace["snapshot"];
    const close = required(Object.getOwnPropertyDescriptor(CIWorkspace.prototype, "close"), "Workspace method")
      .value as CIWorkspace["close"];
    vi.spyOn(CIWorkspace.prototype, "snapshot").mockImplementation(async function (this: CIWorkspace, scope) {
      lifecycle = scope;
      return snapshot.call(this, scope);
    });
    vi.spyOn(CIWorkspace.prototype, "close").mockImplementation(async function (this: CIWorkspace) {
      expect(process.listenerCount("SIGTERM")).toBe(required(counts[1], "Expected fixture value: counts[1]") + 1);
      lifecycle.interrupted = true;
      return close.call(this);
    });
    await expect(runLocalCI(f.root)).rejects.toThrow(/Local CI failed/);
    const run = JSON.parse(
      readFileSync(join(f.reports(), "results.json"), "utf8"),
    ) as import("../scripts/ci-results.mjs").RunReport;
    expect(run.targets.every((target) => target.success)).toBe(true);
    expect(run.errors).toEqual([
      { phase: "interruption", message: expect.stringContaining("active mutations") as unknown },
    ]);
    expect(existsSync(join(f.slot, "active"))).toBe(false);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(counts);
  },
);
