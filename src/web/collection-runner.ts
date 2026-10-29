import { spawn } from "node:child_process";
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
export function runCollectionWorker(
  root: string,
  operation: CollectionOperation,
  request: CollectionRequest,
  expected: string | undefined,
): Promise<CollectionPreview | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(distributionRoot(root), "bundle/main.cjs"), "web-collection", operation],
      {
        env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_LOG_PERSIST: "0", WORKBENCH_LOG_FORMAT: "json" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      },
    );
    const output: Buffer[] = [];
    const errors = new DiagnosticCapture();
    let size = 0;
    let failure: Error | undefined;
    child.stdout.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > 16 * 1024 * 1024) {
        failure ??= new Error("collection preview exceeds 16 MiB; use the collection CLI for this proposal");
        child.kill();
      } else output.push(bytes);
    });
    child.stderr.on("data", (bytes: Buffer) => {
      errors.add(bytes);
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.stdin.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code, signal) => {
      const problem = processFailure("collection operation", {
        pid: child.pid ?? 0,
        status: code,
        signal,
        ...(failure ? { error: failure } : {}),
      });
      if (problem) {
        const text = errors.text().trim();
        reject(new Error(`${problem.message}${text ? `\n${text}` : ""}`, { cause: problem }));
        return;
      }
      try {
        relayCollectionDiagnostics(errors, operation);
        resolve(
          operation === CollectionOperation.Preview
            ? decodeCollectionPreview(JSON.parse(Buffer.concat(output).toString("utf8")))
            : undefined,
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(JSON.stringify({ request, expected }));
  });
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
