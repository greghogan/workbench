import { spawn } from "node:child_process";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { constants, createGunzip, createZstdDecompress } from "node:zlib";

/** Keep decompressor memory and cancellation independent of retained archive contents. */
export function archiveDecoder(path: string, signal: AbortSignal, windowLog: number) {
  if (!path.endsWith(".xz")) {
    const stream = path.endsWith(".zst")
      ? createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: windowLog } })
      : path.endsWith(".gz") || path.endsWith(".tgz")
        ? createGunzip()
        : new PassThrough();
    return { input: stream as Writable, output: stream as Readable, completed: Promise.resolve() };
  }
  signal.throwIfAborted();
  const child = spawn("xz", ["--decompress", "--stdout", "--memlimit-decompress=128MiB"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const abort = () => {
    child.kill();
  };
  signal.addEventListener("abort", abort, { once: true });
  const completed = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else reject(new Error("XZ decompression failed"));
    });
  });
  return { input: child.stdin, output: child.stdout, completed };
}
