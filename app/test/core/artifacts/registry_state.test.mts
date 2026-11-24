import { registerConsumingProject } from "../../../src/core/projects/project-registration.ts";
import { afterEach, expect, test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { withCacheLock } from "../../../src/core/storage/cache-lock.ts";
import { recoverProjectRegistry, keepCacheAsset } from "../../../src/core/projects/project-registry.ts";
import { BoundedState } from "../../../src/core/storage/bounded-state.ts";
import { collectCacheInventory } from "../../../src/server/cache/cache-inventory.ts";
import { cacheProjectFixture } from "../../fixtures/cache-project.mjs";
const fixtures: ReturnType<typeof cacheProjectFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function fixture() {
  const value = cacheProjectFixture();
  fixtures.push(value);
  return value;
}
test("cancelled registry waiters leave durable state unchanged and admitted edits validate before writing", async () => {
  const f = fixture(),
    root = f.project("registered"),
    file = join(f.base, "state/projects.json"),
    before = readFileSync(file, "utf8");
  let unlock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const held = withCacheLock(join(f.base, "state/project-registry"), () => blocked);
  const controller = new AbortController();
  const writing = registerConsumingProject(root, controller.signal);
  const rejected = expect(writing).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
  expect(readFileSync(file, "utf8")).toBe(before);
  unlock();
  await held;
  expect(() => {
    keepCacheAsset("relative-path", true);
  }).toThrow("Invalid project registry");
  expect(readFileSync(file, "utf8")).toBe(before);
});
test("registry lock recovery refuses live and foreign writers but releases a proven abandoned local writer", () => {
  const f = fixture();
  f.project("registered");
  const lock = join(f.base, "state/project-registry.lock");
  mkdirSync(lock);
  const owner = (pid: number, host = hostname()) => {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid, host, token: randomUUID() }));
  };
  owner(process.pid);
  expect(() => {
    recoverProjectRegistry();
  }).toThrow("still active");
  expect(existsSync(lock)).toBe(true);
  owner(process.pid, "foreign-host");
  expect(() => {
    recoverProjectRegistry();
  }).toThrow("uncertain");
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  expect(child.status).toBe(0);
  owner(child.pid);
  recoverProjectRegistry();
  expect(existsSync(lock)).toBe(false);
});
test("bounded state validates both directions and rejects oversized writes before replacing the last good value", () => {
  const f = fixture(),
    path = join(f.base, "state/small.json");
  const state = new BoundedState(
    () => path,
    16,
    (value) => {
      if (typeof value !== "string") throw new Error("Expected string");
      return value;
    },
    () => "empty",
  );
  expect(state.read()).toBe("empty");
  state.write("small");
  expect(state.read()).toBe("small");
  expect(() => {
    state.write("a".repeat(20));
  }).toThrow("size limit");
  expect(state.read()).toBe("small");
  writeFileSync(path, "42");
  expect(() => state.read()).toThrow("Expected string");
  writeFileSync(path, "not json");
  expect(() => state.read()).toThrow(`${path}: invalid JSON`);
  assert.throws(
    () => state.read(),
    (error: unknown) => error instanceof Error && error.cause instanceof SyntaxError,
  );
});
test("unavailable requirements protect assets without claiming every tool as an actual consumer", async () => {
  const f = fixture(),
    root = f.project("available"),
    missing = f.project("missing"),
    tool = f.install("4.0.1");
  f.working(root, tool);
  const { rmSync } = await import("node:fs");
  rmSync(missing, { recursive: true });
  const value = await collectCacheInventory();
  const entry = value.inventory.tools?.entries[0];
  expect(entry).toBeDefined();
  expect(value.consumers[entry?.id ?? ""]).toEqual([root]);
  expect(value.uncertainConsumers).toEqual([missing]);
  expect(entry?.protections).toContainEqual({
    kind: "unavailable-project",
    project: missing,
    reason: `requirements unavailable: ${missing}`,
  });
  expect(value.issues.some((issue) => issue.component === "requirements")).toBe(false);

  const malformed = f.project("malformed");
  writeFileSync(join(malformed, "workbench/projects.toml"), "invalid TOML = [");
  const changed = await collectCacheInventory();
  expect(changed.uncertainConsumers.sort()).toEqual([missing, malformed].sort());
  expect(changed.consumers[entry?.id ?? ""]).toEqual([root]);
  expect(changed.issues).toContainEqual(expect.objectContaining({ component: "requirements", path: malformed }));
  for (const path of [missing, malformed])
    expect(changed.inventory.tools?.entries[0]?.protections).toContainEqual({
      kind: "unavailable-project",
      project: path,
      reason: `requirements unavailable: ${path}`,
    });
});
test("registry corruption does not hide independently discoverable build caches", async () => {
  const f = fixture(),
    root = f.project("available"),
    tool = f.install("4.0.1"),
    result = f.result(root, tool);
  writeFileSync(join(f.base, "state/projects.json"), "not json");
  const value = await collectCacheInventory();
  expect(value.inventory.entries.some((entry) => entry.directory === result.directory)).toBe(true);
  expect(value.issues.some((issue) => issue.component === "registry")).toBe(true);
  expect(value.inventory.tools).toBeUndefined();
});
test("builder ownership corruption retains independently discoverable caches and reports the failed component", async () => {
  const f = fixture(),
    root = f.project("available"),
    tool = f.install("4.0.1"),
    result = f.result(root, tool);
  const directory = join(f.base, "cache/docker-builders");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `workbench-buildkit-${"b".repeat(24)}.json`), "not json");
  const value = await collectCacheInventory();
  expect(value.inventory.entries.some((entry) => entry.directory === result.directory)).toBe(true);
  expect(value.inventory.builders?.entries).toEqual([]);
  expect(value.issues).toContainEqual(expect.objectContaining({ component: "builders", phase: "discovery" }));
});
test("inventory cancellation is propagated rather than reported as partial success", async () => {
  const f = fixture();
  f.project("available");
  const controller = new AbortController();
  controller.abort();
  await expect(collectCacheInventory(undefined, false, undefined, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});
