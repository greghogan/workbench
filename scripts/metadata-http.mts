import { combineFailures } from "./diagnostic-errors.mjs";
/** Response mechanics only: callers own authentication, redirects, deadlines, and retry policy. */
export async function metadataBytes(
  response: Response,
  maximum: number,
  label: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid metadata response limit");
  if (!response.ok) {
    const failure = new Error(`${label}: HTTP ${String(response.status)}`);
    try {
      await response.body?.cancel();
    } catch (cleanup) {
      throw combineFailures(failure, cleanup, "Metadata rejection and cleanup failed");
    }
    throw failure;
  }
  if (!response.body) throw new Error(`${label}: response has no body`);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  const failures: unknown[] = [];
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new Error(`${label}: metadata exceeds ${String(maximum)} bytes`);
      chunks.push(next.value);
    }
    signal?.throwIfAborted();
  } catch (error) {
    failures.push(error);
  }
  try {
    await reader.cancel();
  } catch (error) {
    failures.push(error);
  }
  try {
    reader.releaseLock();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Metadata read and cleanup failed", { cause: failures[0] });
  return Buffer.concat(chunks, bytes);
}
export async function metadataJSON(
  response: Response,
  maximum: number,
  label: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return JSON.parse((await metadataBytes(response, maximum, label, signal)).toString("utf8")) as unknown;
}
