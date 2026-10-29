import { BoundedDiagnosticWriter } from "./diagnostic-writer.mjs";
import { LogLevel, LogFormat, DiagnosticOperation, DiagnosticOutcome, hasEnumValue } from "./diagnostic-contract.mjs";
import {
  clipped,
  boundedText,
  safeText,
  secretValues,
  wrapDiagnosticText,
  formatDiagnosticMessage,
} from "./diagnostic-text.mjs";
import {
  diagnosticError,
  describeDiagnosticError,
  restoreDiagnosticError,
  type DiagnosticError,
} from "./diagnostic-errors.mjs";
export * from "./diagnostic-contract.mjs";
export {
  DiagnosticCapture,
  DiagnosticRedactor,
  retainDiagnosticStream,
  redact,
  secretValues,
  wrapDiagnosticText,
  setDiagnosticTextWidth,
  formatDiagnosticMessage,
  formatDiagnosticSections,
} from "./diagnostic-text.mjs";
export {
  UserFacingError,
  diagnosticError,
  describeError,
  describeDiagnosticError,
  restoreDiagnosticError,
  combineFailures,
  settleCleanup,
} from "./diagnostic-errors.mjs";
export type { DiagnosticError } from "./diagnostic-errors.mjs";
export interface DiagnosticEvent {
  version: 1;
  time: string;
  level: LogLevel;
  operation: DiagnosticOperation;
  outcome: DiagnosticOutcome;
  message?: string;
  fields: Record<string, string | number | boolean | null>;
  error?: DiagnosticError;
  omittedBytes?: number;
}
const levels: Record<LogLevel, number> = {
  [LogLevel.Debug]: 0,
  [LogLevel.Info]: 1,
  [LogLevel.Warn]: 2,
  [LogLevel.Error]: 3,
};

let failedSinkWrites = 0;
const observers = new Set<(event: DiagnosticEvent) => void>();
function omissionEvent(omitted: number, operation = DiagnosticOperation.StderrDiagnostics): DiagnosticEvent {
  return {
    version: 1,
    time: new Date().toISOString(),
    level: LogLevel.Warn,
    operation,
    outcome: DiagnosticOutcome.Dropped,
    message: "events omitted by backpressure",
    fields: { omitted },
  };
}
export function renderDiagnosticEvent(
  event: DiagnosticEvent,
  format: LogFormat,
  columns = process.stderr.columns,
): string {
  if (format === LogFormat.Json) return JSON.stringify(event) + "\n";
  if (
    event.operation === DiagnosticOperation.Command &&
    event.outcome === DiagnosticOutcome.Failed &&
    typeof event.fields.command === "string" &&
    event.error
  ) {
    const explanation =
      event.error.summary && !event.error.stack ? event.error.summary : describeDiagnosticError(event.error);
    const header = `workbench: ${safeText(event.fields.command)} failed:`;
    return formatDiagnosticMessage(header, boundedText(explanation, 16000).text, columns) + "\n";
  }
  if (event.error?.summary && !event.error.stack)
    return formatDiagnosticMessage("workbench:", safeText(event.error.summary), columns) + "\n";
  const text = `workbench: ${event.level} ${event.operation}: ${event.outcome}${event.message ? ` (${event.message})` : ""}${Object.keys(event.fields).length ? ` ${JSON.stringify(event.fields)}` : ""}${event.error ? `: ${describeDiagnosticError(event.error)}` : ""}${event.omittedBytes ? ` [${String(event.omittedBytes)} diagnostic bytes omitted]` : ""}`;
  const rendered = boundedText(safeText(text), 16000);
  return (
    wrapDiagnosticText(
      rendered.text + (rendered.omitted ? ` [${String(rendered.omitted)} rendered diagnostic bytes omitted]` : ""),
      columns,
    ) + "\n"
  );
}
const stderrWriter = new BoundedDiagnosticWriter(process.stderr, (omitted) =>
  renderDiagnosticEvent(omissionEvent(omitted), settings.format),
);
const stderrSink = (text: string) => {
  const prior = stderrWriter.failure;
  stderrWriter.failure = undefined;
  if (!stderrWriter.write(text) && stderrWriter.failure)
    throw stderrWriter.failure instanceof Error
      ? stderrWriter.failure
      : new Error("Diagnostic sink failed", { cause: stderrWriter.failure });
  if (prior) failedSinkWrites++;
};
let statusSink = stderrSink;
let settings: { level: LogLevel; format: LogFormat; sink: (text: string) => void } = {
  level: LogLevel.Info,
  format: LogFormat.Text,
  sink: stderrSink,
};
export function configureDiagnostics(
  options: { level?: string; format?: string; sink?: (text: string) => void } = {},
): void {
  const level = options.level ?? process.env.WORKBENCH_LOG_LEVEL ?? LogLevel.Info;
  const format = options.format ?? process.env.WORKBENCH_LOG_FORMAT ?? LogFormat.Text;
  if (!hasEnumValue(LogLevel, level)) throw new Error("diagnostic level must be debug, info, warn, or error");
  if (!hasEnumValue(LogFormat, format)) throw new Error("diagnostic format must be text or json");
  settings = { level, format, sink: options.sink ?? stderrSink };
}
export function subscribeDiagnostics(observer: (event: DiagnosticEvent) => void): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}
export function writeDiagnosticText(text: string): void {
  const value = clipped(text, 16000);
  statusSink(
    wrapDiagnosticText(value.text + (value.omitted ? ` [${String(value.omitted)} status bytes omitted]` : "")) + "\n",
  );
}
export function routeDiagnostics(route: (text: string, forward: (text: string) => void) => void): () => void {
  const previous = settings.sink;
  const previousStatus = statusSink;
  const sink = (text: string) => {
    route(text, previous);
  };
  const status = (text: string) => {
    route(text, previousStatus);
  };
  settings = { ...settings, sink };
  statusSink = status;
  return () => {
    if (settings.sink === sink) settings = { ...settings, sink: previous };
    if (statusSink === status) statusSink = previousStatus;
  };
}
/** One normalization pass owns redaction, cause traversal and size bounds for every destination. */
export function createDiagnosticEvent(
  level: LogLevel,
  operation: DiagnosticOperation,
  outcome: DiagnosticOutcome,
  fields: Record<string, string | number | boolean | null> = {},
  error?: unknown,
  message?: string,
  includeStack = settings.level === LogLevel.Debug,
): DiagnosticEvent {
  const secrets = secretValues();
  const event: DiagnosticEvent = { version: 1, time: new Date().toISOString(), level, operation, outcome, fields: {} };
  if (message !== undefined) event.message = clipped(message, 1024, secrets).text;
  if (failedSinkWrites) event.fields.previousSinkFailures = failedSinkWrites;
  let omitted = 0;
  const entries = Object.entries(fields);
  for (const [key, value] of entries.slice(0, 24)) {
    const item = typeof value === "string" ? clipped(value, 1024, secrets) : undefined;
    event.fields[key.slice(0, 64)] = item?.text ?? value;
    omitted += item?.omitted ?? 0;
  }
  if (entries.length > 24) event.fields.omittedFields = entries.length - 24;
  if (error !== undefined) event.error = diagnosticError(error, includeStack, secrets);
  const bytes = Buffer.byteLength(JSON.stringify(event));
  if (bytes > 15500) {
    if (event.error)
      event.error = {
        name: "Error",
        message: boundedText(describeDiagnosticError(event.error), 4096).text,
        omittedCauses: 1,
      };
    event.fields = { omittedFields: entries.length };
    omitted += bytes;
  }
  if (omitted) event.omittedBytes = omitted;
  return event;
}
export function publishDiagnosticEvent(event: DiagnosticEvent): void {
  if (levels[event.level] < levels[settings.level]) return;
  let failed = false;
  for (const observer of observers) {
    try {
      observer(event);
    } catch {
      failed = true;
    }
  }
  try {
    settings.sink(renderDiagnosticEvent(event, settings.format));
  } catch {
    failed = true;
  }
  if (!failed) {
    failedSinkWrites = 0;
    return;
  }
  failedSinkWrites = Math.min(Number.MAX_SAFE_INTEGER, failedSinkWrites + 1);
  try {
    process.stderr.write(
      renderDiagnosticEvent(
        {
          version: 1,
          time: new Date().toISOString(),
          level: LogLevel.Error,
          operation: DiagnosticOperation.StderrDiagnostics,
          outcome: DiagnosticOutcome.Dropped,
          message: "diagnostic sink failed; event unavailable",
          fields: { omitted: 1 },
        },
        settings.format,
      ),
    );
  } catch {
    failedSinkWrites = Math.min(Number.MAX_SAFE_INTEGER, failedSinkWrites + 1);
  }
}
export function diagnostic(
  level: LogLevel,
  operation: DiagnosticOperation,
  outcome: DiagnosticOutcome,
  fields: Record<string, string | number | boolean | null> = {},
  error?: unknown,
  message?: string,
): void {
  if (levels[level] >= levels[settings.level])
    publishDiagnosticEvent(createDiagnosticEvent(level, operation, outcome, fields, error, message));
}
/** Child processes use JSON lines; reject unknown vocabularies and oversized graphs at the boundary. */
export function readDiagnosticEvent(value: unknown): DiagnosticEvent | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("time" in value) ||
    typeof value.time !== "string" ||
    !Number.isFinite(Date.parse(value.time)) ||
    !("level" in value) ||
    !hasEnumValue(LogLevel, value.level) ||
    !("operation" in value) ||
    !hasEnumValue(DiagnosticOperation, value.operation) ||
    !("outcome" in value) ||
    !hasEnumValue(DiagnosticOutcome, value.outcome) ||
    !("fields" in value) ||
    !value.fields ||
    typeof value.fields !== "object" ||
    Array.isArray(value.fields)
  )
    return;
  const fields: DiagnosticEvent["fields"] = {};
  const entries: [string, unknown][] = Object.entries(value.fields);
  if (entries.length > 25 || Buffer.byteLength(JSON.stringify(value)) > 16384) return;
  for (const [key, item] of entries) {
    if (!(
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ))
      return;
    fields[key] = item;
  }
  const error = "error" in value ? restoreDiagnosticError(value.error) : undefined;
  const event = createDiagnosticEvent(
    value.level,
    value.operation,
    value.outcome,
    fields,
    error,
    "message" in value && typeof value.message === "string" ? value.message : undefined,
    true,
  );
  event.time = value.time;
  if ("omittedBytes" in value && Number.isSafeInteger(value.omittedBytes) && Number(value.omittedBytes) >= 0)
    event.omittedBytes = (event.omittedBytes ?? 0) + Number(value.omittedBytes);
  return event;
}
