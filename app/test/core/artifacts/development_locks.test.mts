import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import {
  inspectDevelopmentLocks,
  recoverDevelopmentLock,
  DevelopmentLock,
} from "../../../src/core/artifacts/development-locks.ts";
import { inspectCacheMetadataLock, CacheLockState } from "../../../src/core/storage/cache-lock.ts";
import { imageProfileLock } from "../../../src/core/artifacts/image-contract.ts";
import { managedStoreCleanupActivity } from "../../../src/core/execution/environments/managed/managed-contract.mjs";
import { prepareManagedBuilderStore } from "../../../src/core/storage/managed-builder-store.ts";
const state = vi.hoisted(() => ({ directory: "", containers: "" }));
vi.mock("../../../src/core/artifacts/buildkit.js", () => ({
  projectBuildkitLock: () => join(state.directory, "buildkit"),
}));
vi.mock("../../../src/core/artifacts/offline-profiles.js", () => ({
  offlineProfile: () => ({ builder: "native" }),
}));
vi.mock("../../../src/core/projects/project-configuration.js", () => ({
  readConfig: () => ({ development: { profiles: [{ name: "native", offline: {} }] } }),
}));
vi.mock("../../../src/core/artifacts/image-process.js", () => ({ imageQuery: () => state.containers }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (state.directory) rmSync(state.directory, { recursive: true, force: true });
});
function fixture(architecture: string = process.arch) {
  state.directory = mkdtempSync(join(tmpdir(), "workbench-lock-recovery-"));
  state.containers = "";
  vi.stubEnv("WORKBENCH_CACHE_HOME", state.directory);
  const target = imageProfileLock("/fixture", "native", architecture),
    lock = `${target}.lock`,
    activity = `${target}.activity`;
  mkdirSync(lock, { recursive: true });
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

test("an emulated build is recovered through its own operation lock", () => {
  const architecture = process.arch === "arm64" ? "x64" : "arm64";
  const f = fixture(architecture);
  expect(inspectDevelopmentLocks("/fixture", "native")[0]?.state).toBe(CacheLockState.Unlocked);
  const lock = inspectDevelopmentLocks("/fixture", "native", architecture)[0];
  expect(lock?.recoverable).toBe(true);
  if (!lock?.digest) throw new Error("Missing emulated build lock digest");
  recoverDevelopmentLock("/fixture", "native", DevelopmentLock.Profile, lock.digest, architecture);
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

test("abandoned cleanup locks require both drained owned processes and absent Docker containers", async () => {
  const f = fixture();
  const activity = managedStoreCleanupActivity(state.directory, "nix");
  writeFileSync(join(f.lock, "owner.json"), JSON.stringify({ ...f.owner, activity }));
  mkdirSync(activity, { recursive: true });
  const processReceipt = {
    version: 1,
    pid: f.owner.pid,
    host: f.owner.host,
    token: f.owner.token,
    launching: false,
    children: [{ pid: 23456, group: false }],
  };
  const activityFile = join(activity, "owner.json");
  writeFileSync(activityFile, JSON.stringify(processReceipt));
  expect(inspectDevelopmentLocks("/fixture", "native")[0]?.recoverable).toBe(false);
  await expect(prepareManagedBuilderStore("nix", `sha256:${"a".repeat(64)}`)).rejects.toThrow(
    /cleanup is active or needs recovery/,
  );
  writeFileSync(activityFile, JSON.stringify({ ...processReceipt, children: [] }));
  state.containers = "cleanup-container";
  expect(inspectDevelopmentLocks("/fixture", "native")[0]?.recoverable).toBe(false);
  state.containers = "";
  const lock = inspectDevelopmentLocks("/fixture", "native")[0];
  if (!lock?.digest) throw new Error("Missing inspected profile digest");
  expect(lock.recoverable).toBe(true);
  recoverDevelopmentLock("/fixture", "native", DevelopmentLock.Profile, lock.digest);
  expect(inspectCacheMetadataLock(f.target).state).toBe(CacheLockState.Unlocked);
});
