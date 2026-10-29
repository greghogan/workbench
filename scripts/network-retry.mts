import { setTimeout as delay } from "node:timers/promises";
import { UserFacingError, settleCleanup } from "./diagnostic-errors.mjs";
import { redact, boundedText } from "./diagnostic-text.mjs";
import { diagnostic, LogLevel, DiagnosticOperation, DiagnosticOutcome } from "./diagnostics.mjs";

export const AcquisitionReason = {
  Unavailable: "unavailable",
  Missing: "missing",
  Authentication: "authentication",
  Integrity: "integrity",
  Certificate: "certificate",
  Rejected: "rejected",
} as const;
export type AcquisitionReason = (typeof AcquisitionReason)[keyof typeof AcquisitionReason];

/** Only transport/availability failures carry this marker; integrity and command failures do not. */
export class NetworkUnavailable extends Error {
  readonly reason = AcquisitionReason.Unavailable;
  readonly retryAfterMs: number;
  constructor(message: string, options?: ErrorOptions, retryAfterMs = 0) {
    super(message, options);
    this.name = "NetworkUnavailable";
    this.retryAfterMs = retryAfterMs;
  }
}
export class AcquisitionRejected extends Error {
  readonly reason: AcquisitionReason;
  constructor(message: string, options?: ErrorOptions, reason: AcquisitionReason = AcquisitionReason.Rejected) {
    super(message, options);
    this.name = "AcquisitionRejected";
    this.reason = reason;
  }
}
export class NetworkRetryExhausted extends UserFacingError {
  readonly attempts: number;
  constructor(operation: string, attempts: number, error: unknown) {
    super(
      `${redact(operation)}: network acquisition remained unavailable after ${String(attempts)} attempts. ${boundedText(redact(error instanceof Error ? error.message : "Connection interrupted"), 1024).text}. Required inputs could not be verified; retry when the service is available.`,
      { cause: error },
    );
    this.name = "NetworkRetryExhausted";
    this.attempts = attempts;
  }
}

const transientCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Incomplete cause graphs are not evidence that replay is safe. */
function networkFailure(error: unknown): { transient: boolean; retryAfterMs: number; exhausted: boolean } {
  const pending = [error],
    seen = new Set<unknown>();
  let transient = false,
    retryAfterMs = 0,
    exhausted = false;
  for (let count = 0; pending.length && count < 24; count++) {
    const value = pending.shift();
    if (!(value instanceof Error) || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof AcquisitionRejected) return { transient: false, retryAfterMs: 0, exhausted: false };
    if (value instanceof NetworkRetryExhausted) {
      transient = true;
      exhausted = true;
    }
    if (value instanceof NetworkUnavailable) {
      transient = true;
      retryAfterMs = Math.max(retryAfterMs, Math.max(0, Math.min(value.retryAfterMs, 60000)));
    }
    if ("code" in value && typeof value.code === "string" && transientCodes.has(value.code)) transient = true;
    if (value.cause !== undefined) pending.push(value.cause);
    if (value instanceof AggregateError) {
      if (value.errors.length > 8) return { transient: false, retryAfterMs: 0, exhausted: false };
      pending.push(...(value.errors as unknown[]));
    }
  }
  return { transient: transient && pending.length === 0, retryAfterMs, exhausted };
}
/** Typed reasons stay attached through caller context without parsing rendered diagnostics. */
export function acquisitionReason(error: unknown): AcquisitionReason {
  const pending = [error],
    seen = new Set<unknown>();
  for (let count = 0; pending.length && count < 24; count++) {
    const value = pending.shift();
    if (!(value instanceof Error) || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof AcquisitionRejected) return value.reason;
    if (value.cause !== undefined) pending.push(value.cause);
    if (value instanceof AggregateError) pending.push(...(value.errors as unknown[]).slice(0, 8));
  }
  return transientNetworkFailure(error) ? AcquisitionReason.Unavailable : AcquisitionReason.Rejected;
}
export function transientNetworkFailure(error: unknown): boolean {
  return networkFailure(error).transient;
}
export function retryableNetworkFailure(error: unknown): boolean {
  const result = networkFailure(error);
  return result.transient && !result.exhausted;
}
export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 60_000)) : 0;
}

/** A cleanup failure vetoes replay; all callers retain the primary failure as well. */
export async function settleNetworkCleanup(cleanups: (() => unknown)[], primary?: unknown): Promise<void> {
  try {
    await settleCleanup(cleanups, primary);
  } catch (error) {
    if (error === primary) throw error;
    throw new AcquisitionRejected(
      `${primary instanceof Error ? primary.message + "; " : ""}Acquisition cleanup failed`,
      {
        cause: error,
      },
    );
  }
}
export async function releaseNetworkResponse(response: Response): Promise<void> {
  await settleNetworkCleanup([() => response.body?.cancel()]);
}
/** Rejection retains its original cause even if releasing the response also fails. */
export async function rejectNetworkResponse(response: Response, failure: Error): Promise<never> {
  await settleNetworkCleanup([() => response.body?.cancel()], failure);
  throw failure;
}
export interface NetworkAttempt {
  attempt: number;
  maximumAttempts: number;
  delayMs: number;
  exhausted: boolean;
  elapsedMs: number;
  error: unknown;
}

/** Retries share the caller's deadline and never replay an uncertain mutation. */
export async function retryNetwork<T>(
  operation: string,
  action: (attempt: number) => Promise<T>,
  options: {
    signal?: AbortSignal;
    attempts?: number;
    onFailure?: (event: NetworkAttempt) => void;
    diagnosticOperation?: DiagnosticOperation;
    fields?: Record<string, string | number | boolean | null>;
  } = {},
): Promise<T> {
  const started = performance.now();
  const maximumAttempts = options.attempts ?? 8;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 10)
    throw new Error("Invalid network attempt limit");
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await action(attempt);
    } catch (error) {
      const failure = networkFailure(error);
      if (options.signal?.aborted || !failure.transient || failure.exhausted) throw error;
      const exhausted = attempt === maximumAttempts;
      const delayMs = exhausted
        ? 0
        : Math.max(
            Math.round(Math.min(1000 * 2 ** (attempt - 1), 15_000) * (0.5 + Math.random() / 2)),
            failure.retryAfterMs,
          );
      const elapsedMs = performance.now() - started;
      options.onFailure?.({ attempt, maximumAttempts, delayMs, exhausted, elapsedMs, error });
      if (!options.onFailure)
        diagnostic(
          exhausted ? LogLevel.Error : LogLevel.Warn,
          options.diagnosticOperation ?? DiagnosticOperation.NetworkAcquisition,
          exhausted ? DiagnosticOutcome.Exhausted : DiagnosticOutcome.Retrying,
          { ...options.fields, acquisition: operation, attempt, maximumAttempts, delayMs, elapsedMs },
          error,
          exhausted ? "Acquisition retries exhausted" : "Transient acquisition failure; retrying",
        );
      if (exhausted) throw new NetworkRetryExhausted(operation, attempt, error);
      await delay(delayMs, undefined, { ...(options.signal ? { signal: options.signal } : {}) });
    }
  }
}

/** One request attempt; the surrounding operation owns retries, redirects, and private body consumption. */
export async function networkResponse(url: string | URL, options: RequestInit = {}): Promise<Response> {
  const location = new URL(url),
    source = location.origin + location.pathname;
  let response: Response;
  try {
    // codeql[js/file-access-to-http] Callers intentionally request project-selected artifact URLs or submit locked dependency metadata to OSV; local configuration supplies acquisition metadata, not arbitrary file uploads.
    response = await fetch(url, options);
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    if (
      transientNetworkFailure(cause) ||
      (cause instanceof TypeError &&
        cause.cause === undefined &&
        /fetch failed|failed to fetch|network|connection|offline/i.test(cause.message))
    )
      throw new NetworkUnavailable(`Connection failed: ${source}`, { cause });
    throw cause;
  }
  if ([408, 429].includes(response.status) || response.status >= 500) {
    const failure = new NetworkUnavailable(
      `HTTP ${String(response.status)} from ${source}`,
      undefined,
      retryAfterMilliseconds(response.headers.get("retry-after")),
    );
    return rejectNetworkResponse(response, failure);
  }
  return response;
}
