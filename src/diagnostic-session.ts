import { BoundedDiagnosticWriter } from "../scripts/diagnostic-writer.mjs";
import {
  LogLevel,
  DiagnosticOperation,
  DiagnosticOutcome,
  diagnostic,
  subscribeDiagnostics,
  createDiagnosticEvent,
  renderDiagnosticEvent,
  LogFormat,
  diagnosticLogFile,
} from "./diagnostics.js";
import { createWriteStream, mkdirSync } from "node:fs";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { diagnosticLogDirectory } from "./storage.js";
import { startLogRun, finishLogRun, logRetention } from "./log-storage.js";

/** One command owns a persistent diagnostic session; slow sinks report omissions instead of growing memory. */
export async function startDiagnosticSession() {
  const directory = join(diagnosticLogDirectory(), randomUUID());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  startLogRun(directory);
  const file = createWriteStream(join(directory, diagnosticLogFile), { flags: "wx", mode: 0o600 });
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
  await once(file, "open");
  const restore = subscribeDiagnostics((event) => {
    writer.write(renderDiagnosticEvent(event, LogFormat.Json));
  });
  diagnostic(LogLevel.Info, DiagnosticOperation.PersistentDiagnostics, DiagnosticOutcome.Started, { directory });
  let closed = false;
  return {
    directory,
    recordFailure(command: string, error: unknown): void {
      writer.write(
        renderDiagnosticEvent(
          createDiagnosticEvent(
            LogLevel.Error,
            DiagnosticOperation.Command,
            DiagnosticOutcome.Failed,
            { command },
            error,
          ),
          LogFormat.Json,
        ),
      );
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      diagnostic(LogLevel.Info, DiagnosticOperation.PersistentDiagnostics, DiagnosticOutcome.Stopping, { directory });
      restore();
      writer.flushOmissions(true);
      file.end();
      if (!file.closed)
        await once(file, "close").catch((error: unknown) => {
          writer.failure ??= error;
        });
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
      if (failure)
        diagnostic(
          LogLevel.Warn,
          DiagnosticOperation.PersistentDiagnostics,
          DiagnosticOutcome.Unavailable,
          { directory },
          failure,
          "session log incomplete",
        );
      try {
        const result = await finishLogRun(directory, logRetention(), [
          ...(failure ? [failure] : []),
          ...(omitted ? [new Error(`${String(omitted)} diagnostic events omitted by backpressure`)] : []),
        ]);
        if (!result.completed || result.errors.length)
          diagnostic(
            LogLevel.Warn,
            DiagnosticOperation.PersistentDiagnostics,
            DiagnosticOutcome.Unavailable,
            { directory, issues: result.errors.length },
            new AggregateError(result.errors, "Session finalization reported issues"),
          );
        if (result.completed)
          diagnostic(LogLevel.Info, DiagnosticOperation.PersistentDiagnostics, DiagnosticOutcome.Completed, {
            directory,
          });
      } catch (error) {
        diagnostic(
          LogLevel.Warn,
          DiagnosticOperation.PersistentDiagnostics,
          DiagnosticOutcome.Unavailable,
          { directory },
          error,
          "session finalization failed; source preserved",
        );
      }
    },
  };
}
