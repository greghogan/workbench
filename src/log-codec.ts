import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as zlib from "node:zlib";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DiagnosticCapture } from "./diagnostics.js";
import { processFailure } from "../scripts/process-outcome.mjs";
/** Native Zstandard keeps the Node runtime floor unchanged; older Node can use an installed zstd. */
export async function transferZstd(
  source: Readable,
  destination: Writable,
  mode: "compress" | "decompress",
  options: {
    deadlineMs?: number | null;
    spawnZstd?: (mode: "compress" | "decompress") => ChildProcessWithoutNullStreams;
  } = {},
): Promise<void> {
  const native = zlib as unknown as {
    createZstdCompress?: (options?: zlib.ZstdOptions) => Transform;
    createZstdDecompress?: (options?: zlib.ZstdOptions) => Transform;
  };
  const factory = options.spawnZstd
    ? undefined
    : mode === "compress"
      ? native.createZstdCompress
      : native.createZstdDecompress;
  const deadlineMs = options.deadlineMs === undefined ? 60000 : options.deadlineMs;
  const controller = new AbortController();
  const signal = controller.signal;
  if (factory) {
    const timer =
      deadlineMs === null
        ? undefined
        : setTimeout(() => {
            controller.abort(new Error("Zstandard deadline exceeded"));
          }, deadlineMs);
    try {
      await pipeline(
        source,
        factory({
          params:
            mode === "compress"
              ? { [zlib.constants.ZSTD_c_compressionLevel]: 3, [zlib.constants.ZSTD_c_checksumFlag]: 1 }
              : { [zlib.constants.ZSTD_d_windowLogMax]: 27 },
        }),
        destination,
        { signal },
      );
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  const child =
    options.spawnZstd?.(mode) ??
    spawn("zstd", mode === "compress" ? ["-q", "-3", "-c"] : ["-q", "-d", "-c", "-M128MB"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  const capture = new DiagnosticCapture();
  let failure: Error | undefined;
  child.stderr.on("data", (bytes: Buffer) => {
    capture.add(bytes);
  });
  child.on("error", (error) => {
    failure = error;
  });
  const stopped = new Promise<void>((resolve, reject) => {
    child.once("close", (status, childSignal) => {
      const problem = processFailure(`log ${mode}`, {
        pid: child.pid ?? 0,
        status,
        signal: childSignal,
        ...(failure ? { error: failure } : {}),
      });
      if (problem)
        reject(new Error(`${problem.message}${capture.bytes ? `\n${capture.text()}` : ""}`, { cause: problem }));
      else if (failure) reject(failure);
      else resolve();
    });
  });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    child.kill();
    escalation ??= setTimeout(() => {
      child.kill("SIGKILL");
    }, 2000);
    escalation.unref();
  };
  const stop = (error: unknown): never => {
    terminate();
    throw error;
  };
  const timer =
    deadlineMs === null
      ? undefined
      : setTimeout(() => {
          failure ??= new Error("Zstandard deadline exceeded");
          controller.abort(failure);
          terminate();
        }, deadlineMs);
  child.once("close", () => {
    clearTimeout(escalation);
  });
  const outcomes = await Promise.allSettled([
    pipeline(source, child.stdin, { signal }).catch(stop),
    pipeline(child.stdout, destination, { signal }).catch(stop),
    stopped,
  ]);
  clearTimeout(timer);
  clearTimeout(escalation);
  const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as unknown] : []));
  if (failures.length)
    throw new AggregateError(failures, `Zstandard ${mode} failed; complete source log was preserved`);
}
