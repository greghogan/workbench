import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { acquireProcessLock } from "../src/process-lock.ts";
import { CheckCancellation } from "../src/check-cancellation.ts";
import { runOwnedChild } from "../scripts/owned-child.mjs";
import { spawnWindowsProcess, type WindowsProcessOutcome } from "../scripts/windows-process.mjs";

vi.mock("../scripts/windows-process.mjs", async (original) => ({
  ...(await original<typeof import("../scripts/windows-process.mjs")>()),
  spawnWindowsProcess: vi.fn(),
}));

const roots: string[] = [];
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Uninitialized fixture gate");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
const platform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-owned-protocol-"));
  roots.push(root);
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "pipe", "pipe"] });
  await once(child, "close");
  const owner = acquireProcessLock(join(root, "owner"), true);
  if (!owner) throw new Error("Missing fixture owner");
  const completion = deferred<WindowsProcessOutcome>();
  const admitted = deferred<boolean>();
  const dispose = vi.fn(() => {
    // Job evidence is established before private cleanup; the caller's resource is still held here.
    expect(() => {
      owner.assertIdle();
    }).toThrow(/active/);
    return Promise.resolve();
  });
  const cancel = vi.fn();
  const admit = vi.fn(() => {
    admitted.resolve(true);
    return Promise.resolve();
  });
  vi.mocked(spawnWindowsProcess).mockResolvedValue({
    child,
    directory: join(root, "supervisor"),
    ready: Promise.resolve(),
    admit,
    cancel,
    completion: completion.promise,
    dispose,
  });
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  writeFileSync(join(root, "payload"), "preserve");
  const run = () =>
    runOwnedChild("fixture", [], {
      cwd: root,
      env: process.env,
      signal: new AbortController().signal,
      owner,
      output(out, err) {
        out.resume();
        err.resume();
      },
    });
  return { root, child, owner, completion, admitted, admit, dispose, cancel, run };
}

test("an exited Windows supervisor retains ownership until job-empty proof and cleanup complete", async () => {
  const f = await fixture();
  const running = f.run();
  await f.admitted.promise;
  expect(() => {
    f.owner.assertIdle();
  }).toThrow(/active/);
  expect(() => {
    f.owner.release();
  }).toThrow(/active/);
  f.completion.resolve({ pid: f.child.pid ?? 0, status: 7, jobEmpty: true });
  expect(await running).toMatchObject({ status: 7, signal: null });
  expect(f.dispose).toHaveBeenCalledOnce();
  f.owner.release();
  expect(existsSync(join(f.root, "owner"))).toBe(false);
  expect(readFileSync(join(f.root, "payload"), "utf8")).toBe("preserve");
});

test("missing job-empty proof permanently retains resources after the supervisor exits", async () => {
  const f = await fixture();
  const running = f.run();
  await f.admitted.promise;
  f.completion.resolve({ pid: 0, status: null, jobEmpty: false, error: new Error("Invalid completion proof") });
  expect(await running).toMatchObject({ descendantsActive: true });
  expect(f.dispose).not.toHaveBeenCalled();
  expect(() => {
    f.owner.release();
  }).toThrow(/uncertain/);
  const saved: unknown = JSON.parse(readFileSync(join(f.root, "owner/owner.json"), "utf8"));
  expect(saved).toMatchObject({ uncertain: true });
  expect(readFileSync(join(f.root, "payload"), "utf8")).toBe("preserve");
});

test("failed ownership registration cancels preparation without admitting the Windows target", async () => {
  const f = await fixture();
  vi.spyOn(f.owner, "spawned").mockImplementation(() => {
    throw new Error("Owner changed");
  });
  f.completion.resolve({ pid: 0, status: null, jobEmpty: true });
  const result = await f.run();
  expect(result.error?.message).toBe("Owner changed");
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.admit).not.toHaveBeenCalled();
});

test("Windows check commands forward the root status only after confirmed job cleanup", async () => {
  const f = await fixture();
  const cancellation = new CheckCancellation("Fixture command");
  const status = vi.fn<(value: number) => void>();
  try {
    const running = cancellation.execute(["fixture"], f.root, process.env, true, f.owner, status);
    await Promise.race([
      f.admitted.promise,
      running.then(() => {
        throw new Error("Command completed before supervised admission");
      }),
    ]);
    expect(status).not.toHaveBeenCalled();
    expect(() => {
      f.owner.assertIdle();
    }).toThrow(/active/);
    f.completion.resolve({ pid: f.child.pid ?? 0, status: 23, jobEmpty: true });
    await running;
    expect(status).toHaveBeenCalledExactlyOnceWith(23);
    f.owner.release();
  } finally {
    cancellation.close();
  }
});
