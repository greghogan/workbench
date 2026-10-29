import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { withCheckCoordination, checkCoordinationDirectory } from "../src/check-coordination.ts";
import { CheckCancellation } from "../src/check-cancellation.ts";
import { buildLockDirectory } from "../src/builds.ts";
import { waitForCondition } from "./fixtures/coordination.mjs";

test("abandoned gate admission waits for the interrupted build's surviving child without stealing ownership", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-recovery-admission-")));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", root);
  vi.stubEnv("WORKBENCH_DATA_HOME", join(root, "data"));
  const retired = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  expect(retired.status).toBe(0);
  const child = spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const closed = once(child, "close");
  const cancellation = new CheckCancellation();
  let pending: Promise<void> | undefined;
  try {
    await once(child, "message");
    const owner = {
      version: 1,
      pid: retired.pid,
      host: hostname(),
      token: "recovery-fixture",
      launching: false,
      children: [] as { pid: number; group: boolean }[],
    };
    const gate = checkCoordinationDirectory(root),
      lock = buildLockDirectory({ checkout: root, root: ".", environment: "native", fingerprint: "a".repeat(24) });
    for (const path of [gate, lock]) mkdirSync(path, { recursive: true });
    writeFileSync(join(gate, "owner.json"), JSON.stringify(owner));
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ ...owner, children: [{ pid: child.pid, group: false }] }));
    const original = readFileSync(join(lock, "owner.json"), "utf8");
    const admission = vi.fn();
    const inspection = vi.spyOn(await import("../src/process-lock.ts"), "inspectProcessLock");
    pending = withCheckCoordination(root, cancellation, () => {
      admission();
      return Promise.resolve();
    });
    await waitForCondition(
      () => inspection.mock.calls.some(([path]) => path === lock),
      pending,
      "interrupted build inspection",
    );
    expect(admission).not.toHaveBeenCalled();
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(original);
    child.kill("SIGTERM");
    await closed;
    await pending;
    expect(admission).toHaveBeenCalledOnce();
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(original);
  } finally {
    cancellation.cancel();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
    await pending?.catch(() => undefined);
    cancellation.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
