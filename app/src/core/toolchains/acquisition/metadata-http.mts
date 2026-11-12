import {
  AcquisitionRejected,
  AcquisitionReason,
  rejectNetworkResponse,
  settleNetworkCleanup,
} from "./network-retry.mts";
/** Response mechanics only: callers own authentication, redirects, deadlines, and retry policy. */
export async function metadataBytes(
  response: Response,
  maximum: number,
  label: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid metadata response limit");
  if (!response.ok) {
    return rejectNetworkResponse(
      response,
      new AcquisitionRejected(
        `${label}: HTTP ${String(response.status)}`,
        undefined,
        [401, 403].includes(response.status) ? AcquisitionReason.Authentication : AcquisitionReason.Rejected,
      ),
    );
  }
  if (!response.body) throw new AcquisitionRejected(`${label}: response has no body`);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  let failure: unknown;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new AcquisitionRejected(`${label}: metadata exceeds ${String(maximum)} bytes`);
      chunks.push(next.value);
    }
    signal?.throwIfAborted();
  } catch (error) {
    failure = error;
  }
  await settleNetworkCleanup(
    [
      async () => {
        try {
          await reader.cancel();
        } catch (error) {
          // An errored stream repeats its read rejection from cancel; this is not a new cleanup failure.
          if (error !== failure) throw error;
        }
      },
      () => {
        reader.releaseLock();
      },
    ],
    failure,
  );
  return Buffer.concat(chunks, bytes);
}
export async function metadataJSON(
  response: Response,
  maximum: number,
  label: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const bytes = await metadataBytes(response, maximum, label, signal);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause) {
    throw new AcquisitionRejected(`${label}: invalid JSON metadata`, { cause });
  }
}
