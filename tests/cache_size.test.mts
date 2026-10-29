import { totalBytes } from "../src/byte-size.ts";
import { cacheDeletionIdentity } from "../src/cache-plan-identity.ts";
import { installAsset } from "../src/tool-downloads.ts";
import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cacheAmount,
  cacheBytes,
  discoverCacheSizes,
  discoverCacheSizesAsync,
  measureCacheSize,
  invalidateCacheSize,
  withCacheSizeChanges,
} from "../src/cache-size.ts";
import { withCacheLock } from "../src/cache-lock.ts";
import { writeAtomic } from "../scripts/file-publication.mjs";
vi.mock("../scripts/file-publication.mjs", async (original) => {
  const actual = await original<typeof import("../scripts/file-publication.mjs")>();
  return { ...actual, writeAtomic: vi.fn(actual.writeAtomic) };
});
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
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
test("asynchronous inventory reuses saved sizes across awaits without leaking its discovery context", async () => {
  const root = fixture();
  const measured = await measureCacheSize(discover(root).size);
  writeFileSync(join(root, "nested/value"), "changed outside managed writers");
  const saved = await discoverCacheSizesAsync(async () => {
    await Promise.resolve();
    return cacheBytes(root);
  });
  expect(saved.value).toBe(3);
  expect(saved.sizes).toEqual([measured]);
  expect(cacheBytes(root)).toBe(31);
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

test("publishing a size estimate cannot recreate a cache deleted after the walk", async () => {
  const root = fixture();
  const before = await measureCacheSize(discover(root).size);
  const actual = await vi.importActual<typeof import("../scripts/file-publication.mjs")>(
    "../scripts/file-publication.mjs",
  );
  vi.mocked(writeAtomic).mockImplementationOnce((...args) => {
    rmSync(root, { recursive: true });
    actual.writeAtomic(...args);
  });
  expect(await measureCacheSize(before, true)).toMatchObject({ state: "error", bytes: before.bytes });
  expect(existsSync(root)).toBe(false);
});

test("a replacement cache is preserved instead of receiving a measurement from the old directory", async () => {
  const root = fixture();
  const before = await measureCacheSize(discover(root).size);
  const actual = await vi.importActual<typeof import("../scripts/file-publication.mjs")>(
    "../scripts/file-publication.mjs",
  );
  vi.mocked(writeAtomic).mockImplementationOnce((...args) => {
    rmSync(root, { recursive: true });
    mkdirSync(root);
    writeFileSync(join(root, "new-output"), "preserve");
    actual.writeAtomic(...args);
  });
  expect(await measureCacheSize(before, true)).toMatchObject({ state: "stale", bytes: before.bytes });
  expect(readFileSync(join(root, "new-output"), "utf8")).toBe("preserve");
  expect(existsSync(join(root, ".workbench-cache-size.json"))).toBe(false);
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

test("unknown cache measurements remain unknown and measurement publication preserves deletion identity", () => {
  const root = fixture();
  writeFileSync(join(root, "asset"), "payload");
  const result = discoverCacheSizes(() => cacheAmount(root));
  expect(result.value.bytes).toBeUndefined();
  expect(result.value.measurement.state).toBe("pending");
  expect(totalBytes([2, result.value.bytes])).toBeUndefined();
  expect(totalBytes([])).toBe(0);
  const before = cacheDeletionIdentity(root);
  writeFileSync(join(root, ".workbench-cache-size.json"), "measurement only");
  expect(cacheDeletionIdentity(root)).toEqual(before);
});
