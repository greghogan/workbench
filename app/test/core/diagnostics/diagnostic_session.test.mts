import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDiagnosticSession } from "../../../src/core/diagnostics/diagnostic-session.ts";
import { maintainLogRuns } from "../../../src/core/storage/logs/log-retention.ts";
import { setUserOption } from "../../../src/core/configuration/user-config.ts";
import { configureDiagnostics, LogLevel, LogScope } from "../../../src/core/diagnostics/diagnostics.mjs";
vi.mock("../../../src/core/storage/logs/log-retention.ts", async (original) => {
  const actual = await original<typeof import("../../../src/core/storage/logs/log-retention.ts")>();
  return {
    ...actual,
    maintainLogRuns: vi.fn(() => Promise.resolve()),
  };
});
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  configureDiagnostics();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("periodic diagnostic retention never overlaps and shutdown drains its sweep and clears the timer", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-session-timer-"));
  roots.push(root);
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  setUserOption("logs.compression", "none");
  setUserOption("logs.server_rotate_hours", "0");
  setUserOption("logs.prune_interval_seconds", "60");
  configureDiagnostics({ level: LogLevel.Warn, sink: () => undefined });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const prune = vi.mocked(maintainLogRuns);
  prune.mockClear();
  const session = await startDiagnosticSession(LogLevel.Info, LogScope.Server);
  let release: (() => void) | undefined;
  try {
    await vi.waitFor(() => {
      expect(prune).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(59000);
    expect(prune).toHaveBeenCalledTimes(2);
    prune.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve();
          };
        }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(prune).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(180000);
    expect(prune).toHaveBeenCalledTimes(3);
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    if (!release) throw new Error("Expected an in-flight retention sweep");
    release();
    await closing;
    const finishedCalls = prune.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600000);
    expect(prune).toHaveBeenCalledTimes(finishedCalls);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release?.();
    await session.close();
  }
});

test("persistent writer errors are reported before shutdown and do not recursively emit warnings", async () => {
  const { DiagnosticLog } = await import("../../../src/core/storage/logs/diagnostic-log.ts");
  const { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogFormat } =
    await import("../../../src/core/diagnostics/diagnostics.mjs");
  const root = mkdtempSync(join(tmpdir(), "workbench-session-failure-"));
  roots.push(root);
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  const events: string[] = [];
  configureDiagnostics({
    level: LogLevel.Warn,
    format: LogFormat.Json,
    sink: (event) => {
      events.push(event);
    },
  });
  const session = await startDiagnosticSession(LogLevel.Info, LogScope.Server);
  vi.spyOn(DiagnosticLog.prototype, "_write").mockImplementation((_chunk, _encoding, done) => {
    done(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  });
  try {
    diagnostic(LogLevel.Info, DiagnosticOperation.Command, DiagnosticOutcome.Started, { test: "fault-trigger" });
    await vi.waitFor(() => {
      expect(events.join("")).toContain("disk logging stopped");
    });
    expect(events.join("")).toContain("ENOSPC");
    await session.close();
    expect(events.filter((event) => event.includes("disk logging stopped"))).toHaveLength(1);
  } finally {
    await session.close();
  }
});
