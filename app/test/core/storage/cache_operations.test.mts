import { afterEach, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  inspectCacheOperations,
  recoverCacheDestination,
  recoverCacheOperation,
  removeOwnedCache,
  withCacheInstallation,
} from "../../../src/core/storage/cache-operations.ts";
import { measureCacheSize } from "../../../src/core/storage/cache-size.ts";
import { startLogRun, finishLogRun, pruneLogRuns } from "../../../src/core/storage/logs/log-storage.ts";
import { createHash, randomUUID } from "node:crypto";
import { userDirectory } from "../../../src/core/storage/storage.ts";
import { LogCompressionPreference } from "../../../src/core/diagnostics/diagnostic-contract.mjs";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
const remove = vi.mocked(rm).getMockImplementation();
const roots: string[] = [];
afterEach(() => {
  if (remove) vi.mocked(rm).mockImplementation(remove);
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-cache-operation-"));
  roots.push(root);
  const directory = join(root, "asset");
  mkdirSync(directory);
  writeFileSync(join(directory, "value"), "old generated files");
  return { root, directory };
}
async function interrupted() {
  const value = fixture();
  vi.mocked(rm).mockImplementationOnce((path) => {
    for (const name of readdirSync(path)) rmSync(join(String(path), name), { recursive: true });
    return Promise.reject(Object.assign(new Error("Injected partial deletion"), { code: "EIO" }));
  });
  await expect(removeOwnedCache(value.directory)).rejects.toMatchObject({ code: "EIO" });
  const entry = inspectCacheOperations(value.root)[0];
  if (!entry) throw new Error("Missing interrupted cache operation");
  return { ...value, entry };
}
test("partial deletion retains external ownership evidence and recovery preserves a replacement destination", async () => {
  const { root, directory, entry } = await interrupted();
  expect(existsSync(directory)).toBe(false);
  expect(entry).toMatchObject({ action: "delete", state: "pending", target: directory });
  mkdirSync(directory);
  writeFileSync(join(directory, "value"), "new successful build");
  await recoverCacheDestination(directory);
  expect(readFileSync(join(directory, "value"), "utf8")).toBe("new successful build");
  expect(inspectCacheOperations(root)).toEqual([]);
  expect(readdirSync(root)).toEqual(["asset"]);
});
test("a changed or malformed receipt needs fresh explicit confirmation and cannot select another target", async () => {
  const { root, entry } = await interrupted();
  const valuable = join(root, "authoritative");
  writeFileSync(valuable, "preserve this");
  writeFileSync(
    join(entry.directory, "operation.json"),
    JSON.stringify({ version: 1, action: "delete", target: "../../authoritative" }),
  );
  await expect(recoverCacheOperation(entry, entry.digest)).rejects.toThrow(/changed/);
  const current = inspectCacheOperations(root)[0];
  if (!current) throw new Error("Missing uncertain operation");
  expect(current.state).toBe("uncertain");
  await expect(recoverCacheOperation(current)).rejects.toThrow(/confirmation/);
  await expect(
    withCacheInstallation(join(root, "next-asset"), false, (staging) => {
      renameSync(staging, join(root, "next-asset"));
    }),
  ).rejects.toThrow(/inspection and explicit confirmation before reuse/);
  await recoverCacheOperation(current, current.digest);
  expect(readFileSync(valuable, "utf8")).toBe("preserve this");
  expect(inspectCacheOperations(root)).toEqual([]);
});
test("active installation refuses cleanup while unrelated assets can install", async () => {
  const { root, directory } = fixture();
  rmSync(directory, { recursive: true });
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const installation = withCacheInstallation(directory, false, async (staging) => {
    writeFileSync(join(staging, "value"), "verified installation");
    const observed = await measureCacheSize({ directory: staging, state: "pending" }, true);
    expect(observed.state).toBe("pending");
    expect(observed.bytes).toBeUndefined();
    started();
    await waiting;
    renameSync(staging, directory);
  });
  try {
    await ready;
    const entry = inspectCacheOperations(root)[0];
    if (!entry) throw new Error("Missing active installation");
    expect(entry.state).toBe("active");
    await expect(recoverCacheOperation(entry, entry.digest)).rejects.toThrow(/active/);
    const other = join(root, "another");
    await withCacheInstallation(other, false, (staging) => {
      writeFileSync(join(staging, "value"), "independent");
      renameSync(staging, other);
    });
    expect(readFileSync(join(other, "value"), "utf8")).toBe("independent");
  } finally {
    release();
    await installation;
  }
  expect(readFileSync(join(directory, "value"), "utf8")).toBe("verified installation");
  expect(inspectCacheOperations(root)).toEqual([]);
});
test.each([
  { externalWriters: false, orphanedLock: false },
  { externalWriters: true, orphanedLock: false },
  { externalWriters: false, orphanedLock: true },
])(
  "process interruption leaves discoverable installation work with conservative writer recovery (%j)",
  async ({ externalWriters, orphanedLock }) => {
    const { root, directory } = fixture();
    rmSync(directory, { recursive: true });
    const worker = join(root, "operation.mjs");
    const operationSource = fileURLToPath(new URL("../../../src/core/storage/cache-operations.ts", import.meta.url));
    const lockSource = fileURLToPath(new URL("../../../src/core/storage/cache-lock.ts", import.meta.url));
    const installerSource = fileURLToPath(new URL("../../../src/core/toolchains/tool-downloads.ts", import.meta.url));
    await build({
      stdin: {
        resolveDir: dirname(operationSource),
        contents: `export * from ${JSON.stringify(operationSource)}; export { withCacheLock } from ${JSON.stringify(lockSource)}; export { installAsset } from ${JSON.stringify(installerSource)};`,
      },
      outfile: worker,
      bundle: true,
      platform: "node",
      format: "esm",
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
      logLevel: "silent",
    });
    const source = `import { withCacheInstallation, withCacheLock } from ${JSON.stringify(pathToFileURL(worker).href)};
    import { writeFileSync, rmSync } from 'node:fs'; import { join, dirname } from 'node:path';
    await withCacheLock(process.argv[1], () => withCacheInstallation(process.argv[1], ${String(externalWriters)}, async staging => {
      writeFileSync(join(staging, 'value'), 'incomplete installation');
      if (${String(orphanedLock)}) rmSync(dirname(staging), { recursive: true });
      process.exit(23);
    }));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, directory], {
      encoding: "utf8",
      timeout: 60000,
    });
    expect(child.error, child.stdout + child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(23);
    const entry = inspectCacheOperations(root)[0];
    if (!entry) throw new Error("Missing crashed installation");
    expect(entry.state).toBe(externalWriters ? "uncertain" : "pending");
    if (externalWriters) {
      await expect(recoverCacheDestination(directory)).rejects.toThrow(/confirmation/);
      await recoverCacheOperation(entry, entry.digest);
    } else await recoverCacheDestination(directory);
    const bytes = "complete installation",
      sha256 = createHash("sha256").update(bytes).digest("hex");
    const downloads = join(userDirectory("cache"), "downloads");
    mkdirSync(downloads, { recursive: true });
    writeFileSync(join(downloads, sha256 + "-fixture"), bytes);
    const asset = {
      url: "https://example.invalid/fixture",
      sha256,
      format: "binary",
      strip: 0,
      bin: ".",
      executable: "value",
    };
    const installer = `import { installAsset } from ${JSON.stringify(pathToFileURL(worker).href)}; await installAsset(process.argv[1], JSON.parse(process.argv[2]));`;
    const installed = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", installer, directory, JSON.stringify(asset)],
      { encoding: "utf8", timeout: 60000 },
    );
    expect(installed.error, installed.stdout + installed.stderr).toBeUndefined();
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    expect(readFileSync(join(directory, "value"), "utf8")).toBe("complete installation");
    expect(inspectCacheOperations(root)).toEqual([]);
  },
);

test("log retention coordinates size publication while preserving newer complete evidence", async () => {
  const { root } = fixture();
  const policy = { maxAgeDays: 0, maxBytes: 0, compression: LogCompressionPreference.None };
  const old = join(root, randomUUID()),
    recent = join(root, randomUUID());
  for (const path of [old, recent]) {
    mkdirSync(path);
    startLogRun(path);
    writeFileSync(join(path, "group-0.log"), "complete evidence");
    await finishLogRun(path, policy, [], false);
  }
  const before = await measureCacheSize({ directory: old, state: "pending" });
  let concurrent: Awaited<ReturnType<typeof measureCacheSize>> | undefined;
  vi.mocked(rm).mockImplementationOnce(async (directory) => {
    expect(directory).toBe(old);
    for (const name of readdirSync(old)) rmSync(join(old, name), { recursive: true });
    concurrent = await measureCacheSize(before, true);
    rmdirSync(old);
  });
  expect(await pruneLogRuns(root, { ...policy, maxBytes: 1 }, { newest: recent })).toMatchObject({
    removed: 1,
    uncertain: 0,
  });
  expect(concurrent).toMatchObject({ state: "stale", bytes: before.bytes });
  expect(existsSync(old)).toBe(false);
  expect(readFileSync(join(recent, "group-0.log"), "utf8")).toBe("complete evidence");
});

test("recovery never follows a redirected payload, including explicitly confirmed cleanup", async () => {
  const { root, entry } = await interrupted();
  const outside = join(root, "project-files");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "authoritative data");
  rmSync(join(entry.directory, "payload"), { recursive: true });
  symlinkSync(outside, join(entry.directory, "payload"), process.platform === "win32" ? "junction" : "dir");
  const current = inspectCacheOperations(root)[0];
  if (!current) throw new Error("Missing redirected operation");
  expect(current.state).toBe("uncertain");
  await expect(recoverCacheOperation(current)).rejects.toThrow(/confirmation/);
  await recoverCacheOperation(current, current.digest);
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("authoritative data");
});
test("a crash after payload and receipt removal leaves only safely recoverable empty metadata", async () => {
  const { root, entry } = await interrupted();
  rmSync(join(entry.directory, "payload"), { recursive: true });
  rmSync(join(entry.directory, "operation.json"));
  const current = inspectCacheOperations(root)[0];
  if (!current) throw new Error("Missing empty operation");
  expect(current).toMatchObject({ action: "unknown", state: "pending", bytes: 0 });
  await recoverCacheOperation(current);
  expect(inspectCacheOperations(root)).toEqual([]);
});
test("installation failure and cleanup failure both remain diagnosable and recoverable", async () => {
  const { root, directory } = fixture();
  rmSync(directory, { recursive: true });
  vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error("cleanup storage denied"), { code: "EACCES" }));
  await expect(
    withCacheInstallation(directory, false, (staging) => {
      writeFileSync(join(staging, "value"), "partial");
      throw new Error("installation failed");
    }),
  ).rejects.toThrow(/Installation and temporary cache cleanup failed/);
  const entry = inspectCacheOperations(root)[0];
  if (!entry) throw new Error("Missing failed installation");
  expect(entry.state).toBe("pending");
  await recoverCacheDestination(directory);
  expect(existsSync(directory)).toBe(false);
  expect(inspectCacheOperations(root)).toEqual([]);
});
