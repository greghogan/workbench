import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { finishLogRun, startLogRun } from "../src/log-storage.ts";
import { inspectLogRun, recoverLogRun, removeLogRun } from "../src/log-recovery.ts";
import { pruneLogRuns, selectLogRetention } from "../src/log-retention.ts";
import { transferZstd } from "../src/log-codec.ts";
import { configureDiagnostics } from "../scripts/diagnostics.mjs";
import { randomUUID } from "node:crypto";
vi.mock("../src/log-retention.ts", async (original) => {
  const actual = await original<typeof import("../src/log-retention.ts")>();
  return { ...actual, pruneLogRuns: vi.fn(actual.pruneLogRuns) };
});
let root: string;
const policy = { maxAgeDays: 0, maxBytes: 0, compress: true };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workbench-log-lifecycle-"));
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "config"));
  configureDiagnostics({ sink: () => undefined });
  vi.mocked(pruneLogRuns).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  configureDiagnostics();
});
function fixture(abandoned = false) {
  const directory = join(root, randomUUID());
  mkdirSync(directory);
  startLogRun(directory);
  writeFileSync(join(directory, "group-0.log"), "complete source evidence\n".repeat(100));
  if (abandoned) {
    const path = join(directory, ".workbench-log-run.json"),
      value = JSON.parse(readFileSync(path, "utf8")) as { owner: { pid: number; host: string } };
    const exited = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
    if (exited.status !== 0) throw new Error("fixture process did not exit");
    value.owner = { pid: exited.pid, host: hostname() };
    writeFileSync(path, JSON.stringify(value));
  }
  return directory;
}
test("a maintenance failure cannot discard the finalized file index", async () => {
  const directory = fixture();
  vi.mocked(pruneLogRuns).mockRejectedValueOnce(Object.assign(new Error("retention denied"), { code: "EACCES" }));
  const result = await finishLogRun(directory, policy);
  expect(result.completed).toBe(true);
  expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "EACCES" })]));
  expect(result.files[0]?.name).toBe("group-0.log.zst");
  expect(existsSync(join(directory, result.files[0]?.name ?? "missing"))).toBe(true);
});
test("retention planning preserves protected runs without mutating the inventory", () => {
  const runs = [
    { directory: "old", completed: 0, bytes: 20, eligible: true },
    { directory: "active", completed: 1, bytes: 50, eligible: false },
    { directory: "newest", completed: 2, bytes: 100, eligible: true },
  ];
  expect(selectLogRetention(runs, { ...policy, maxBytes: 1 }, 3)).toEqual({ remove: ["old"], retainedBytes: 150 });
  expect(runs.map((run) => run.directory)).toEqual(["old", "active", "newest"]);
});
test("recovery refuses active owners, missing confirmation, locks and stale inspections", async () => {
  const active = fixture(),
    inspected = await inspectLogRun(active);
  await expect(recoverLogRun(active, inspected.digest, true)).rejects.toThrow(/alive/);
  const abandoned = fixture(true),
    reviewed = await inspectLogRun(abandoned);
  await expect(recoverLogRun(abandoned, reviewed.digest, false)).rejects.toThrow(/confirm-abandoned/);
  mkdirSync(abandoned + ".lock");
  await expect(recoverLogRun(abandoned, reviewed.digest, true)).rejects.toThrow(/locked/);
  rmSync(abandoned + ".lock", { recursive: true });
  writeFileSync(join(abandoned, "group-0.log"), "new evidence");
  await expect(recoverLogRun(abandoned, reviewed.digest, true)).rejects.toThrow(/changed/);
  expect(existsSync(join(abandoned, "group-0.log"))).toBe(true);
});
test("explicit recovery retains evidence and explicit deletion requires a new exact inspection", async () => {
  const directory = fixture(true),
    inspected = await inspectLogRun(directory);
  await recoverLogRun(directory, inspected.digest, true);
  expect(vi.mocked(pruneLogRuns)).not.toHaveBeenCalled();
  const recovered = await inspectLogRun(directory);
  expect(recovered.state).toBe("completed");
  expect(existsSync(join(directory, "group-0.log.zst"))).toBe(true);
  await expect(removeLogRun(directory, recovered.digest, false)).rejects.toThrow(/confirm-delete/);
  await expect(removeLogRun(directory, inspected.digest, true)).rejects.toThrow(/changed/);
  await removeLogRun(directory, recovered.digest, true);
  expect(existsSync(directory)).toBe(false);
});
test("external codec deadlines terminate children that finish their pipes but stay alive", async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  await expect(
    transferZstd(Readable.from(["input"]), output, "compress", {
      deadlineMs: 100,
      spawnZstd: () =>
        spawn(
          process.execPath,
          ["-e", "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.end();setInterval(()=>{},1000)});"],
          { stdio: ["pipe", "pipe", "pipe"] },
        ),
    }),
  ).rejects.toThrow(/Zstandard/);
});
