import type { ProcessTermination } from "./diagnostic-contract.mjs";
import { DiagnosticCapture, redact } from "./diagnostics.mjs";

type ProcessOutcome = Omit<ProcessTermination, "pid"> & { pid: number; error?: Error };

/** Describe abnormal termination without logging command arguments or the child environment. */
export function processFailure(
  operation: string,
  outcome: ProcessOutcome,
  output?: { stdout?: string | Buffer | null; stderr?: string | Buffer | null; limit?: number },
): Error | undefined {
  if (!outcome.error && outcome.status === 0 && outcome.signal === null) return;
  const error = outcome.error;
  const capture = new DiagnosticCapture(output?.limit ?? 65536);
  for (const [stream, text] of [
    ["stdout", output?.stdout],
    ["stderr", output?.stderr],
  ] as const)
    if (text?.length) capture.add(Buffer.from(`\n${stream}:\n${Buffer.isBuffer(text) ? text.toString("utf8") : text}`));
  const failure = new Error(
    `${redact(operation)} failed (pid=${String(outcome.pid)}, status=${String(outcome.status)}, signal=${String(outcome.signal)})${capture.bytes ? capture.text() : ""}`,
    error ? { cause: error } : undefined,
  );
  return Object.assign(failure, {
    processOutcome: {
      operation,
      pid: outcome.pid > 0 ? outcome.pid : null,
      status: outcome.status,
      signal: outcome.signal,
    },
  });
}
