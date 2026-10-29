import { required } from "../src/invariants.ts";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  inspectBuilderCache,
  recordBuilderVolumes,
  pruneBuilderCache,
  currentBuilderCacheKeys,
} from "../src/builder-cache.ts";

const state = vi.hoisted(() => ({
  volumes: [] as { Name: string; CreatedAt: string }[],
  links: 0,
  removed: [] as string[],
  usageAvailable: true,
}));
vi.mock("../src/docker-query.js", () => ({
  dockerQuery: (args: string[]) => {
    const result = spawnSync("docker", args, { encoding: "utf8" });
    if (result.error || result.status !== 0) return Promise.reject(new Error(result.stderr, { cause: result.error }));
    return Promise.resolve(result.stdout.trim());
  },
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: vi.fn(
    (
      command: string,
      args: string[],
      options: SpawnSyncOptionsWithStringEncoding,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const result = spawnSync(command, args, options);
      callback(result.status === 0 ? null : new Error(result.stderr), result.stdout, result.stderr);
    },
  ),
  spawnSync: vi.fn((command: string, args: string[]) => {
    if (command !== "docker") throw new Error("unexpected command");
    let result;
    if (args[0] === "info") result = "probe-engine";
    else if (args[0] === "ps") result = state.links ? "attached-container" : "";
    else if (args[0] === "system") {
      if (!state.usageAvailable) throw new Error("usage unavailable");
      result = state.volumes.map((volume, index) => ({
        ...volume,
        Links: String(state.links),
        Size: index ? "2MB" : "1.5GB",
      }));
    } else if (args[1] === "ls") result = state.volumes.map((volume) => volume.Name).join("\n");
    else if (args[1] === "inspect") result = state.volumes;
    else if (args[1] === "rm") {
      state.removed.push(...args.slice(2));
      state.volumes = [];
      result = "removed";
    } else throw new Error("unexpected Docker operation");
    return { status: 0, stdout: typeof result === "string" ? result : JSON.stringify(result), stderr: "" };
  }),
}));
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
  state.links = 0;
  state.removed = [];
  state.usageAvailable = true;
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-builder-cache-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  const key = "a".repeat(24);
  state.volumes = ["store", "state"].map((role) => ({
    Name: `workbench-guix-${key}-${role}`,
    CreatedAt: "2026-10-19T00:00:00Z",
  }));
  return { root, key };
}
test("metadata-only builder inspection preserves attachment protection when usage measurement is unavailable", async () => {
  const { root, key } = fixture();
  vi.stubEnv("WORKBENCH_IMAGE_INPUTS", "b".repeat(64));
  await recordBuilderVolumes(root, "guix", key);
  expect(currentBuilderCacheKeys(root, "guix", "b".repeat(64))).toEqual([`guix-${key}`]);
  expect(currentBuilderCacheKeys(root, "guix", "c".repeat(64))).toEqual([]);
  state.usageAvailable = false;
  const report = await inspectBuilderCache(root, undefined, false);
  expect(report.issues).toEqual([]);
  expect(report.entries[0]?.bytes).toBeUndefined();
  state.links = 1;
  expect((await inspectBuilderCache(root, undefined, false)).entries[0]?.blockedBy).toMatch(/attached/);
  await expect(pruneBuilderCache(report)).rejects.toThrow(/became active/);
  expect(state.removed).toEqual([]);
});
test("Docker store/state volumes are one owned cache group; unregistered volumes cannot be deleted", async () => {
  const { root, key } = fixture();
  expect(
    required((await inspectBuilderCache()).entries[0], "Expected fixture value: inspectBuilderCache().entries[0]")
      .blockedBy,
  ).toMatch(/ownership receipt/);
  await recordBuilderVolumes(root, "guix", key);
  const report = await inspectBuilderCache(root);
  expect(report.entries).toHaveLength(1);
  expect(required(report.entries[0], "Expected fixture value: report.entries[0]").bytes).toBe(1502000000);
  expect(required(report.entries[0], "Expected fixture value: report.entries[0]").blockedBy).toBeUndefined();
  await pruneBuilderCache(report);
  expect(state.removed).toHaveLength(2);
  expect((await inspectBuilderCache(root)).entries).toEqual([]);
});
test.each(["attached", "replaced", "locked"])("Docker pruning preserves a cache that becomes %s", async (condition) => {
  const { root, key } = fixture();
  await recordBuilderVolumes(root, "guix", key);
  const report = await inspectBuilderCache(root);
  if (condition === "attached") state.links = 1;
  if (condition === "replaced")
    required(state.volumes[0], "Expected fixture value: state.volumes[0]").CreatedAt = "2026-10-19T00:00:01Z";
  if (condition === "locked")
    mkdirSync(`${String(required(report.entries[0], "Expected fixture value: report.entries[0]").lock)}.lock`);
  await expect(pruneBuilderCache(report)).rejects.toThrow();
  expect(state.removed).toEqual([]);
});
test("Docker pruning never includes a neighbouring volume absent from the ownership receipt", async () => {
  const { root, key } = fixture();
  state.volumes = [{ ...required(state.volumes[0], "Owned volume"), Name: `workbench-nix-${key}-store` }];
  await recordBuilderVolumes(root, "nix", key);
  const report = await inspectBuilderCache(root);
  state.volumes.push({ ...required(state.volumes[0], "Owned volume"), Name: `workbench-nix-${key}-state` });
  await expect(pruneBuilderCache(report)).rejects.toThrow();
  expect(state.removed).toEqual([]);
});
