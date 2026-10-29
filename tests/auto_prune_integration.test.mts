import { afterEach, expect, test } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { invalidateCacheSize } from "../src/cache-size.ts";
import { inspectToolReferences } from "../src/tool-references.ts";
import { cacheProjectFixture } from "./fixtures/cache-project.mjs";
import { autoPrune } from "../src/auto-prune.ts";
import { keepCacheAsset, registeredProjects } from "../src/project-registry.ts";
import { collectCacheInventory } from "../src/web/cache-inventory.ts";
const fixtures: ReturnType<typeof cacheProjectFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function fixture() {
  const value = cacheProjectFixture();
  fixtures.push(value);
  return value;
}
test("size invalidation metadata alone does not retain a removed build result or its tool references", () => {
  const f = fixture(),
    tool = f.install("4.0.1"),
    root = f.project("empty");
  const paths = f.result(root, tool);
  rmSync(join(paths.directory, "output"));
  invalidateCacheSize(paths.directory, true);
  expect(inspectToolReferences().results).toEqual([]);
});
test("two consumers release a shared installation only after both have working replacements and their old results are retired", async () => {
  const f = fixture(),
    old = f.install("4.0.1"),
    replacement = f.install("4.0.2");
  const first = f.project("first"),
    second = f.project("second");
  f.working(first, old);
  f.working(second, old);
  const a = f.result(first, old),
    b = f.result(second, old);
  f.working(first, replacement);
  await autoPrune(first);
  expect(existsSync(a.directory)).toBe(false);
  expect(existsSync(b.directory)).toBe(true);
  expect(existsSync(old.directory)).toBe(true);
  f.working(second, replacement);
  await autoPrune(second);
  expect(existsSync(b.directory)).toBe(false);
  expect(existsSync(old.directory)).toBe(false);
  expect(existsSync(replacement.directory)).toBe(true);
  expect(registeredProjects()).toHaveLength(2);
});
test("explicitly retained old results continue to protect tools even after replacements work", async () => {
  const f = fixture(),
    old = f.install("4.0.1"),
    replacement = f.install("4.0.2"),
    root = f.project("retained");
  f.working(root, old);
  const result = f.result(root, old);
  keepCacheAsset(result.directory, true);
  f.working(root, replacement);
  await autoPrune(root);
  expect(existsSync(result.directory)).toBe(true);
  expect(existsSync(old.directory)).toBe(true);
  keepCacheAsset(result.directory, false);
  await autoPrune(root);
  expect(existsSync(result.directory)).toBe(false);
  expect(existsSync(old.directory)).toBe(false);
});
test("metadata publishes before size measurements and completed scans reuse persistent estimates", async () => {
  const f = fixture(),
    tool = f.install("4.0.1"),
    root = f.project("sizes");
  f.working(root, tool);
  f.result(root, tool);
  const phases: string[] = [],
    value = await collectCacheInventory((event) => {
      phases.push(event.kind);
      if (event.kind === "metadata") expect(event.value.sizes.some((size) => size.state === "pending")).toBe(true);
    });
  expect(phases[0]).toBe("metadata");
  expect(phases).toContain("size");
  expect(value.sizes.every((size) => size.state === "ready")).toBe(true);
  const repeated: string[] = [];
  const next = await collectCacheInventory((event) => repeated.push(event.kind));
  expect(repeated).toEqual(["metadata"]);
  expect(next.sizes).toEqual(value.sizes);
});
