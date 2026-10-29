import { installAsset } from "../src/tool-downloads.ts";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cacheBytes,
  discoverCacheSizes,
  measureCacheSize,
  invalidateCacheSize,
  withCacheSizeChanges,
} from "../src/cache-size.ts";
import { withCacheLock } from "../src/cache-lock.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-size-"));
  roots.push(root);
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested/value"), "abc");
  return root;
}
function discover(root: string) {
  const found = discoverCacheSizes(() => cacheBytes(root));
  const size = found.sizes[0];
  if (!size) throw new Error("Missing size discovery");
  return { ...found, size };
}
test("size estimates persist across discovery instances without walking unchanged directories", async () => {
  const root = fixture();
  expect(discover(root).size).toEqual({ directory: root, state: "pending" });
  const measured = await measureCacheSize(discover(root).size);
  expect(measured).toMatchObject({ state: "ready", bytes: 3 });
  expect(cacheBytes(root)).toBe(3);
  const saved = discover(root);
  expect(saved.value).toBe(3);
  expect(saved.size).toMatchObject(measured);
  // A cached discovery reads sidecar records only. Explicit invalidation is needed for nested writes.
  writeFileSync(join(root, "nested/value"), "longer value");
  expect(await measureCacheSize(saved.size)).toBe(saved.size);
  expect((await measureCacheSize(saved.size, true)).bytes).toBe(12);
});
test("a writer invalidates before and after changing nested files, retaining the last measured size", async () => {
  const root = fixture();
  await measureCacheSize(discover(root).size);
  await withCacheLock(root, async () => {
    expect(discover(root).size).toMatchObject({ state: "stale", bytes: 3 });
    writeFileSync(join(root, "nested/value"), "abcdef");
    await measureCacheSize(discover(root).size);
  });
  expect(discover(root).size).toMatchObject({ state: "stale", bytes: 6 });
  expect(await measureCacheSize(discover(root).size)).toMatchObject({ state: "ready", bytes: 6 });
});
test("directory replacement and malformed sidecars cannot reuse a measurement", async () => {
  const root = fixture();
  await measureCacheSize(discover(root).size);
  writeFileSync(join(root, ".workbench-cache-size.json"), "not json");
  expect(discover(root).size.state).toBe("pending");
  expect(await measureCacheSize(discover(root).size)).toMatchObject({ state: "ready", bytes: 3 });
  const previous = discover(root).size;
  rmSync(root, { recursive: true });
  mkdirSync(root);
  writeFileSync(join(root, "other"), "12345");
  invalidateCacheSize(root);
  expect(discover(root).size.state).toBe("pending");
  expect(await measureCacheSize(discover(root).size)).toMatchObject({ state: "ready", bytes: 5 });
  expect(previous.bytes).toBe(3);
});
test("a disappearing cache returns an explicit measurement failure and keeps the old estimate", async () => {
  const root = fixture();
  await measureCacheSize(discover(root).size);
  const old = discover(root).size;
  rmSync(root, { recursive: true });
  expect(await measureCacheSize(old, true)).toMatchObject({ state: "error", bytes: 3 });
});
test("size walks count symbolic links without following external contents", async () => {
  const root = fixture();
  symlinkSync(root, join(root, "nested/loop"), process.platform === "win32" ? "junction" : "dir");
  expect((await measureCacheSize(discover(root).size)).bytes).toBe(cacheBytes(root));
});

test("a command finishing after an intermediate measurement invalidates that measurement even on failure", async () => {
  const root = fixture();
  await measureCacheSize(discover(root).size);
  let reject!: (error: Error) => void;
  const command = new Promise<void>((_resolve, failed) => {
    reject = failed;
  });
  const running = withCacheSizeChanges([root], () => command);
  const rejected = expect(running).rejects.toThrow("Fixture failure");
  writeFileSync(join(root, "nested/value"), "abcdef");
  await measureCacheSize(discover(root).size);
  expect(discover(root).size.state).toBe("ready");
  reject(new Error("Fixture failure"));
  await rejected;
  expect(discover(root).size).toMatchObject({ state: "stale", bytes: 6 });
});

test("verifying an immutable installed artifact preserves its accepted size measurement", async () => {
  const root = fixture(),
    sha256 = "a".repeat(64);
  writeFileSync(join(root, ".workbench-artifact"), sha256 + "\n");
  const measured = await measureCacheSize(discover(root).size);
  await installAsset(root, { url: "https://example.invalid/tool.tar", sha256, format: "tar", strip: 0, bin: "bin" });
  expect(discover(root).size).toEqual(measured);
});
