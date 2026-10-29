import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ProcessLock } from "../src/process-lock.js";

export interface ChildOutcome {
  pid: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  descendantsActive?: boolean;
}
export interface OwnedChildOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  owner?: ProcessLock;
  input?: string;
  inheritInput?: boolean;
  shutdown?: "cancel" | "drain";
  stopDescendantsOnExit?: boolean;
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
  if (options.input !== undefined && options.inheritInput)
    throw new Error("Child input must be supplied or inherited, not both");
  options.owner?.beforeSpawn();
  const cancelling = options.shutdown !== "drain";
  let child: ChildProcessByStdio<Writable | null, Readable, Readable>;
  try {
    const settings = {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      // CREATE_NO_WINDOW would detach compiler workers from their private UTF-8 console.
      windowsHide: options.env.WORKBENCH_NATIVE_UTF8_CONSOLE !== "1",
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
    };
    child =
      options.input !== undefined
        ? spawn(command, args, { ...settings, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(command, args, { ...settings, stdio: [options.inheritInput ? "inherit" : "ignore", "pipe", "pipe"] });
  } catch (error) {
    options.owner?.spawned(undefined, false);
    throw error;
  }
  let failure: Error | undefined;
  let descendantsActive = false;
  const killing: Promise<void>[] = [];
  const stop = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    // A closed Windows parent no longer owns its numeric PID; its initial tree kill is awaited below.
    if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) return;
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
  if (options.stopDescendantsOnExit)
    child.once("exit", () => {
      stop("SIGTERM");
      timers.push(
        setTimeout(() => {
          stop("SIGKILL");
        }, 2000),
      );
    });
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
  child.stdin?.on("error", (error) => {
    failure ??= error;
  });
  const closed = new Promise<ChildOutcome>((resolve) => {
    child.once("close", (status, signal) => {
      resolve({ pid: child.pid ?? 0, status, signal });
    });
  });
  let completed: (() => void) | undefined;
  try {
    completed = options.owner?.spawned(child.pid, process.platform !== "win32");
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
    if (cancelling) {
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    }
    if (options.input !== undefined) child.stdin?.end(options.input);
    const outcome = await closed;
    if (cancelling && options.signal.aborted) stop("SIGKILL");
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
          descendantsActive = true;
          failure ??= new Error("Child descendants remain active; preserving owned scratch");
          break;
        }
        await delay(10);
      }
    }
    try {
      completed?.();
    } catch (cause) {
      const ownership = cause instanceof Error ? cause : new Error("Child ownership update failed", { cause });
      failure = failure
        ? new AggregateError([failure, ownership], "Child execution and ownership update failed", { cause: failure })
        : ownership;
    }
    return {
      ...outcome,
      ...(failure ? { error: failure } : {}),
      ...(descendantsActive ? { descendantsActive: true } : {}),
    };
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
