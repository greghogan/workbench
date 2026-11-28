import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCacheLockSync } from "../../../src/core/storage/cache-lock.ts";
import { afterEach, expect, test, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  configureDiagnostics,
  createDiagnosticEvent,
  renderDiagnosticEvent,
  LogLevel,
  LogFormat,
  DiagnosticOperation,
  DiagnosticOutcome,
  DiagnosticCapture,
  CollectionOperation,
  subscribeDiagnostics,
  diagnostic,
} from "../../../src/core/diagnostics/diagnostics.mjs";
import { BoundedDiagnosticWriter } from "../../../src/core/diagnostics/diagnostic-writer.mjs";
import { DiagnosticRedactor, redact } from "../../../src/core/diagnostics/diagnostic-text.mjs";
import { resolveDiagnosticOptions } from "../../../src/core/diagnostics/diagnostic-options.ts";
import {
  checkAdmissionDigest,
  readCheckAdmission,
  readCheckMessage,
  CheckMessage,
} from "../../../src/core/execution/checks/check-protocol.ts";
import { readProcessDiagnostic } from "../../../src/core/diagnostics/diagnostic-contract.mjs";
import { knownRoute, Route } from "../../../src/server/routes/routes.ts";
import { relayCollectionDiagnostics } from "../../../src/server/projects/collection-runner.ts";

afterEach(() => {
  configureDiagnostics();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
test("rendering normalized diagnostics never re-reads the original cause graph", () => {
  let reads = 0;
  const cause = new Error();
  Object.defineProperty(cause, "message", {
    get: () => {
      reads++;
      return "original private cause";
    },
  });
  const event = createDiagnosticEvent(LogLevel.Error, DiagnosticOperation.Command, DiagnosticOutcome.Failed, {}, cause);
  const normalizedReads = reads;
  expect(renderDiagnosticEvent(event, LogFormat.Text)).toContain("original private cause");
  expect(JSON.parse(renderDiagnosticEvent(event, LogFormat.Json))).toHaveProperty(
    "error.message",
    "original private cause",
  );
  expect(reads).toBe(normalizedReads);
});
test("flags, environment and saved preferences resolve without changing inputs", () => {
  const preferences = { "diagnostics.level": "debug", "diagnostics.format": "json", "logs.cli_max_bytes": 0 };
  const env = { WORKBENCH_LOG_LEVEL: "warn" };
  expect(resolveDiagnosticOptions({}, env, preferences)).toEqual({
    level: "warn",
    fileLevel: "info",
    format: "json",
    persist: false,
  });
  expect(resolveDiagnosticOptions({ logLevel: "error" }, env, preferences)).toEqual({
    level: "error",
    fileLevel: "info",
    format: "json",
    persist: false,
  });
  expect(env).toEqual({ WORKBENCH_LOG_LEVEL: "warn" });
  expect(() => resolveDiagnosticOptions({ logLevel: "trace" }, {}, preferences)).toThrow(/diagnostic level/);
});
test("server logging defaults and sink-specific overrides preserve separate CLI preferences", () => {
  expect(resolveDiagnosticOptions({}, {}, {}, "server")).toMatchObject({
    level: "info",
    fileLevel: "info",
    persist: true,
  });
  expect(resolveDiagnosticOptions({}, {}, {})).toMatchObject({ persist: true });
  const preferences = {
    "diagnostics.level": "error",
    "diagnostics.file_level": "warn",
    "diagnostics.server_level": "warn",
    "diagnostics.server_file_level": "debug",
  };
  expect(resolveDiagnosticOptions({}, {}, preferences)).toMatchObject({ level: "error", fileLevel: "warn" });
  expect(resolveDiagnosticOptions({}, {}, preferences, "server")).toMatchObject({ level: "warn", fileLevel: "debug" });
  const env = { WORKBENCH_LOG_LEVEL: "info", WORKBENCH_LOG_FILE_LEVEL: "error" };
  expect(resolveDiagnosticOptions({}, env, preferences, "server")).toMatchObject({
    level: "info",
    fileLevel: "error",
    persist: true,
  });
  expect(
    resolveDiagnosticOptions({ logLevel: "debug", logFileLevel: "warn" }, env, preferences, "server"),
  ).toMatchObject({ level: "debug", fileLevel: "warn", persist: true });
  const disabledCli = { "logs.cli_max_bytes": 0, "logs.cli_max_age_days": 0 };
  expect(resolveDiagnosticOptions({}, {}, disabledCli).persist).toBe(false);
  expect(resolveDiagnosticOptions({}, {}, disabledCli, "server").persist).toBe(true);
  expect(resolveDiagnosticOptions({}, {}, { "logs.cli_max_age_days": 0 }).persist).toBe(true);
  expect(() => resolveDiagnosticOptions({ logFileLevel: "trace" }, {}, preferences)).toThrow(/diagnostic file level/);
});
test.each([
  {
    consoleLevel: LogLevel.Warn,
    fileLevel: LogLevel.Info,
    consoleEvents: ["warn", "error"],
    fileEvents: ["info", "warn", "error"],
  },
  {
    consoleLevel: LogLevel.Debug,
    fileLevel: LogLevel.Error,
    consoleEvents: ["debug", "info", "warn", "error"],
    fileEvents: ["error"],
  },
  {
    consoleLevel: LogLevel.Error,
    fileLevel: LogLevel.Debug,
    consoleEvents: ["error"],
    fileEvents: ["debug", "info", "warn", "error"],
  },
])(
  "stderr $consoleLevel and retained $fileLevel thresholds filter independently",
  ({ consoleLevel, fileLevel, consoleEvents, fileEvents }) => {
    const terminal: string[] = [],
      retained: string[] = [];
    configureDiagnostics({
      level: consoleLevel,
      format: "json",
      sink: (text) => {
        terminal.push((JSON.parse(text) as { level: string }).level);
      },
    });
    const unsubscribe = subscribeDiagnostics((event) => {
      retained.push(event.level);
    }, fileLevel);
    try {
      for (const level of Object.values(LogLevel))
        diagnostic(level, DiagnosticOperation.WebRequest, DiagnosticOutcome.Completed);
    } finally {
      unsubscribe();
    }
    expect(terminal).toEqual(consoleEvents);
    expect(retained).toEqual(fileEvents);
  },
);
test("IPC and process termination codecs reject malformed values and preserve valid events", () => {
  expect(
    readCheckMessage({ type: CheckMessage.Logs, directory: "/run", files: ["../private"], errors: [] }),
  ).toBeUndefined();
  expect(
    readCheckMessage({ type: CheckMessage.Logs, directory: "/run", files: ["step-1.ABCDEF"], errors: [] }),
  ).toMatchObject({ files: ["step-1.ABCDEF"] });
  const expected = checkAdmissionDigest([]);
  expect(readCheckAdmission({ type: CheckMessage.Start, isolationGroups: [] }, expected)).toEqual([]);
  expect(() => readCheckAdmission({ type: CheckMessage.Start }, expected)).toThrow(/does not match/);
  expect(() => readCheckAdmission({ type: CheckMessage.Start, isolationGroups: [{}] }, expected)).toThrow(
    /does not match/,
  );
  expect(readProcessDiagnostic({ operation: "tool", pid: NaN, status: 0, signal: null })).toBeUndefined();
  expect(readProcessDiagnostic({ operation: "tool", pid: 123, status: null, signal: "SIGTERM" })).toMatchObject({
    pid: 123,
    signal: "SIGTERM",
  });
  for (const route of Object.values(Route)) expect(knownRoute(route)).toBe(route);
  expect(knownRoute("/secret-unregistered-path")).toBe("unknown");
});
test("whole-text and streaming redaction share every recognized credential field across byte boundaries", async () => {
  for (const field of [
    "authorization",
    "password",
    "api-key",
    "access_token",
    "refresh-token",
    "id_token",
    "token",
    "client_secret",
    "private-key",
    "secret",
  ]) {
    const text = JSON.stringify({ [field]: 'canary-private "quoted" value', after: "retained" });
    const expected = redact(text, []);
    for (let split = 1; split < text.length; split++) {
      const output: Buffer[] = [];
      await pipeline(
        Readable.from([Buffer.from(text.slice(0, split)), Buffer.from(text.slice(split))]),
        new DiagnosticRedactor([]),
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            output.push(chunk);
            callback();
          },
        }),
      );
      expect(Buffer.concat(output).toString()).toBe(expected);
    }
  }
});
test("bounded writers report omission counts after draining and retain sink errors", async () => {
  let release: (() => void) | undefined;
  const output: string[] = [];
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      output.push(chunk.toString());
      if (!release) release = callback;
      else callback();
    },
  });
  const writer = new BoundedDiagnosticWriter(sink, (omitted) => `omitted=${String(omitted)}\n`, 4);
  writer.write("123456");
  writer.write("dropped");
  writer.write("also dropped");
  expect(writer.omitted).toBe(2);
  const drained = new Promise<void>((resolve) => {
    sink.once("drain", resolve);
  });
  release?.();
  await drained;
  await new Promise<void>((resolve) => {
    sink.end(resolve);
  });
  writer.dispose();
  expect(output.join("")).toContain("omitted=2");
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("sink rejected"));
    },
  });
  const failed = new BoundedDiagnosticWriter(broken, () => "omitted");
  const closed = new Promise<void>((resolve) => {
    broken.once("close", resolve);
  });
  failed.write("event");
  await closed;
  expect(failed.failure).toMatchObject({ message: "sink rejected" });
  failed.dispose();
});
test("child structured diagnostics retain severity and plain stderr remains a warning", () => {
  configureDiagnostics({ level: "debug", format: "json", sink: () => undefined });
  const events: { level: string; operation: string }[] = [];
  const stop = subscribeDiagnostics((event) => {
    events.push(event);
  });
  try {
    const capture = new DiagnosticCapture();
    for (const level of [LogLevel.Debug, LogLevel.Info, LogLevel.Warn])
      capture.add(
        Buffer.from(
          renderDiagnosticEvent(
            createDiagnosticEvent(level, DiagnosticOperation.Command, DiagnosticOutcome.Completed, {
              evidence: 'password="quoted private credential"',
            }),
            LogFormat.Json,
          ),
        ),
      );
    capture.add(Buffer.from("plain child warning\n"));
    relayCollectionDiagnostics(capture, CollectionOperation.Preview);
    expect(events.map((event) => event.level)).toEqual(["debug", "info", "warn", "warn"]);
    expect(events.at(-1)?.operation).toBe(DiagnosticOperation.CollectionWorker);
    diagnostic(LogLevel.Info, DiagnosticOperation.Command, DiagnosticOutcome.Completed);
  } finally {
    stop();
  }
});

test("a writer closing under backpressure retains its final omission notice", async () => {
  const chunks: string[] = [];
  const destination = new Writable({
    write(bytes: Buffer, _encoding, callback) {
      chunks.push(bytes.toString());
      setImmediate(callback);
    },
  });
  const writer = new BoundedDiagnosticWriter(destination, (omitted) => `omitted=${String(omitted)}\n`, 1);
  writer.write("first long event");
  writer.write("second event");
  writer.flushOmissions(true);
  await new Promise<void>((resolve) => {
    destination.end(resolve);
  });
  writer.dispose();
  expect(chunks.join("")).toContain("omitted=1");
  expect(writer.omitted).toBe(1);
});

test("synchronous lock waits report acquisition with the same observation contract", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-lock-observation-")),
    lock = join(root, "artifact");
  mkdirSync(lock + ".lock");
  writeFileSync(join(lock + ".lock", "owner.json"), JSON.stringify({ pid: process.pid, started: "fixture" }));
  configureDiagnostics({ level: "info", sink: () => undefined });
  const outcomes: { outcome: string; fields: Record<string, unknown> }[] = [];
  const stop = subscribeDiagnostics((event) => {
    outcomes.push(event);
  });
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    rmSync(lock + ".lock", { recursive: true });
    return "ok";
  });
  try {
    expect(withCacheLockSync(lock, () => "completed")).toBe("completed");
    expect(outcomes.map((event) => event.outcome)).toEqual(["waiting", "acquired"]);
    expect(outcomes[1]?.fields).toMatchObject({ attempts: 2 });
  } finally {
    stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded issue collection preserves causes and accounts for every omitted issue", async () => {
  const { DiagnosticIssues } = await import("../../../src/core/diagnostics/diagnostic-issues.ts");
  const collector = new DiagnosticIssues();
  for (let index = 0; index < 100; index++)
    collector.add(Object.assign(new Error(`failure ${String(index)}`), { code: "EIO" }));
  const snapshot = collector.snapshot();
  expect(snapshot.length).toBeLessThanOrEqual(32);
  expect(snapshot[0]).toMatchObject({ message: "failure 0", code: "EIO" });
  expect(snapshot.filter((issue) => issue.name !== "Omitted").length + (snapshot.at(-1)?.omittedCauses ?? 0)).toBe(100);
  const restored = new DiagnosticIssues();
  for (const issue of snapshot) restored.add(issue);
  expect(restored.snapshot()).toEqual(snapshot);
});
