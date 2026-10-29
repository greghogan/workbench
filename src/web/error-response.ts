import { CacheBusy } from "../cache-lock.js";
import { redact, diagnosticError, restoreDiagnosticError } from "../diagnostics.js";
import { InvalidInput, MissingResource, StateConflict } from "../input-errors.js";
import { WebError } from "./errors.js";

export function errorStatus(error: unknown): WebError["status"] {
  return error instanceof WebError
    ? error.status
    : error instanceof InvalidInput
      ? 400
      : error instanceof MissingResource
        ? 404
        : error instanceof StateConflict || error instanceof CacheBusy
          ? 409
          : 500;
}
export function workerFailure(error: unknown) {
  return { status: errorStatus(error), error: diagnosticError(error, process.env.WORKBENCH_LOG_LEVEL === "debug") };
}
export function decodeWorkerFailure(value: unknown): WebError {
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    ![400, 403, 404, 409, 413, 500, 503].includes(value.status as number) ||
    !("error" in value) ||
    !value.error ||
    typeof value.error !== "object" ||
    !("message" in value.error) ||
    typeof value.error.message !== "string"
  )
    throw new InvalidInput("Invalid worker failure");
  const cause = restoreDiagnosticError(value.error);
  const error = new WebError(value.status as WebError["status"], cause.message, { cause });
  if (cause.name === "AbortError") error.name = "AbortError";
  return error;
}
export function errorResponse(error: unknown, requestId: string): { status: number; message: string } {
  const status = errorStatus(error);
  return {
    status,
    message:
      status === 500
        ? `Internal operation failed. Diagnostic reference: ${requestId}`
        : redact(error instanceof Error ? error.message : String(error)),
  };
}
