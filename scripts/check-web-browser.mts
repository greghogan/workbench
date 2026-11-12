import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBrowserIntegration } from "../app/test/integration/browser/runner.mts";
import { isMainScript } from "./script-entry.mjs";
import {
  diagnostic,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
} from "../app/src/core/diagnostics/diagnostics.mjs";
if (isMainScript(import.meta.url)) {
  await runBrowserIntegration(resolve(import.meta.dirname, ".."), fileURLToPath(import.meta.url)).catch(
    (error: unknown) => {
      diagnostic(
        LogLevel.Error,
        DiagnosticOperation.Command,
        DiagnosticOutcome.Failed,
        { command: "browser-integration" },
        error,
      );
      process.exitCode = 1;
    },
  );
}
