import { clipped, boundedText, secretValues } from "./diagnostic-text.mjs";
import { readProcessDiagnostic, type ProcessDiagnostic } from "./diagnostic-contract.mjs";
export interface DiagnosticError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  causes?: DiagnosticError[];
  omittedBytes?: number;
  omittedCauses?: number;
  process?: ProcessDiagnostic;
}
/** Error graphs have explicit depth, node, text, and stack bounds; cycles remain visible. */
export function diagnosticError(error: unknown, debug = false, secrets = secretValues()): DiagnosticError {
  const seen = new Set<unknown>();
  let remaining = 24;
  const read = (error: unknown, depth: number): DiagnosticError => {
    if (depth > 6 || remaining-- <= 0 || seen.has(error))
      return { name: "Omitted", message: "Error graph limit or cycle", omittedCauses: 1 };
    seen.add(error);
    const item = clipped(
      error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error",
      4096,
      secrets,
    );
    const result: DiagnosticError = {
      name: clipped(error instanceof Error ? error.name : "Error", 128, secrets).text,
      message: item.text,
      ...(item.omitted ? { omittedBytes: item.omitted } : {}),
    };
    if (error instanceof Error) {
      const observed = readProcessDiagnostic("processOutcome" in error ? error.processOutcome : undefined);
      if (observed) result.process = { ...observed, operation: clipped(observed.operation, 256, secrets).text };
      if ("diagnosticOmittedBytes" in error && typeof error.diagnosticOmittedBytes === "number")
        result.omittedBytes = (result.omittedBytes ?? 0) + error.diagnosticOmittedBytes;
      if ("diagnosticOmittedCauses" in error && typeof error.diagnosticOmittedCauses === "number")
        result.omittedCauses = error.diagnosticOmittedCauses;

      if ("code" in error && (typeof error.code === "string" || typeof error.code === "number"))
        result.code = clipped(String(error.code), 128, secrets).text;
      if (debug && error.stack) {
        const stack = clipped(error.stack, 8192, secrets);
        result.stack = stack.text;
        if (stack.omitted) result.omittedBytes = (result.omittedBytes ?? 0) + stack.omitted;
      }
      const members: unknown[] = error instanceof AggregateError ? (error.errors as unknown[]) : [];
      const children = members.slice(0, 8);
      let omitted = Math.max(0, members.length - children.length);
      if (error.cause !== undefined && !children.includes(error.cause)) {
        if (children.length < 8) children.push(error.cause);
        else omitted++;
      }
      if (children.length) result.causes = children.map((child) => read(child, depth + 1));
      if (omitted) result.omittedCauses = (result.omittedCauses ?? 0) + omitted;
    }
    return result;
  };
  try {
    return read(error, 0);
  } catch {
    return { name: "Unavailable", message: "Error properties could not be inspected safely", omittedCauses: 1 };
  }
}
export function describeDiagnosticError(error: DiagnosticError): string {
  const render = (error: DiagnosticError): string =>
    `${error.code ? `${error.code}: ` : ""}${error.message}${error.causes?.length ? `; caused by: ${error.causes.map(render).join("; ")}` : ""}${error.omittedBytes ? ` [${String(error.omittedBytes)} bytes omitted]` : ""}${error.omittedCauses ? ` [${String(error.omittedCauses)} causes omitted]` : ""}`;
  return boundedText(render(error), 16384).text;
}
export function describeError(error: unknown): string {
  return describeDiagnosticError(diagnosticError(error));
}
/** Decode the bounded error shape used by Workbench workers without trusting arbitrary properties. */
export function restoreDiagnosticError(value: unknown): Error {
  let remaining = 24;
  const read = (value: unknown, depth: number): Error => {
    if (
      remaining-- <= 0 ||
      depth > 6 ||
      !value ||
      typeof value !== "object" ||
      !("message" in value) ||
      typeof value.message !== "string" ||
      value.message.length > 16384
    )
      return new Error("Worker diagnostic unavailable or exceeds its limits");
    const causes =
      "causes" in value && Array.isArray(value.causes)
        ? value.causes.slice(0, 8).map((cause: unknown) => read(cause, depth + 1))
        : [];
    const error =
      causes.length > 1
        ? new AggregateError(causes, value.message)
        : new Error(value.message, causes[0] ? { cause: causes[0] } : undefined);
    if ("name" in value && typeof value.name === "string") error.name = value.name.slice(0, 128);
    if ("code" in value && typeof value.code === "string") Object.assign(error, { code: value.code.slice(0, 128) });
    if ("stack" in value && typeof value.stack === "string") error.stack = value.stack.slice(0, 8192);
    else delete error.stack;
    const process = readProcessDiagnostic("process" in value ? value.process : undefined);
    if (process) Object.assign(error, { processOutcome: process });
    if (
      "omittedBytes" in value &&
      typeof value.omittedBytes === "number" &&
      Number.isSafeInteger(value.omittedBytes) &&
      value.omittedBytes >= 0
    )
      Object.assign(error, { diagnosticOmittedBytes: value.omittedBytes });
    if (
      "omittedCauses" in value &&
      typeof value.omittedCauses === "number" &&
      Number.isSafeInteger(value.omittedCauses) &&
      value.omittedCauses >= 0
    )
      Object.assign(error, { diagnosticOmittedCauses: value.omittedCauses });
    return error;
  };
  return read(value, 0);
}
export function combineFailures(primary: unknown, cleanup: unknown, operation: string): Error {
  return new AggregateError([primary, cleanup], operation, { cause: primary });
}
export async function settleCleanup(cleanups: (() => unknown)[], primary?: unknown): Promise<void> {
  const errors: unknown[] = primary === undefined ? [] : [primary];
  for (const cleanup of cleanups)
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Operation finalization failed", { cause: primary ?? errors[0] });
}
