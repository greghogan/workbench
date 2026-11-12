import { isMainThread } from "node:worker_threads";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../core/diagnostics/diagnostics.mjs";
import { ChecksCancelled } from "../core/execution/checks/check-cancellation.js";

// Worker dispatch belongs to the server; ordinary CLI startup never loads it.
void (
  isMainThread
    ? import("./program.js").then(({ runCLI }) => {
        runCLI();
      })
    : import("../server/workspace/worker-entry.js").then(({ startApplicationWorker }) => {
        if (!startApplicationWorker()) throw new Error("Unrecognized Workbench application worker");
      })
).catch((error: unknown) => {
  diagnostic(LogLevel.Error, DiagnosticOperation.Command, DiagnosticOutcome.Failed, { command: "workbench" }, error);
  process.exitCode = error instanceof ChecksCancelled ? 130 : 1;
});
