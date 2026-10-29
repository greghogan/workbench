import { afterEach, expect, test, vi } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { supersededBuilds } from "../src/build-retention.ts";
import { verifyBuildResults, inspectToolReferences } from "../src/tool-references.ts";
import { required } from "../src/invariants.ts";
import { inspectToolCache } from "../src/tool-cache.ts";
import { autoPrune } from "../src/auto-prune.ts";
import { withBuildLock } from "../src/builds.ts";
import { keepCacheAsset } from "../src/project-registry.ts";
import { cacheProjectFixture } from "./fixtures/cache-project.mjs";
import type { ToolReferences } from "../src/tool-references.ts";
import { stringify } from "smol-toml";
import { runChecks } from "../src/checks.ts";

afterEach(() => {
  vi.useRealTimers();
});

function evidence() {
  const references: ToolReferences = { results: [], issues: [] };
  const add = (name: string, used: number, verified?: number, root = ".", version = "1.0.0") => {
    const directory = `/cache/${name}`;
    const identity = { checkout: "/project", root, environment: "native" as const, fingerprint: name };
    references.results.push({
      directory,
      storageRoot: "/cache",
      identity,
      kind: "builds",
      tools: [{ tool: "node", version }],
      platform: "linux-x64",
      lastUsed: new Date(used).toISOString(),
      ...(verified === undefined ? {} : { verifiedAt: new Date(verified).toISOString() }),
    });
    return directory;
  };
  const select = (current = new Set<string>(), maxGenerations = 2, maxAgeDays = 0) =>
    supersededBuilds(references, current, { maxGenerations, maxAgeDays }, 20 * 86_400_000);
  return { add, select };
}

test("count retention requires a working replacement and preserves newer unverified attempts and current variants", () => {
  const e = evidence();
  const oldest = e.add("oldest", 100),
    previous = e.add("previous", 200);
  expect(e.select()).toEqual(new Set());
  const working = e.add("working", 300, 300);
  expect(e.select()).toEqual(new Set([oldest]));
  const attempted = e.add("attempted", 400);
  expect(e.select()).toEqual(new Set([oldest, previous]));
  expect(e.select(new Set([oldest]))).toEqual(new Set([previous]));
  expect(e.select(new Set([oldest, previous]))).toEqual(new Set());
  expect(e.select()).not.toContain(working);
  expect(e.select()).not.toContain(attempted);
});

test("age-off and count limits are independent, with separate roots and tool selections", () => {
  const e = evidence();
  const old = e.add("old", 1),
    otherRoot = e.add("other-root", 1, undefined, "library"),
    otherTools = e.add("other-tools", 1, undefined, ".", "2.0.0");
  e.add("working", 19 * 86_400_000, 19 * 86_400_000);
  expect(e.select(new Set(), 0, 0)).toEqual(new Set());
  expect(e.select(new Set(), 0, 7)).toEqual(new Set([old]));
  expect(e.select(new Set(), 1, 0)).toEqual(new Set([old]));
  expect(e.select(new Set(), 1, 0)).not.toContain(otherRoot);
  expect(e.select(new Set(), 1, 0)).not.toContain(otherTools);
});

test("superseded failed attempts do not accumulate while the working and latest generations remain available", () => {
  const e = evidence();
  const working = e.add("working", 100, 100);
  const failed = Array.from({ length: 8 }, (_, index) => e.add(`failed-${String(index)}`, 200 + index));
  expect(e.select()).toEqual(new Set(failed.slice(0, -1)));
  expect(e.select()).not.toContain(working);
});

test("real automatic pruning retires unchanged-tool generations while preserving active, kept and other-project outputs", async () => {
  const f = cacheProjectFixture();
  try {
    vi.useFakeTimers({ toFake: ["Date"] });
    const tool = f.install("4.0.1"),
      root = f.project("retention"),
      other = f.project("other");
    f.working(root, tool);
    const foreign = f.result(other, tool);
    const generations = [];
    for (let index = 0; index < 4; index++) {
      vi.setSystemTime(new Date(2026, 0, index + 1));
      writeFileSync(join(root, ".tool-versions"), `# build input generation ${String(index)}\n`);
      const paths = f.result(root, tool);
      verifyBuildResults([paths.directory, paths.dependencies]);
      generations.push(paths);
    }
    const oldest = required(generations[0], "old generation"),
      kept = required(generations[1], "kept generation"),
      working = required(generations[3], "working generation");
    expect(new Set(generations.map((entry) => entry.directory)).size).toBe(4);
    expect(
      inspectToolReferences().results.filter((entry) => entry.identity.checkout === root && entry.verifiedAt),
    ).toHaveLength(4);
    keepCacheAsset(kept.directory, true);
    expect(inspectToolCache(root).issues).toEqual([]);
    await withBuildLock(working, async () => {
      await autoPrune(root);
      expect(existsSync(oldest.directory)).toBe(true);
    });
    expect(await autoPrune(root)).toBe("finished");
    expect(existsSync(oldest.directory)).toBe(false);
    expect(existsSync(kept.directory)).toBe(true);
    expect(existsSync(working.directory)).toBe(true);
    expect(existsSync(foreign.directory)).toBe(true);
    expect(existsSync(tool.directory)).toBe(true);
  } finally {
    f.close();
  }
});

test("a failed configured gate retires older attempts without acknowledging the failure or deleting the working result", async () => {
  const f = cacheProjectFixture();
  try {
    const tool = f.install("4.0.1"),
      root = f.project("failed-gate");
    vi.stubEnv("WORKBENCH_PROJECT_ROOT", root);
    vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", undefined);
    writeFileSync(
      join(root, "workbench/config.toml"),
      stringify({
        schema_version: 1,
        markdown: { wrap_width: 120 },
        compatibility: { required: false },
        check: [{ name: "failure", role: "test", command: [process.execPath, "-e", "process.exit(17)"] }],
      }),
    );
    f.working(root, tool);
    vi.useFakeTimers({ toFake: ["Date"] });
    const generations = [];
    for (let index = 0; index < 4; index++) {
      vi.setSystemTime(new Date(2026, 0, index + 1));
      writeFileSync(join(root, ".tool-versions"), `# attempt ${String(index)}\n`);
      const paths = f.result(root, tool);
      if (index === 0) verifyBuildResults([paths.directory]);
      generations.push(paths);
    }
    vi.useRealTimers();
    await expect(runChecks(root, { stage: "commit", cache: false })).rejects.toThrow(/Check gate failed/);
    expect(generations.map((paths) => existsSync(paths.directory))).toEqual([true, false, false, true]);
    const references = inspectToolReferences();
    expect(references.issues).toEqual([]);
    expect(references.results.filter((entry) => entry.verifiedAt).map((entry) => entry.directory)).toEqual([
      required(generations[0], "working generation").directory,
    ]);
  } finally {
    f.close();
  }
});
