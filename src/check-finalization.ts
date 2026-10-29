import { maintainAfterSuccessfulChecks } from "./auto-prune.js";
import type { SuccessfulGateEvidence } from "./project-requirements.js";
import { writeDiagnosticText, diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "./diagnostics.js";

/** Required ownership cleanup stays visible after the check outcome has been reported. */
export async function finalizeChecks(
  root: string,
  checkedRoot: string,
  evidence: SuccessfulGateEvidence,
): Promise<void> {
  await maintainAfterSuccessfulChecks(root, checkedRoot, evidence, (phase) => {
    const label = phase.name === "requirements" ? "Updating project tool requirements" : "Pruning superseded caches";
    writeDiagnosticText(
      phase.state === "running" ? `${label}…` : `${label}: ${phase.state} (${(phase.durationMs / 1000).toFixed(1)}s).`,
    );
    diagnostic(
      LogLevel.Debug,
      DiagnosticOperation.Command,
      phase.state === "failed"
        ? DiagnosticOutcome.Failed
        : phase.state === "running"
          ? DiagnosticOutcome.Started
          : DiagnosticOutcome.Completed,
      { command: "check finalization", phase: phase.name, durationMs: phase.durationMs },
    );
  });
}
