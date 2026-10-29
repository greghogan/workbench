import { retryNetwork, NetworkUnavailable, AcquisitionRejected, AcquisitionReason } from "./network-retry.mts";
import { runOwnedChild, processCancellation } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { DiagnosticCapture, redact, retainDiagnosticStream } from "./diagnostic-text.mjs";
import { UserFacingError } from "./diagnostic-errors.mjs";
import type { ProcessLock } from "../src/process-lock.js";

/** Interpretation of external command output is confined to this acquisition boundary. */
export function classifyAcquisitionOutput(text: string): AcquisitionReason {
  if (
    /HTTP(?:\/[\d.]+)?[ :]+(?:401|403)\b|denied:|unauthorized|authentication required|authentication failed/i.test(text)
  )
    return AcquisitionReason.Authentication;
  if (/manifest unknown|no such manifest|manifest_unknown|HTTP(?:\/[\d.]+)?[ :]+404\b/i.test(text))
    return AcquisitionReason.Missing;
  if (/checksum mismatch|signature verification failed|hash sum mismatch/i.test(text))
    return AcquisitionReason.Integrity;
  if (
    /certificate (?:has expired|is invalid|verify failed)|certificate_verify_failed|self.signed certificate|SSL certificate problem/i.test(
      text,
    )
  )
    return AcquisitionReason.Certificate;
  if (/compiler error:/i.test(text)) return AcquisitionReason.Rejected;
  return /(?:(?:unexpected status|status code|server returned|response status)[^\r\n]{0,100}\b(?:408|429|500|502|503|504)\b|HTTP(?:\/[\d.]+)?(?: error)?[ :]+(?:408|429|500|502|503|504)\b|\b(?:500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-out)\b|\b(?:ECONNRESET|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b|(?:connection|connect|operation|TLS handshake) timed out|temporary failure (?:in name resolution|resolving)|could not resolve host|connection reset by peer|unexpected EOF|network is unreachable|(?:Failed to fetch|Failed to download|failed to fetch|failed to download)[^\r\n]*(?:\b50[0-9]\b|\b429\b|timed out))/i.test(
    text,
  )
    ? AcquisitionReason.Unavailable
    : AcquisitionReason.Rejected;
}

export interface AcquisitionCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  owner?: ProcessLock;
  quiet?: boolean;
  capture?: boolean;
  timeoutMs?: number;
}

/** One owned attempt, for callers that retry a complete private acquisition transaction. */
export async function acquisitionAttempt(
  operation: string,
  command: string,
  args: string[],
  options: AcquisitionCommandOptions & { signal: AbortSignal },
): Promise<string> {
  const capture = new DiagnosticCapture(65536);
  const stdout: Buffer[] = [],
    forwarding: Promise<void>[] = [],
    outputErrors: unknown[] = [];
  let bytes = 0;
  const limit = 16 * 1024 * 1024;
  const result = await runOwnedChild(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    signal: options.signal,
    ...(options.owner ? { owner: options.owner } : {}),
    output(out, err) {
      for (const [stream, destination] of [
        [out, process.stdout],
        [err, process.stderr],
      ] as const) {
        stream.on("data", (chunk: Buffer) => {
          capture.add(chunk);
          if (stream === out && options.capture) {
            bytes += chunk.length;
            if (bytes <= limit) stdout.push(chunk);
          }
        });
        if (!options.quiet && !options.capture)
          forwarding.push(
            retainDiagnosticStream(stream, destination).catch((error: unknown) => {
              outputErrors.push(error);
            }),
          );
      }
    },
  });
  await Promise.all(forwarding);
  const failure = processFailure(operation, result, { stderr: capture.text(), limit: 8192 });
  if (outputErrors.length)
    throw new AcquisitionRejected("Acquisition output could not be retained", {
      cause: new AggregateError([...(failure ? [failure] : []), ...outputErrors]),
    });
  if (bytes > limit)
    throw new AcquisitionRejected(
      "Captured acquisition output exceeds its byte limit",
      failure ? { cause: failure } : undefined,
    );
  if (failure) {
    const reason = classifyAcquisitionOutput(capture.text());
    if (!result.signal && !result.descendantsActive && reason === AcquisitionReason.Unavailable)
      throw new NetworkUnavailable(`${redact(operation)}: temporary network or upstream-service failure`, {
        cause: failure,
      });
    throw new AcquisitionRejected(
      `${redact(operation)} failed; see the retained command output.`,
      { cause: failure },
      result.signal || result.descendantsActive ? AcquisitionReason.Rejected : reason,
    );
  }
  return options.capture ? Buffer.concat(stdout).toString("utf8").trim() : "";
}

/** Only safe acquisition commands are retried. The caller owns any overall deadline. */
export async function acquireCommand(
  operation: string,
  command: string,
  args: string[],
  options: AcquisitionCommandOptions = {},
): Promise<string> {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))
    throw new Error("Invalid acquisition deadline");
  const cancellation = options.signal ? undefined : processCancellation();
  const deadline = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
  const signals = [options.signal ?? cancellation?.signal, deadline].filter(
    (signal): signal is AbortSignal => !!signal,
  );
  const signal = AbortSignal.any(signals);
  try {
    return await retryNetwork(operation, () => acquisitionAttempt(operation, command, args, { ...options, signal }), {
      signal,
    });
  } catch (cause) {
    if (deadline?.aborted)
      throw new UserFacingError(
        `${redact(operation)} exceeded its caller-selected deadline (${String(options.timeoutMs)} ms).`,
        { cause },
      );
    throw cause;
  } finally {
    cancellation?.close();
  }
}
