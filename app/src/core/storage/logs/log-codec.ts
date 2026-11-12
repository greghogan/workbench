import * as zlib from "node:zlib";
import type { Transform, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LogCompression, LogCompressionPreference } from "../../diagnostics/diagnostic-contract.mjs";

function zstdFactory(mode: "compress" | "decompress") {
  const native = zlib as unknown as {
    createZstdCompress?: (options?: zlib.ZstdOptions) => Transform;
    createZstdDecompress?: (options?: zlib.ZstdOptions) => Transform;
  };
  return mode === "compress" ? native.createZstdCompress : native.createZstdDecompress;
}
export function selectLogCompression(
  preference: LogCompressionPreference,
  supportsZstd = Boolean(zstdFactory("compress") && zstdFactory("decompress")),
): LogCompression {
  if (preference === LogCompressionPreference.Auto) return supportsZstd ? LogCompression.Zstd : LogCompression.Gzip;
  if (preference === LogCompression.Zstd && !supportsZstd)
    throw new Error(
      "This Node runtime cannot read and write Zstandard logs; select auto, gzip, or a supported runtime",
    );
  return preference;
}
export function logExtension(compression: LogCompression): string {
  return compression === LogCompression.Zstd ? ".zst" : compression === LogCompression.Gzip ? ".gz" : "";
}
export interface LogTransferOptions {
  deadlineMs?: number | null;
  beforeCodec?: Transform[];
  afterCodec?: Transform[];
  end?: boolean;
}
/** One pipeline owns every stage and preserves the initiating I/O or codec error. */
export async function transferLog(
  source: Readable,
  destination: Writable,
  compression: LogCompression,
  mode: "compress" | "decompress",
  options: LogTransferOptions = {},
): Promise<void> {
  let codec: Transform | undefined;
  if (compression === LogCompression.Gzip) codec = mode === "compress" ? zlib.createGzip() : zlib.createGunzip();
  if (compression === LogCompression.Zstd) {
    const factory = zstdFactory(mode);
    if (!factory) throw new Error("This Node runtime does not provide the Zstandard codec required by this log");
    codec = factory({
      params:
        mode === "compress"
          ? { [zlib.constants.ZSTD_c_compressionLevel]: 3, [zlib.constants.ZSTD_c_checksumFlag]: 1 }
          : { [zlib.constants.ZSTD_d_windowLogMax]: 27 },
    });
  }
  const cancellation = new AbortController();
  const deadline = options.deadlineMs === undefined ? 60000 : options.deadlineMs;
  const timer =
    deadline === null
      ? undefined
      : setTimeout(() => {
          cancellation.abort(new Error(`Log ${mode} deadline exceeded`));
        }, deadline);
  timer?.unref();
  try {
    await pipeline(
      [source, ...(options.beforeCodec ?? []), ...(codec ? [codec] : []), ...(options.afterCodec ?? []), destination],
      { signal: cancellation.signal, end: options.end ?? true },
    );
  } finally {
    clearTimeout(timer);
  }
}
