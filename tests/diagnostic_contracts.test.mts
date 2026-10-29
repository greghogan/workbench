import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCacheLockSync } from "../src/cache-lock.ts";
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
} from "../scripts/diagnostics.mjs";
import { BoundedDiagnosticWriter } from "../scripts/diagnostic-writer.mjs";
import { DiagnosticRedactor, redact } from "../scripts/diagnostic-text.mjs";
import { resolveDiagnosticOptions } from "../src/diagnostic-options.ts";
import { readCheckMessage, CheckMessage } from "../src/check-protocol.ts";
import { readProcessDiagnostic } from "../scripts/diagnostic-contract.mjs";
import { knownRoute, Route } from "../src/web/routes.ts";
import { relayCollectionDiagnostics } from "../src/web/collection-runner.ts";

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
  const preferences = { "diagnostics.level": "debug", "diagnostics.format": "json", "diagnostics.persist": true };
  const env = { WORKBENCH_LOG_LEVEL: "warn", WORKBENCH_LOG_PERSIST: "0" };
  expect(resolveDiagnosticOptions({}, env, preferences)).toEqual({ level: "warn", format: "json", persist: false });
  expect(resolveDiagnosticOptions({ logLevel: "error", logSave: true }, env, preferences)).toEqual({
    level: "error",
    format: "json",
    persist: true,
  });
  expect(env).toEqual({ WORKBENCH_LOG_LEVEL: "warn", WORKBENCH_LOG_PERSIST: "0" });
  expect(() => resolveDiagnosticOptions({ logLevel: "trace" }, {}, preferences)).toThrow(/diagnostic level/);
});
test("IPC and process termination codecs reject malformed values and preserve valid events", () => {
  expect(
    readCheckMessage({ type: CheckMessage.Logs, directory: "/run", files: ["../private"], errors: [] }),
  ).toBeUndefined();
  expect(
    readCheckMessage({ type: CheckMessage.Logs, directory: "/run", files: ["step-1.ABCDEF"], errors: [] }),
  ).toMatchObject({ files: ["step-1.ABCDEF"] });
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
