import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { startLogRun, finishLogRun, pruneLogRuns } from "../../../../src/core/storage/logs/log-storage.ts";
import { readLog } from "../../../../src/core/storage/logs/log-reader.ts";
import { LogCompressionPreference } from "../../../../src/core/diagnostics/diagnostic-contract.mjs";
import { configureDiagnostics } from "../../../../src/core/diagnostics/diagnostics.mjs";
import { keepCacheAsset } from "../../../../src/core/projects/project-registry.ts";
import { LogInventory } from "../../../../src/core/storage/logs/log-inventory.ts";
import { maintainLogRuns } from "../../../../src/core/storage/logs/log-retention.ts";
import { withCacheLock } from "../../../../src/core/storage/cache-lock.ts";
let root: string;
const retain = { maxAgeDays: 0, maxBytes: 0, compression: LogCompressionPreference.None };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workbench-log-storage-"));
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  configureDiagnostics({ sink: () => undefined });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  configureDiagnostics();
});

test("automatic retention coordinates cadence, recovers damaged timing, and leaves manual pruning fresh", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const policy = { ...retain, maxBytes: 1 };
  const first = run(),
    latest = run();
  for (const directory of [first, latest]) await finishLogRun(directory, retain, [], false);
  await withCacheLock(join(root, ".retention"), async () => {
    await maintainLogRuns(root, policy, 3600000);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(join(root, ".maintenance.json"))).toBe(false);
  });
  await maintainLogRuns(root, policy, 3600000, { newest: latest });
  expect(existsSync(first)).toBe(false);
  const newer = run();
  await finishLogRun(newer, retain, [], false);
  await maintainLogRuns(root, policy, 3600000);
  expect(existsSync(latest)).toBe(true);
  await pruneLogRuns(root, policy, { newest: newer });
  expect(existsSync(latest)).toBe(false);
  const final = run();
  await finishLogRun(final, retain, [], false);
  writeFileSync(join(root, ".maintenance.json"), "interrupted metadata");
  await maintainLogRuns(root, policy, 3600000, { newest: final });
  expect(existsSync(newer)).toBe(false);
  const after = run();
  await finishLogRun(after, retain, [], false);
  vi.setSystemTime(Date.now() + 3600000);
  await maintainLogRuns(root, policy, 3600000, { newest: after });
  expect(existsSync(final)).toBe(false);
  const changedPolicy = run();
  await finishLogRun(changedPolicy, retain, [], false);
  await maintainLogRuns(root, { ...policy, maxBytes: 2 }, 3600000, { newest: changedPolicy });
  expect(existsSync(after)).toBe(false);
});

function run(text = "complete output\n"): string {
  const directory = join(root, randomUUID());
  mkdirSync(directory);
  startLogRun(directory);
  writeFileSync(join(directory, "group-0.log"), text);
  return directory;
}
async function contents(path: string): Promise<string> {
  const chunks: Buffer[] = [];
  await readLog(
    path,
    new Writable({
      write(bytes: Buffer, _encoding, callback) {
        chunks.push(bytes);
        callback();
      },
    }),
  );
  return Buffer.concat(chunks).toString();
}
test.each([LogCompressionPreference.Zstd, LogCompressionPreference.Gzip, LogCompressionPreference.None])(
  "logs round-trip through verified %s and logical or explicit encoded paths",
  async (compression) => {
    const text = "Complete diagnostic line\n".repeat(20000),
      directory = run(text);
    const finished = await finishLogRun(directory, { ...retain, compression });
    const file = finished.files[0];
    expect(file?.compression).toBe(compression);
    if (compression !== LogCompressionPreference.None) expect(file?.bytes).toBeLessThan(text.length / 10);
    expect(await contents(join(directory, "group-0.log"))).toBe(text);
    expect(await contents(join(directory, file?.name ?? "missing"))).toBe(text);
    expect(existsSync(join(directory, "group-0.log"))).toBe(compression === LogCompressionPreference.None);
  },
);
test("size retention removes whole oldest runs and preserves a newest run larger than the budget", async () => {
  const old = run("old output"),
    recent = run("new output".repeat(100));
  await finishLogRun(old, retain);
  await finishLogRun(recent, retain);
  await pruneLogRuns(root, { ...retain, maxBytes: 1 }, { newest: recent });
  expect(existsSync(old)).toBe(false);
  expect(existsSync(recent)).toBe(true);
  expect(await contents(join(recent, "group-0.log"))).toBe("new output".repeat(100));
});
test("a recent gate retains its child step logs as one complete retention unit", async () => {
  const previous = run("old root output"),
    recent = run("new root output");
  await finishLogRun(previous, retain);
  mkdirSync(join(recent, "session-0"));
  writeFileSync(join(recent, "session-0/step-1.ABCDEF"), "complete child evidence\n".repeat(100));
  const result = await finishLogRun(recent, { ...retain, maxBytes: 1, compression: LogCompressionPreference.Zstd });
  expect(existsSync(previous)).toBe(false);
  expect(result.files.some((file) => file.name === "session-0/step-1.ABCDEF.zst")).toBe(true);
  expect(await contents(join(recent, "session-0/step-1.ABCDEF"))).toBe("complete child evidence\n".repeat(100));
});
test("automatic retention preserves explicitly kept logs until their keep is released", async () => {
  const kept = run("evidence to preserve"),
    disposable = run("disposable evidence"),
    latest = run();
  for (const directory of [kept, disposable, latest]) await finishLogRun(directory, retain, [], false);
  keepCacheAsset(kept, true);
  const policy = { ...retain, maxBytes: 1 };
  expect(await pruneLogRuns(root, policy, { newest: latest })).toMatchObject({ removed: 1 });
  expect(await contents(join(kept, "group-0.log"))).toBe("evidence to preserve");
  expect(existsSync(latest)).toBe(true);
  keepCacheAsset(kept, false);
  expect(await pruneLogRuns(root, policy, { newest: latest })).toMatchObject({ removed: 1 });
  expect(existsSync(kept)).toBe(false);
  expect(existsSync(latest)).toBe(true);
});
test("age-off preserves active, locked, unknown, and newest logs", async () => {
  const old = run(),
    locked = run(),
    active = run(),
    latest = run();
  for (const directory of [old, locked, latest]) await finishLogRun(directory, retain);
  for (const directory of [old, locked]) {
    const path = join(directory, ".workbench-log-run.json"),
      receipt = JSON.parse(readFileSync(path, "utf8")) as { completed: string };
    receipt.completed = "2020-01-01T00:00:00.000Z";
    writeFileSync(path, JSON.stringify(receipt));
  }
  mkdirSync(locked + ".lock");
  const unknown = join(root, randomUUID());
  mkdirSync(unknown);
  writeFileSync(join(unknown, "valuable.log"), "unknown ownership");
  await pruneLogRuns(root, { ...retain, maxAgeDays: 1 }, { newest: latest });
  expect(existsSync(old)).toBe(false);
  for (const directory of [locked, active, latest, unknown]) expect(existsSync(directory)).toBe(true);
});
test("compression publication failure preserves complete original bytes and reports unavailable compression", async () => {
  const directory = run("complete evidence\n"),
    path = join(directory, "group-0.log");
  writeFileSync(path + ".zst", "existing protected archive");
  const result = await finishLogRun(directory, { ...retain, compression: LogCompressionPreference.Zstd });
  expect(result.errors).not.toHaveLength(0);
  expect(readFileSync(path, "utf8")).toBe("complete evidence\n");
  expect(readFileSync(path + ".zst", "utf8")).toBe("existing protected archive");
});
test("retained logs redact credential canaries even when compression is disabled", async () => {
  vi.stubEnv("WORKBENCH_TEST_TOKEN", "canary-secret-token-567890");
  const directory = run("failure canary-secret-token-567890 https://example.invalid/file?token=unlisted-private\n");
  await finishLogRun(directory, retain);
  const text = readFileSync(join(directory, "group-0.log"), "utf8");
  expect(text).not.toContain("canary-secret-token-567890");
  expect(text).not.toContain("unlisted-private");
  expect(text).toContain("[REDACTED]");
});
test("malformed receipts remain untouched during automatic retention", async () => {
  const bad = run();
  writeFileSync(join(bad, ".workbench-log-run.json"), "{broken");
  const latest = run();
  await finishLogRun(latest, retain);
  await pruneLogRuns(root, { ...retain, maxBytes: 1 }, { newest: latest });
  expect(existsSync(bad)).toBe(true);
});
test("inventory storage failures abort retention before any log is deleted", async () => {
  const previous = run("previous evidence"),
    latest = run("latest evidence");
  await finishLogRun(previous, retain, [], false);
  await finishLogRun(latest, retain, [], false);
  const failure = Object.assign(new Error("inventory disk full"), { code: "ENOSPC" });
  const adding = vi.spyOn(LogInventory.prototype, "add").mockRejectedValue(failure);
  try {
    await expect(pruneLogRuns(root, { ...retain, maxBytes: 1 }, { newest: latest })).rejects.toMatchObject({
      code: "ENOSPC",
    });
    expect(readFileSync(join(previous, "group-0.log"), "utf8")).toBe("previous evidence");
    expect(readFileSync(join(latest, "group-0.log"), "utf8")).toBe("latest evidence");
  } finally {
    adding.mockRestore();
  }
});
test.each(["zst", "gz"])(
  "corrupted %s input fails explicitly rather than returning a valid empty log",
  async (extension) => {
    const path = join(root, `corrupted.log.${extension}`);
    writeFileSync(path, "not compressed data");
    await expect(contents(path)).rejects.toThrow();
  },
);
test("a failed output sink preserves its OS error and leaves the complete archive readable", async () => {
  const directory = run("retained despite a broken reader\n".repeat(100));
  await finishLogRun(directory, { ...retain, compression: LogCompressionPreference.Zstd });
  const path = join(directory, "group-0.log");
  await expect(
    readLog(
      path,
      new Writable({
        write(_bytes, _encoding, callback) {
          callback(Object.assign(new Error("output disk full"), { code: "ENOSPC" }));
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "ENOSPC" });
  expect(await contents(path)).toContain("retained despite a broken reader");
});

test("automatic retention yields to another sweep instead of delaying log finalization", async () => {
  const previous = run("old"),
    current = run("new");
  await finishLogRun(previous, retain, [], false);
  await finishLogRun(current, retain, [], false);
  mkdirSync(join(root, ".retention.lock"));
  expect(await pruneLogRuns(root, { ...retain, maxBytes: 1 }, { newest: current })).toMatchObject({ removed: 0 });
  expect(existsSync(previous)).toBe(true);
  rmSync(join(root, ".retention.lock"), { recursive: true });
  expect(await pruneLogRuns(root, { ...retain, maxBytes: 1 }, { newest: current })).toMatchObject({ removed: 1 });
});

test("an owned file read protects its complete unit until a slow reader finishes", async () => {
  const old = run("evidence retained while reading\n".repeat(10000)),
    latest = run();
  await finishLogRun(old, retain, [], false);
  await finishLogRun(latest, retain, [], false);
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const output = new Writable({
    write(_chunk, _encoding, done) {
      release = () => {
        done();
      };
      entered?.();
    },
  });
  const reading = readLog(join(old, "group-0.log"), output);
  try {
    await started;
    expect(await pruneLogRuns(root, { ...retain, maxBytes: 1 }, { newest: latest })).toMatchObject({ removed: 0 });
    expect(existsSync(old)).toBe(true);
    // Subsequent chunks flow normally after the first backpressure barrier is released.
    output._write = (_chunk, _encoding, done) => {
      done();
    };
    release?.();
    await reading;
    expect(await pruneLogRuns(root, { ...retain, maxBytes: 1 }, { newest: latest })).toMatchObject({ removed: 1 });
    expect(existsSync(old)).toBe(false);
  } finally {
    release?.();
    output.destroy();
    await reading.catch(() => undefined);
  }
});
