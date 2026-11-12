import { DiagnosticLog } from "../../src/core/storage/logs/diagnostic-log.ts";
import { captureTerminal } from "../../src/core/diagnostics/terminal-transcript.ts";
import {
  LogCompressionPreference,
  LogScope,
  LogLevel,
  DiagnosticOperation,
  DiagnosticOutcome,
  createDiagnosticEvent,
  renderDiagnosticEvent,
  LogFormat,
} from "../../src/core/diagnostics/diagnostics.mjs";

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || !process.send) throw new Error("A log directory and IPC channel are required");
  const sink = new DiagnosticLog(directory, {
    scope: LogScope.Server,
    retention: { maxAgeDays: 0, maxBytes: 0, compression: LogCompressionPreference.None },
    rotateBytes: 0,
    rotateMilliseconds: 0,
  });
  await sink.ready;
  const secret = "fixture-secret-across-writes";
  process.env.TRANSCRIPT_TEST_SECRET = secret;
  captureTerminal(sink);
  Reflect.deleteProperty(process.env, "TRANSCRIPT_TEST_SECRET");
  process.stdout.write("retained-stdout-startup\n");
  process.stderr.write("retained-stderr with " + secret.slice(0, 12));
  process.stderr.write(secret.slice(12) + "\n");
  await new Promise<void>((resolve, reject) => {
    sink.write(
      renderDiagnosticEvent(
        createDiagnosticEvent(LogLevel.Info, DiagnosticOperation.Command, DiagnosticOutcome.Started, {
          evidence: "abrupt-process-loss",
        }),
        LogFormat.Json,
      ),
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
  process.send("written");
  process.on("message", () => {
    process.exitCode = 1;
  });
}
void main().catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
