import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { acquireProcessLock, inspectProcessLock } from "../src/process-lock.ts";
import { required } from "../src/invariants.ts";
import { inspectToolCacheActivity } from "../src/tool-cache-lock.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-process-lock-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_CACHE_HOME", root);
  const lock = join(root, "locks", "checkout", "build");
  const retired = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  expect(retired.status).toBe(0);
  const owner = {
    version: 1,
    pid: retired.pid,
    host: hostname(),
    token: "fixture-owner",
    launching: false,
    children: [] as { pid: number; group: boolean }[],
  };
  const save = () => {
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
  };
  return { root, lock, owner, save };
}

test("a proven-dead tracked owner can be recovered without treating inspection as mutation", () => {
  const f = fixture();
  f.save();
  const prior = readFileSync(join(f.lock, "owner.json"), "utf8");
  expect(inspectProcessLock(f.lock).abandoned).toBe(true);
  expect(readFileSync(join(f.lock, "owner.json"), "utf8")).toBe(prior);
  const owner = required(acquireProcessLock(f.lock, true), "recovered owner");
  expect(inspectProcessLock(f.lock)).toEqual({ pid: process.pid, abandoned: false });
  expect(acquireProcessLock(f.lock, true)).toBeUndefined();
  owner.release();
  expect(existsSync(f.lock)).toBe(false);
});

test("maintenance can reclaim dead tracked build owners", () => {
  const f = fixture();
  f.save();
  expect(inspectToolCacheActivity().blockedBy).toBeUndefined();
  expect(existsSync(f.lock)).toBe(true);
  expect(inspectToolCacheActivity(true).blockedBy).toBeUndefined();
  expect(existsSync(f.lock)).toBe(false);
});

test.each(["foreign", "launching", "legacy", "damaged", "extra-file", "oversized"])(
  "%s ownership is preserved for inspection",
  (kind) => {
    const f = fixture();
    if (kind === "foreign") f.owner.host = `${hostname()}-foreign`;
    if (kind === "launching") f.owner.launching = true;
    f.save();
    if (kind === "legacy")
      writeFileSync(join(f.lock, "owner.json"), JSON.stringify({ pid: f.owner.pid, host: hostname() }));
    if (kind === "damaged") writeFileSync(join(f.lock, "owner.json"), "{");
    if (kind === "extra-file") writeFileSync(join(f.lock, "owner-next.json"), "unfinished update");
    if (kind === "oversized") writeFileSync(join(f.lock, "owner.json"), " ".repeat(256 * 1024 + 1));
    const prior = readFileSync(join(f.lock, "owner.json"), "utf8");
    expect(inspectProcessLock(f.lock).abandoned).toBe(false);
    expect(acquireProcessLock(f.lock, true)).toBeUndefined();
    expect(inspectToolCacheActivity(true).blockedBy).toBe(f.lock);
    expect(readFileSync(join(f.lock, "owner.json"), "utf8")).toBe(prior);
  },
);

test("a lock holder cannot release a replacement owner's lock", () => {
  const f = fixture();
  const owner = required(acquireProcessLock(f.lock), "owner");
  f.save();
  expect(() => {
    owner.release();
  }).toThrow("ownership changed");
  expect(JSON.parse(readFileSync(join(f.lock, "owner.json"), "utf8"))).toEqual(f.owner);
});

test.skipIf(process.platform === "win32")(
  "a surviving command group blocks stale-owner recovery and tool deletion",
  async () => {
    const f = fixture();
    const child = spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const closed = once(child, "close");
    try {
      await once(child, "message");
      f.owner.children = [{ pid: required(child.pid, "child pid"), group: true }];
      f.save();
      expect(inspectProcessLock(f.lock).abandoned).toBe(false);
      expect(acquireProcessLock(f.lock, true)).toBeUndefined();
      expect(inspectToolCacheActivity(true).blockedBy).toBe(f.lock);
      child.kill("SIGKILL");
      await closed;
      expect(inspectProcessLock(f.lock).abandoned).toBe(true);
      required(acquireProcessLock(f.lock, true), "recovered owner").release();
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  },
);

test("child registration records uncertainty before the fork and retains process ownership afterward", () => {
  const f = fixture();
  const owner = required(acquireProcessLock(f.lock, true), "owner");
  owner.beforeSpawn();
  const before = JSON.parse(readFileSync(join(f.lock, "owner.json"), "utf8")) as { launching: boolean };
  expect(before.launching).toBe(true);
  owner.spawned(f.owner.pid, false);
  const after = JSON.parse(readFileSync(join(f.lock, "owner.json"), "utf8")) as {
    launching: boolean;
    children: unknown[];
  };
  expect(after.launching).toBe(false);
  expect(after.children).toEqual([{ pid: f.owner.pid, group: false }]);
  owner.release();
});

test("release preserves an owned command that has not exited", () => {
  const f = fixture();
  const owner = required(acquireProcessLock(f.lock, true), "owner");
  owner.beforeSpawn();
  owner.spawned(process.pid, false);
  expect(() => {
    owner.release();
  }).toThrow("Owned processes may still be active");
  expect(existsSync(f.lock)).toBe(true);
});
