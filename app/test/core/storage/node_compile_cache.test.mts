import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { pruneRuntimeCompileCache } from "../../../src/core/storage/node-compile-cache.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-node-cache-")));
  temporary.push(root);
  mkdirSync(join(root, "bundle"));
  const cache = join(root, "cache");
  const main = join(root, "bundle/main.cjs");
  const writeMain = (value: number) => {
    writeFileSync(
      main,
      `console.log(JSON.stringify({value:${String(value)},cache:require("node:module").getCompileCacheDir()??null}));`,
    );
  };
  writeMain(42);
  const launch = (overrides: NodeJS.ProcessEnv = {}) => {
    const env = { ...process.env };
    // This fixture exercises real bytecode caching, independently of outer test instrumentation.
    for (const key of [
      "NODE_COMPILE_CACHE",
      "NODE_DISABLE_COMPILE_CACHE",
      "NODE_V8_COVERAGE",
      "WORKBENCH_SUBPROCESS_COVERAGE",
      "WORKBENCH_EPHEMERAL_CHECKOUT",
    ])
      Reflect.deleteProperty(env, key);
    // Node propagates a parent's V8 coverage even into a custom environment unless explicitly cleared.
    env.NODE_V8_COVERAGE = "";
    const launcher = fileURLToPath(new URL("../../../../bundle/launcher.cjs", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {createRequire} from 'node:module'; const launcher=createRequire(import.meta.url)(${JSON.stringify(launcher)}); await launcher.launch(['--help'],undefined,${JSON.stringify(root)});`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_CACHE_HOME: cache, ...overrides },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { value: number; cache: string | null };
  };
  return { root, cache, launch, writeMain };
}

test("native-loaded commands reuse bytecode and execute changed source after a warm cache", () => {
  const f = fixture();
  const first = f.launch();
  expect(first.value).toBe(42);
  assert.ok(first.cache);
  expect(isAbsolute(relative(join(f.cache, "node-compile"), first.cache))).toBe(false);
  expect(relative(join(f.cache, "node-compile"), first.cache)).not.toMatch(/^\.\./);
  expect(readdirSync(join(f.cache, "node-compile"), { recursive: true }).length).toBeGreaterThan(1);
  expect(f.launch()).toEqual(first);
  expect(f.launch({ NODE_COMPILE_CACHE: "" })).toEqual(first);
  f.writeMain(43);
  expect(f.launch()).toEqual({ ...first, value: 43 });
});

test("an explicit Node cache location is respected without creating a Workbench cache", () => {
  const f = fixture(),
    cache = join(f.root, "explicit");
  const result = f.launch({ NODE_COMPILE_CACHE: cache });
  assert.ok(result.cache);
  expect(isAbsolute(relative(cache, result.cache))).toBe(false);
  expect(relative(cache, result.cache)).not.toMatch(/^\.\./);
  expect(existsSync(f.cache)).toBe(false);
});

test.each([
  "NODE_DISABLE_COMPILE_CACHE",
  "NODE_V8_COVERAGE",
  "WORKBENCH_SUBPROCESS_COVERAGE",
  "WORKBENCH_EPHEMERAL_CHECKOUT",
])("%s suppresses automatic compilation caching", (name) => {
  const f = fixture();
  const result = f.launch({
    [name]: ["NODE_DISABLE_COMPILE_CACHE", "WORKBENCH_EPHEMERAL_CHECKOUT"].includes(name)
      ? "1"
      : join(f.root, "coverage"),
  });
  expect(result).toEqual({ value: 42, cache: null });
  expect(existsSync(f.cache)).toBe(false);
});

test("commands still execute when compilation cache storage is unavailable", () => {
  const f = fixture();
  writeFileSync(f.cache, "not a directory");
  expect(f.launch()).toEqual({ value: 42, cache: null });
  expect(readFileSync(f.cache, "utf8")).toBe("not a directory");
});

test("bytecode retention removes aged regular files and empty generations, preserving fresh files and links", async () => {
  const f = fixture(),
    root = join(f.cache, "node-compile"),
    now = Date.UTC(2026, 10, 9);
  vi.stubEnv("WORKBENCH_CACHE_HOME", f.cache);
  for (const version of ["old-node", "current-node"]) mkdirSync(join(root, version), { recursive: true });
  const old = join(root, "old-node/bytecode"),
    fresh = join(root, "current-node/bytecode");
  writeFileSync(old, "old");
  writeFileSync(fresh, "fresh");
  utimesSync(old, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000));
  utimesSync(fresh, new Date(now), new Date(now));
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "preserved");
  symlinkSync(outside, join(root, "linked"), "junction");
  symlinkSync(outside, join(root, "current-node/linked"), "junction");
  await pruneRuntimeCompileCache(0, now);
  expect(existsSync(old)).toBe(true);
  await pruneRuntimeCompileCache(7, now);
  expect(existsSync(join(root, "old-node"))).toBe(false);
  expect(readFileSync(fresh, "utf8")).toBe("fresh");
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("preserved");
});

test("bytecode retention tolerates an absent cache and refuses a redirected cache root", async () => {
  const f = fixture();
  vi.stubEnv("WORKBENCH_CACHE_HOME", f.cache);
  await pruneRuntimeCompileCache(7);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "preserved");
  mkdirSync(f.cache);
  symlinkSync(outside, join(f.cache, "node-compile"), "junction");
  await expect(pruneRuntimeCompileCache(7)).rejects.toThrow(/symlinks/);
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("preserved");
});
