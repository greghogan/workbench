import { join } from "node:path";
import { promised } from "./fixtures/promised.mjs";
import { expect, test } from "vitest";
import { withManagedProcesses } from "../scripts/managed-process.mjs";

test("cleanup attempts every action and preserves primary and cleanup failures", async () => {
  const actions: string[] = [];
  const before = process.listenerCount("SIGTERM");
  let failure;
  try {
    await withManagedProcesses((scope) =>
      promised(() => {
        scope.defer(() => actions.push("last"));
        scope.defer(() => {
          actions.push("failed");
          throw new Error("cleanup failure");
        });
        scope.defer(() => actions.push("first"));
        throw new Error("primary failure");
      }),
    );
  } catch (error) {
    failure = error;
  }
  expect(actions).toEqual(["first", "failed", "last"]);
  if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate process failure");
  expect(failure.errors.map((error: unknown) => (error instanceof Error ? error.message : String(error)))).toEqual([
    "primary failure",
    "cleanup failure",
  ]);
  expect(process.listenerCount("SIGTERM")).toBe(before);
});

test("process capture is bounded, preserves useful errors, and distinguishes absence from installed failure", async () => {
  await withManagedProcesses(async (scope) => {
    expect(await scope.run(process.execPath, ["-e", "process.stdout.write('hello')"], { capture: true })).toBe("hello");
    expect(await scope.run("workbench-no-such-manager-654321", [], { missing: true })).toBeUndefined();
    await expect(
      scope.run(process.execPath, ["-e", "process.exit(7)"], { capture: true, missing: true }),
    ).rejects.toThrow(/failed: 7/);
    await expect(
      // Keep the fixture alive until cancellation; racing natural exit can interrupt V8's report flush.
      scope.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000));setInterval(()=>{},1000)"], {
        capture: true,
        limit: 10,
      }),
    ).rejects.toThrow(/exceeds 10 bytes/);
  });
});

test.skipIf(process.platform === "win32")(
  "cancellation waits for the active child to exit before cleanup",
  async () => {
    const before = process.listenerCount("SIGINT");
    let pid: number;
    const order: string[] = [];
    await expect(
      withManagedProcesses(async (scope) => {
        scope.defer(() => {
          expect(() => process.kill(pid, 0)).toThrow();
          order.push("cleanup");
        });
        // This child notifies a separate short command through an IPC-free readiness file in the fixture below.
        const { mkdtempSync, readFileSync, existsSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const root = mkdtempSync(join(tmpdir(), "workbench-process-cancel-"));
        scope.defer(() => {
          rmSync(root, { recursive: true, force: true });
        });
        const ready = join(root, "ready");
        const pending = scope.run(process.execPath, [
          "-e",
          `const fs=require('node:fs'),ready=${JSON.stringify(ready)}; fs.writeFileSync(ready+'.partial',String(process.pid)); fs.renameSync(ready+'.partial',ready); setInterval(()=>{},1000)`,
        ]);
        const outcome = expect(pending).rejects.toThrow(/cancelled/);
        try {
          while (!existsSync(ready)) {
            await Promise.race([
              new Promise((resolve) => {
                setTimeout(resolve, 5);
              }),
              pending,
            ]);
          }
          pid = Number(readFileSync(ready, "utf8"));
          expect(pid).toBeGreaterThan(0);
          process.emit("SIGINT");
          await outcome;
          order.push("exited");
          throw new Error("cancelled");
        } finally {
          await Promise.allSettled([pending, outcome]);
        }
      }),
    ).rejects.toThrow(/cancelled/);
    expect(order).toEqual(["exited", "cleanup"]);
    expect(process.listenerCount("SIGINT")).toBe(before);
  },
);
