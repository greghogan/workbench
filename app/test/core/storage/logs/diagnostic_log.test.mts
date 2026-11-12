import { build } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { DiagnosticLog, type DiagnosticLogOptions } from "../../../../src/core/storage/logs/diagnostic-log.ts";
import type { TerminalChannel } from "../../../../src/core/storage/logs/terminal-log.ts";
import { pruneLogRuns } from "../../../../src/core/storage/logs/log-storage.ts";
import { readLog } from "../../../../src/core/storage/logs/log-reader.ts";
import { marker, readRun, logSegments } from "../../../../src/core/storage/logs/log-run.ts";
import { inspectLogRun, recoverLogRun } from "../../../../src/core/storage/logs/log-recovery.ts";
import { keepCacheAsset } from "../../../../src/core/projects/project-registry.ts";
import { withCacheLock } from "../../../../src/core/storage/cache-lock.ts";
import {
  configureDiagnostics,
  LogCompressionPreference,
  LogScope,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  createDiagnosticEvent,
  renderDiagnosticEvent,
  LogFormat,
} from "../../../../src/core/diagnostics/diagnostics.mjs";
let root: string;
const retention = { maxAgeDays: 0, maxBytes: 0, compression: LogCompressionPreference.Gzip };
const sinks: DiagnosticLog[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workbench-diagnostic-log-"));
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  configureDiagnostics({ sink: () => undefined });
});
afterEach(async () => {
  for (const sink of sinks.splice(0)) {
    if (!sink.writableEnded) sink.end();
    await finished(sink).catch(() => undefined);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  configureDiagnostics();
  rmSync(root, { recursive: true, force: true });
});
async function log(options: Partial<DiagnosticLogOptions> = {}) {
  const sink = new DiagnosticLog(join(root, randomUUID()), {
    scope: LogScope.Server,
    retention,
    rotateBytes: 1,
    rotateMilliseconds: 0,
    ...options,
  });
  sinks.push(sink);
  await sink.ready;
  return sink;
}
function event(value: string, operation: DiagnosticOperation = DiagnosticOperation.Command) {
  return renderDiagnosticEvent(
    createDiagnosticEvent(LogLevel.Info, operation, DiagnosticOutcome.Completed, { value }),
    LogFormat.Json,
  );
}
async function append(sink: DiagnosticLog, text: string) {
  await new Promise<void>((resolve, reject) => {
    sink.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
async function text(path: string, channel?: TerminalChannel) {
  const chunks: Buffer[] = [];
  await readLog(
    path,
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    }),
    channel,
  );
  return Buffer.concat(chunks).toString();
}
async function close(sink: DiagnosticLog) {
  sink.end();
  await finished(sink);
}

test("size rotation preserves complete ordered events across a live session and after close", async () => {
  const sink = await log();
  const records = [event("first"), event("large".repeat(500)), event("last")];
  for (const record of records) await append(sink, record);
  const segments = logSegments(sink.directory);
  expect(segments).toHaveLength(3);
  expect(readRun(sink.directory).state).toBe("active");
  expect(readRun(segments.at(-1) ?? "").state).toBe("active");
  expect(await text(sink.directory)).toBe(records.join(""));
  await close(sink);
  expect(readRun(sink.directory).state).toBe("completed");
  expect(await text(sink.directory)).toBe(records.join(""));
  for (const segment of segments) expect(readdirSync(segment)).toContain("events.jsonl.gz");
});
test("server output and events rotate and age off together while each selected stream stays ordered", async () => {
  const sink = await log({ rotateBytes: 350 });
  const first = "first " + "x".repeat(200) + "\n",
    last = "last " + "y".repeat(200) + "\n";
  const eventText = event("old event");
  await append(sink, eventText);
  await append(sink, sink.encodeTerminal("stdout", first));
  await append(sink, sink.encodeTerminal("stdout", last));
  await append(sink, sink.encodeTerminal("stderr", "warning only on stderr\n"));
  await close(sink);
  const segments = logSegments(sink.directory);
  expect(segments).toHaveLength(2);
  expect(await text(sink.directory, "stdout")).toBe(first + last);
  expect(await text(sink.directory, "stderr")).toBe("warning only on stderr\n");
  expect(await text(sink.directory)).toBe(eventText);
  expect(
    readRun(segments[0] ?? "")
      .files.map((file) => file.name)
      .sort(),
  ).toEqual(["events.jsonl.gz", "stdout.log.gz"]);
  await pruneLogRuns(root, { ...retention, maxBytes: 1 }, { layout: "segments" });
  expect(await text(sink.directory, "stdout")).toBe(last);
  expect(await text(sink.directory, "stderr")).toBe("warning only on stderr\n");
});
test("time rotation seals idle output, and closing drains pending writes and removes timers", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const sink = await log({ rotateBytes: 0, rotateMilliseconds: 1000 });
  await append(sink, event("before idle"));
  await vi.advanceTimersByTimeAsync(1000);
  await append(sink, "");
  expect(logSegments(sink.directory)).toHaveLength(2);
  await close(sink);
  expect(readRun(logSegments(sink.directory)[0] ?? "").state).toBe("completed");
  expect(vi.getTimerCount()).toBe(0);
  expect(await text(sink.directory)).toContain("before idle");
});
test("CLI logs remain whole execution units regardless of server rotation settings", async () => {
  const sink = await log({ scope: LogScope.Cli });
  const records = [event("first"), event("second")];
  for (const record of records) await append(sink, record);
  await close(sink);
  expect(logSegments(sink.directory)).toEqual([]);
  expect(await text(join(sink.directory, "events.jsonl"))).toBe(records.join(""));
});
test("retention removes closed segments of a running server while protecting active, kept and reading sessions", async () => {
  const sink = await log();
  for (const value of ["old", "recent", "active"]) await append(sink, event(value));
  const segments = logSegments(sink.directory),
    policy = { ...retention, maxBytes: 1 };
  keepCacheAsset(sink.directory, true);
  expect(await pruneLogRuns(root, policy, { layout: "segments" })).toMatchObject({ removed: 0 });
  keepCacheAsset(sink.directory, false);
  await withCacheLock(sink.directory, async () => {
    expect(await pruneLogRuns(root, policy, { layout: "segments" })).toMatchObject({ removed: 0 });
  });
  expect(await pruneLogRuns(root, policy, { layout: "segments" })).toMatchObject({ removed: 1 });
  expect(existsSync(segments[2] ?? "")).toBe(true);
  expect(await text(sink.directory)).not.toContain('"value":"old"');
  expect(await text(sink.directory)).toContain('"value":"active"');
});
test("maintenance diagnostics cannot recursively trigger size rotation", async () => {
  const sink = await log();
  await append(sink, event("ordinary"));
  await append(sink, event("budget warning", DiagnosticOperation.LogRetention));
  expect(logSegments(sink.directory)).toHaveLength(1);
  await append(sink, event("next ordinary"));
  expect(logSegments(sink.directory)).toHaveLength(2);
  expect(await text(sink.directory)).toContain("budget warning");
});
test("a failed segment archive preserves complete plain output and records the failure without changing codec", async () => {
  const sink = await log();
  const first = logSegments(sink.directory)[0];
  if (!first) throw new Error("missing open segment");
  await append(sink, event("evidence"));
  writeFileSync(join(first, "events.jsonl.gz"), "protected destination");
  await append(sink, event("next"));
  expect(readFileSync(join(first, "events.jsonl"), "utf8")).toContain("evidence");
  expect(readFileSync(join(first, "events.jsonl.gz"), "utf8")).toBe("protected destination");
  expect(existsSync(join(first, "events.jsonl.zst"))).toBe(false);
  await close(sink);
  expect(sink.issues).not.toHaveLength(0);
});
test("interrupted server recovery finalizes only active segments and keeps prior archives intact", async () => {
  let sealed: (() => void) | undefined;
  const archiveReady = new Promise<void>((resolve) => {
    sealed = resolve;
  });
  const sink = await log({
    onSealed: () => {
      sealed?.();
    },
  });
  await append(sink, event("completed before interruption"));
  await append(sink, event("open at interruption"));
  await archiveReady;
  const segments = logSegments(sink.directory),
    archived = readFileSync(join(segments[0] ?? "", "events.jsonl.gz"));
  // Destroy models a producer that could not publish completion; explicit recovery verifies a dead owner.
  sink.destroy();
  await finished(sink).catch(() => undefined);
  const dead = spawnSync(process.execPath, ["-e", ""]);
  if (dead.status !== 0) throw new Error("fixture process failed");
  for (const directory of [sink.directory, ...segments]) {
    const path = join(directory, marker),
      receipt = JSON.parse(readFileSync(path, "utf8")) as { owner: unknown };
    receipt.owner = { host: hostname(), pid: dead.pid };
    writeFileSync(path, JSON.stringify(receipt));
  }
  const inspected = await inspectLogRun(sink.directory);
  await recoverLogRun(sink.directory, inspected.digest, true);
  expect(readRun(sink.directory).state).toBe("completed");
  expect(readFileSync(join(segments[0] ?? "", "events.jsonl.gz"))).toEqual(archived);
  expect(await text(sink.directory)).toContain("open at interruption");
  expect(logSegments(sink.directory)).toHaveLength(2);
});
test("completed empty server containers are removed after their last retained segment expires", async () => {
  const previous = await log();
  await append(previous, event("old"));
  await close(previous);
  const current = await log();
  await append(current, event("recent"));
  await close(current);
  await pruneLogRuns(
    root,
    { ...retention, maxBytes: 1 },
    { newest: logSegments(current.directory)[0] ?? "missing", layout: "segments" },
  );
  expect(existsSync(previous.directory)).toBe(false);
  expect(await text(current.directory)).toContain("recent");
});

test("a killed producer leaves readable evidence that explicit recovery can finalize", async () => {
  const executable = join(root, "producer.mjs"),
    directory = join(root, randomUUID());
  await build({
    entryPoints: [join(import.meta.dirname, "../../../fixtures/log-producer.mts")],
    outfile: executable,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: 'import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  const child = spawn(process.execPath, [executable, directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errorOutput = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errorOutput = (errorOutput + chunk.toString()).slice(-8192);
  });
  const stopped = once(child, "exit");
  try {
    await Promise.race([
      once(child, "message"),
      stopped.then(() => {
        throw new Error(`Producer stopped before writing: ${errorOutput}`);
      }),
    ]);
    child.kill("SIGKILL");
    await stopped;
    const inspected = await inspectLogRun(directory);
    expect(inspected.ownership).toBe("gone");
    expect(inspected.state).toBe("active");
    expect(await text(directory)).toContain("abrupt-process-loss");
    expect(await text(directory, "stdout")).toBe("retained-stdout-startup\n");
    expect(await text(directory, "stderr")).toBe("retained-stderr with [REDACTED]\n");
    const segment = logSegments(directory)[0] ?? "";
    expect(readFileSync(join(segment, "stderr.log"), "utf8")).toBe("retained-stderr with [REDACTED]\n");
    await recoverLogRun(directory, inspected.digest, true);
    expect(readRun(directory).state).toBe("completed");
    expect(await text(directory)).toContain("abrupt-process-loss");
    expect(await text(directory, "stderr")).toBe("retained-stderr with [REDACTED]\n");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await stopped;
  }
});

test("a stalled finalizer permits the next segment to accept writes and bounds subsequent rotation", async () => {
  const storage = await import("../../../../src/core/storage/logs/log-storage.ts");
  const original = storage.finishLogRun;
  let release: (() => void) | undefined, started: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(storage, "finishLogRun").mockImplementationOnce(async (...args) => {
    started?.();
    await held;
    return original(...args);
  });
  const sink = await log();
  try {
    await append(sink, event("first segment"));
    await append(sink, event("second segment"));
    await entered;
    const segments = logSegments(sink.directory);
    expect(readFileSync(join(segments[1] ?? "", "events.jsonl"), "utf8")).toContain("second segment");
    let completed = false;
    const third = append(sink, event("third segment")).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    release?.();
    await third;
    await close(sink);
    const evidence = await text(sink.directory);
    expect(evidence).toContain("first segment");
    expect(evidence).toContain("second segment");
    expect(evidence).toContain("third segment");
  } finally {
    release?.();
  }
});
