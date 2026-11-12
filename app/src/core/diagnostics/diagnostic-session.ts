import { BoundedDiagnosticWriter } from "./diagnostic-writer.mjs";
import {
  LogLevel,
  DiagnosticOperation,
  DiagnosticOutcome,
  diagnostic,
  subscribeDiagnostics,
  createDiagnosticEvent,
  renderDiagnosticEvent,
  LogFormat,
  LogScope,
  restoreDiagnosticError,
  acceptsLogLevel,
} from "./diagnostics.mjs";
import { captureTerminal } from "./terminal-transcript.js";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { diagnosticLogDirectory } from "../storage/storage.js";
import { LogMaintenance } from "../storage/logs/log-maintenance.js";
import { DiagnosticLog } from "../storage/logs/diagnostic-log.js";
import { userConfigValues } from "../configuration/user-config.js";

/** One command owns a persistent diagnostic session; slow sinks report omissions instead of growing memory. */
export async function startDiagnosticSession(
  level: LogLevel = LogLevel.Info,
  scope: typeof LogScope.Cli | typeof LogScope.Server = LogScope.Cli,
  preferences = userConfigValues(),
) {
  const namespace = join(diagnosticLogDirectory(), scope),
    directory = join(namespace, randomUUID());
  mkdirSync(namespace, { recursive: true, mode: 0o700 });
  const maintenance = new LogMaintenance(diagnosticLogDirectory(), scope, preferences);
  const file = new DiagnosticLog(directory, {
    scope,
    retention: maintenance.policies[scope],
    ...maintenance.rotation,
    onSealed: () => {
      void maintenance.request();
    },
  });
  const writer = new BoundedDiagnosticWriter(file, (omitted) =>
    renderDiagnosticEvent(
      createDiagnosticEvent(
        LogLevel.Warn,
        DiagnosticOperation.PersistentDiagnostics,
        DiagnosticOutcome.Dropped,
        { omitted },
        undefined,
        "events omitted by backpressure",
      ),
      LogFormat.Json,
    ),
  );
  try {
    await file.ready;
  } catch (error) {
    const stopped = new Promise<void>((resolve) => {
      file.once("close", resolve);
    });
    file.destroy();
    await stopped;
    writer.dispose();
    throw error;
  }
  const restore = subscribeDiagnostics((event) => {
    writer.write(renderDiagnosticEvent(event, LogFormat.Json));
  }, level);
  const closeTranscript = scope === LogScope.Server ? captureTerminal(file) : undefined;
  const record = (event: ReturnType<typeof createDiagnosticEvent>) => {
    if (acceptsLogLevel(event.level, level)) writer.write(renderDiagnosticEvent(event, LogFormat.Json));
  };
  record(
    createDiagnosticEvent(LogLevel.Info, DiagnosticOperation.PersistentDiagnostics, DiagnosticOutcome.Started, {
      directory,
    }),
  );
  let closing: Promise<void> | undefined;
  let reportedFailure = false;
  file.once("error", (error: unknown) => {
    reportedFailure = true;
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.PersistentDiagnostics,
      DiagnosticOutcome.Unavailable,
      { directory },
      error,
      "disk logging stopped; service operations continue",
    );
  });
  maintenance.start();
  return {
    directory,
    recordCommand(command: string, outcome: DiagnosticOutcome, error?: unknown): void {
      record(
        createDiagnosticEvent(
          outcome === DiagnosticOutcome.Failed ? LogLevel.Error : LogLevel.Info,
          DiagnosticOperation.Command,
          outcome,
          { command },
          error,
        ),
      );
    },
    close(): Promise<void> {
      if (closing) return closing;
      closing = (async () => {
        await maintenance.stop();
        record(
          createDiagnosticEvent(LogLevel.Info, DiagnosticOperation.PersistentDiagnostics, DiagnosticOutcome.Stopping, {
            directory,
          }),
        );
        restore();
        await closeTranscript?.();
        writer.flushOmissions(true);
        if (writer.omitted)
          file.recordIssue(new Error(`${String(writer.omitted)} diagnostic events omitted by backpressure`));
        const stopped = file.closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              file.once("close", resolve);
            });
        file.end();
        await stopped;
        writer.dispose();
        const { omitted, failure } = writer;
        if (omitted)
          diagnostic(
            LogLevel.Warn,
            DiagnosticOperation.PersistentDiagnostics,
            DiagnosticOutcome.Dropped,
            { directory, omitted },
            undefined,
            "events omitted by backpressure",
          );
        if (failure && !reportedFailure)
          diagnostic(
            LogLevel.Warn,
            DiagnosticOperation.PersistentDiagnostics,
            DiagnosticOutcome.Unavailable,
            { directory },
            failure,
            "session log incomplete",
          );
        await maintenance.request();
        if (file.issues.length)
          diagnostic(
            LogLevel.Warn,
            DiagnosticOperation.PersistentDiagnostics,
            DiagnosticOutcome.Unavailable,
            { directory, issues: file.issues.length },
            new AggregateError(file.issues.map(restoreDiagnosticError), "Session finalization reported issues"),
          );
      })();
      return closing;
    },
  };
}
