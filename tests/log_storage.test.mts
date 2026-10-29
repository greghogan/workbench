import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { startLogRun, finishLogRun, pruneLogRuns, readLog } from "../src/log-storage.ts";
import { configureDiagnostics } from "../scripts/diagnostics.mjs";
let root: string;
const retain = { maxAgeDays: 0, maxBytes: 0, compress: false };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workbench-log-storage-"));
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "config"));
  configureDiagnostics({ sink: () => undefined });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  configureDiagnostics();
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
test("complete recent logs round-trip through verified Zstandard and logical or explicit compressed paths", async () => {
  const text = "Complete diagnostic line\n".repeat(20000),
    directory = run(text);
  const finished = await finishLogRun(directory, { ...retain, compress: true });
  const file = finished.files[0];
  expect(file?.compression).toBe("zstd");
  expect(file?.bytes).toBeLessThan(text.length / 10);
  expect(await contents(join(directory, "group-0.log"))).toBe(text);
  expect(await contents(join(directory, "group-0.log.zst"))).toBe(text);
  expect(existsSync(join(directory, "group-0.log"))).toBe(false);
});
test("size retention removes whole oldest runs and preserves a newest run larger than the budget", async () => {
  const old = run("old output"),
    recent = run("new output".repeat(100));
  await finishLogRun(old, retain);
  await finishLogRun(recent, retain);
  await pruneLogRuns(root, { ...retain, maxBytes: 1 }, recent);
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
  const result = await finishLogRun(recent, { ...retain, maxBytes: 1, compress: true });
  expect(existsSync(previous)).toBe(false);
  expect(result.files.some((file) => file.name === "session-0/step-1.ABCDEF.zst")).toBe(true);
  expect(await contents(join(recent, "session-0/step-1.ABCDEF"))).toBe("complete child evidence\n".repeat(100));
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
  await pruneLogRuns(root, { ...retain, maxAgeDays: 1 }, latest);
  expect(existsSync(old)).toBe(false);
  for (const directory of [locked, active, latest, unknown]) expect(existsSync(directory)).toBe(true);
});
test("compression publication failure preserves complete original bytes and reports unavailable compression", async () => {
  const directory = run("complete evidence\n"),
    path = join(directory, "group-0.log");
  writeFileSync(path + ".zst", "existing protected archive");
  const result = await finishLogRun(directory, { ...retain, compress: true });
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
  await pruneLogRuns(root, { ...retain, maxBytes: 1 }, latest);
  expect(existsSync(bad)).toBe(true);
});
test("corrupted Zstandard input fails explicitly rather than returning a valid empty log", async () => {
  const path = join(root, "corrupted.log.zst");
  writeFileSync(path, "not compressed data");
  await expect(contents(path)).rejects.toThrow();
});
test("a failed output sink preserves its OS error and leaves the complete archive readable", async () => {
  const directory = run("retained despite a broken reader\n".repeat(100));
  await finishLogRun(directory, { ...retain, compress: true });
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
