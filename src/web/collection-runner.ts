import { captureOwnedChild } from "../../scripts/owned-child.mjs";
import { join } from "node:path";
import { processFailure } from "../../scripts/process-outcome.mjs";
import { distributionRoot } from "../project-context.js";
import {
  CollectionOperation,
  DiagnosticCapture,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  diagnostic,
  publishDiagnosticEvent,
  readDiagnosticEvent,
} from "../diagnostics.js";
import type { CollectionRequest } from "./collection-service.js";
import { decodeCollectionPreview, type CollectionPreview } from "./protocol.js";

/** Acquisition and reconciliation run outside the listener so browsing remains responsive while shutdown drains admitted work. */
export async function runCollectionWorker(
  root: string,
  operation: CollectionOperation,
  request: CollectionRequest,
  expected: string | undefined,
): Promise<CollectionPreview | undefined> {
  const outcome = await captureOwnedChild(
    process.execPath,
    [join(distributionRoot(root), "bundle/main.cjs"), "web-collection", operation],
    {
      cwd: root,
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_LOG_PERSIST: "0", WORKBENCH_LOG_FORMAT: "json" },
      signal: new AbortController().signal,
      shutdown: "drain",
      input: JSON.stringify({ request, expected }),
    },
    16 * 1024 * 1024,
  );
  const errors = new DiagnosticCapture();
  errors.add(Buffer.from(outcome.stderr));
  const problem = processFailure("collection operation", outcome);
  if (problem) {
    const text = errors.text().trim();
    throw new Error(`${problem.message}${text ? `\n${text}` : ""}`, { cause: problem });
  }
  relayCollectionDiagnostics(errors, operation);
  return operation === CollectionOperation.Preview ? decodeCollectionPreview(JSON.parse(outcome.stdout)) : undefined;
}

/** Recognized child events retain severity; remaining stderr is an explicit warning. */
export function relayCollectionDiagnostics(capture: DiagnosticCapture, operation: CollectionOperation): void {
  const unstructured = new DiagnosticCapture();
  for (const line of capture.rawText().split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = readDiagnosticEvent(JSON.parse(line));
    } catch {
      /* Plain stderr remains a warning. */
    }
    if (event) publishDiagnosticEvent(event);
    else unstructured.add(Buffer.from(line + "\n"));
  }
  if (unstructured.bytes)
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.CollectionWorker,
      DiagnosticOutcome.Warnings,
      { operation, stderr: unstructured.text(), stderrBytes: capture.bytes },
      undefined,
      "completed with diagnostics",
    );
}
