import { afterEach, expect, test, vi } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheProjectFixture } from "./fixtures/cache-project.mjs";
import { projectCachePlan, applyProjectCachePlan } from "../src/project-cache.ts";
import { projectRegistration, Registration } from "../src/project-registry.ts";
const builderIssues = vi.hoisted(() => [] as string[]);
vi.mock("../src/builder-cache.ts", async (original) => ({
  ...(await original<typeof import("../src/builder-cache.ts")>()),
  inspectBuilderCache: () => ({ entries: [], issues: [...builderIssues] }),
}));
const fixtures: ReturnType<typeof cacheProjectFixture>[] = [];
afterEach(() => {
  builderIssues.splice(0);
  for (const fixture of fixtures.splice(0)) fixture.close();
});
test.each(["builders", "references"])(
  "unavailable %s inventory preserves registration and owned caches during removal",
  async (component) => {
    const f = cacheProjectFixture();
    fixtures.push(f);
    const root = f.project("preserved"),
      tool = f.install("4.0.1"),
      result = f.result(root, tool);
    if (component === "builders") builderIssues.push("Fixture builder inspection unavailable");
    else writeFileSync(join(f.base, "state/cache-tool-references.json"), "not json");
    const plan = await projectCachePlan(root);
    expect(plan.blocked.length).toBeGreaterThan(0);
    await expect(applyProjectCachePlan(plan, true)).rejects.toThrow("removal is blocked");
    expect(existsSync(result.directory)).toBe(true);
    expect(projectRegistration(root)).toBe(Registration.Registered);
  },
);

test("size refreshes preserve cleanup approval but replacement and protection changes invalidate it", async () => {
  const { invalidateCacheSize, measureCacheSize } = await import("../src/cache-size.ts");
  const { mkdirSync, rmSync } = await import("node:fs");
  const f = cacheProjectFixture();
  fixtures.push(f);
  const root = f.project("measurement"),
    tool = f.install("4.0.1"),
    result = f.result(root, tool);
  invalidateCacheSize(result.directory);
  const before = await projectCachePlan(root);
  const measurement = await measureCacheSize({ directory: result.directory, state: "pending" });
  expect(measurement.state).toBe("ready");
  expect((await projectCachePlan(root)).digest).toBe(before.digest);
  invalidateCacheSize(result.directory);
  expect((await projectCachePlan(root)).digest).not.toBe(before.digest);
  const current = await projectCachePlan(root);
  const lock = result.directory + ".lock";
  mkdirSync(lock);
  try {
    await expect(applyProjectCachePlan(current)).rejects.toThrow("changed");
  } finally {
    rmSync(lock, { recursive: true });
  }
});

test("deletion revalidates writer generations after acquiring admission and preserves the complete selection", async () => {
  const { inspectBuildCache, pruneBuildCache } = await import("../src/build-cache.ts");
  const { withCacheSizeChanges } = await import("../src/cache-size.ts");
  const f = cacheProjectFixture();
  fixtures.push(f);
  const root = f.project("writer"),
    tool = f.install("4.0.1"),
    result = f.result(root, tool),
    report = inspectBuildCache(root);
  withCacheSizeChanges([result.directory], () => {
    writeFileSync(join(result.directory, "output"), "new output");
  });
  await expect(pruneBuildCache({ report, dependencies: true, apply: true })).rejects.toThrow("generation changed");
  expect(existsSync(result.directory)).toBe(true);
  expect(existsSync(result.dependencies)).toBe(true);
});
