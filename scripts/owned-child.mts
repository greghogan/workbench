import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ProcessLock } from "../src/process-lock.js";

export interface ChildOutcome {
  pid: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}
export interface OwnedChildOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  owner?: ProcessLock;
  windowsVerbatimArguments?: boolean;
  output?: (stdout: Readable, stderr: Readable) => void;
}
export function processCancellation() {
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  return {
    signal: controller.signal,
    close: () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    },
  };
}

/** Own the complete child group through cancellation and reaping, before its scratch data can be released. */
export async function runOwnedChild(
  command: string,
  args: string[],
  options: OwnedChildOptions,
): Promise<ChildOutcome> {
  options.signal.throwIfAborted();
  options.owner?.beforeSpawn();
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    options.owner?.spawned(undefined, false);
    throw error;
  }
  let failure: Error | undefined;
  const killing: Promise<void>[] = [];
  const stop = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else
        killing.push(
          new Promise<void>((resolve) => {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
            killer.on("error", (error) => {
              failure ??= error;
            });
            killer.on("close", () => {
              resolve();
            });
          }),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        failure ??= error instanceof Error ? error : new Error("Child termination failed", { cause: error });
    }
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const abort = () => {
    stop("SIGINT");
    timers.push(
      setTimeout(() => {
        stop("SIGTERM");
      }, 5000),
      setTimeout(() => {
        stop("SIGKILL");
      }, 10000),
    );
  };
  child.on("error", (error) => {
    failure ??= error;
  });
  const closed = new Promise<ChildOutcome>((resolve) => {
    child.once("close", (status, signal) => {
      resolve({ pid: child.pid ?? 0, status, signal });
    });
  });
  try {
    options.owner?.spawned(child.pid, process.platform !== "win32");
  } catch (error) {
    stop("SIGKILL");
    await closed;
    throw error;
  }
  try {
    try {
      if (options.output) options.output(child.stdout, child.stderr);
      else {
        child.stdout.pipe(process.stdout, { end: false });
        child.stderr.pipe(process.stderr, { end: false });
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Child output setup failed", { cause: error });
      child.stdout.resume();
      child.stderr.resume();
      stop("SIGKILL");
    }
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    const outcome = await closed;
    if (options.signal.aborted) stop("SIGKILL");
    await Promise.all(killing);
    if (process.platform !== "win32" && child.pid !== undefined) {
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          throw error;
        }
        if (Date.now() >= deadline) {
          failure ??= new Error("Child descendants remain active; preserving owned scratch");
          break;
        }
        await delay(10);
      }
    }
    return { ...outcome, ...(failure ? { error: failure } : {}) };
  } finally {
    options.signal.removeEventListener("abort", abort);
    for (const timer of timers) clearTimeout(timer);
  }
}

/** Capture only small protocol/query output. Effectful verbose commands should retain streamed logs instead. */
export async function captureOwnedChild(
  command: string,
  args: string[],
  options: Omit<OwnedChildOptions, "output">,
  limit = 1024 * 1024,
) {
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let bytes = 0;
  const outcome = await runOwnedChild(command, args, {
    ...options,
    output: (out, err) => {
      for (const [stream, chunks] of [
        [out, stdout],
        [err, stderr],
      ] as const)
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= limit) chunks.push(chunk);
        });
    },
  });
  return {
    ...outcome,
    ...(bytes > limit ? { error: new Error(`Captured command output exceeds ${String(limit)} bytes`) } : {}),
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}
