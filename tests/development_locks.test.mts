import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { inspectDevelopmentLocks, recoverDevelopmentLock, DevelopmentLock } from "../src/development-locks.ts";
import { inspectCacheMetadataLock, CacheLockState } from "../src/cache-lock.ts";
const state = vi.hoisted(() => ({ directory: "", containers: "" }));
vi.mock("../src/buildkit.js", () => ({ projectBuildkitLock: () => join(state.directory, "buildkit") }));
vi.mock("../src/offline-profiles.js", () => ({
  offlineProfile: () => ({ builder: "native" }),
  offlineReceiptPath: (_root: string, name: string) => join(state.directory, name),
}));
vi.mock("../src/project-configuration.js", () => ({
  readConfig: () => ({ development: { profiles: [{ name: "native", offline: {} }] } }),
}));
vi.mock("../src/image-process.js", () => ({ imageQuery: () => state.containers }));
afterEach(() => {
  vi.restoreAllMocks();
  if (state.directory) rmSync(state.directory, { recursive: true, force: true });
});
function fixture() {
  state.directory = mkdtempSync(join(tmpdir(), "workbench-lock-recovery-"));
  state.containers = "";
  const target = join(state.directory, "native"),
    lock = `${target}.lock`,
    activity = `${target}.activity`;
  mkdirSync(lock);
  const owner = { pid: 12345, host: hostname(), token: randomUUID(), started: "2026-01-01T00:00:00Z", activity };
  writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (pid === 12345) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  return { target, lock, activity, owner };
}
test("inspected dead preparation ownership can recover only its exact reviewed lock", () => {
  const f = fixture();
  const inspected = inspectDevelopmentLocks("/fixture", "native")[0];
  expect(inspected?.recoverable).toBe(true);
  if (!inspected?.digest) throw new Error("Missing lock digest");
  expect(() => {
    recoverDevelopmentLock("/fixture", "native", DevelopmentLock.Profile, "a".repeat(64));
  }).toThrow(/changed since inspection/);
  expect(existsSync(f.lock)).toBe(true);
  recoverDevelopmentLock("/fixture", "native", DevelopmentLock.Profile, inspected.digest);
  expect(inspectCacheMetadataLock(f.target).state).toBe(CacheLockState.Unlocked);
});
test("surviving children, containers, foreign hosts and incomplete ownership prevent recovery", () => {
  const f = fixture();
  const check = () => {
    const inspected = inspectDevelopmentLocks("/fixture", "native")[0];
    expect(inspected?.recoverable).toBe(false);
    const digest = inspected?.digest;
    if (digest)
      expect(() => {
        recoverDevelopmentLock("/fixture", "native", DevelopmentLock.Profile, digest);
      }).toThrow();
    expect(existsSync(f.lock)).toBe(true);
  };
  state.containers = "workbench-builder-active";
  check();
  state.containers = "";
  mkdirSync(f.activity);
  writeFileSync(
    join(f.activity, "owner.json"),
    JSON.stringify({
      version: 1,
      pid: 12345,
      host: hostname(),
      token: randomUUID(),
      launching: false,
      children: [{ pid: 23456, group: false }],
    }),
  );
  check();
  rmSync(f.activity, { recursive: true });
  writeFileSync(join(f.lock, "owner.json"), JSON.stringify({ ...f.owner, host: "another-host" }));
  check();
  writeFileSync(join(f.lock, "owner.json"), JSON.stringify({ ...f.owner, activity: undefined }));
  check();
  expect(readFileSync(join(f.lock, "owner.json"), "utf8")).not.toContain("activity");
});

test("BuildKit recovery resolves its engine-bound lock without touching the managed-builder lock", () => {
  const f = fixture();
  const buildkit = join(state.directory, "buildkit.lock");
  mkdirSync(buildkit);
  writeFileSync(join(buildkit, "owner.json"), JSON.stringify(f.owner));
  const lock = inspectDevelopmentLocks("/fixture", "native").find((entry) => entry.kind === DevelopmentLock.Buildkit);
  const digest = lock?.digest;
  if (!digest) throw new Error("Missing inspected BuildKit digest");
  recoverDevelopmentLock("/fixture", "native", DevelopmentLock.Buildkit, digest);
  expect(existsSync(buildkit)).toBe(false);
  expect(existsSync(f.lock)).toBe(true);
});
