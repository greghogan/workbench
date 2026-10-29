import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { finished } from "node:stream/promises";
import type { ProcessLock } from "../src/process-lock.js";
import { spawnWindowsProcess, type WindowsProcess } from "./windows-process.mjs";
import { combineFailures } from "./diagnostic-errors.mjs";

type OwnedChild = ChildProcessByStdio<Writable | null, Readable | null, Readable | null>;

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
  input?: string | Readable;
  inheritInput?: boolean;
  inheritOutput?: boolean;
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

function connectInput(
  child: OwnedChild,
  input: OwnedChildOptions["input"],
  fail: (error: Error) => void,
  stop: () => void,
): (() => Promise<void>) | undefined {
  if (typeof input === "string") {
    child.stdin?.end(input);
    return;
  }
  if (!input) return;
  const failed = (error: Error) => {
    fail(error);
    if (child.exitCode === null && child.signalCode === null) stop();
  };
  input.once("error", failed);
  child.stdin?.once("error", failed);
  const closed = finished(input, { cleanup: true, readable: true, writable: false }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE")
      fail(error instanceof Error ? error : new Error("Child input cleanup failed", { cause: error }));
  });
  if (child.stdin) input.pipe(child.stdin);
  return async () => {
    if (child.stdin) input.unpipe(child.stdin);
    input.destroy();
    await closed;
    input.removeListener("error", failed);
    child.stdin?.removeListener("error", failed);
  };
}
function connectOutput(child: OwnedChild, options: OwnedChildOptions): void {
  if (options.inheritOutput) return;
  if (!child.stdout || !child.stderr) throw new Error("Owned command output requires readable pipes");
  if (options.output) options.output(child.stdout, child.stderr);
  else {
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
  }
}

/** The supervisor retains a job handle until all descendants are gone; PID exit is not drainage proof. */
async function runWindowsOwnedChild(
  command: string,
  args: string[],
  options: OwnedChildOptions,
): Promise<ChildOutcome> {
  options.owner?.beforeSpawn();
  let running: WindowsProcess;
  try {
    running = await spawnWindowsProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdin: options.input !== undefined ? "pipe" : options.inheritInput ? "inherit" : "ignore",
      output: options.inheritOutput ? "inherit" : "pipe",
      ...(options.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: options.windowsVerbatimArguments }),
      ...(options.stopDescendantsOnExit === undefined ? {} : { stopDescendantsOnExit: options.stopDescendantsOnExit }),
    });
  } catch (failure) {
    try {
      options.owner?.spawned(undefined, false);
    } catch (cleanup) {
      throw combineFailures(failure, cleanup, "Windows process preparation and ownership cleanup failed");
    }
    throw failure;
  }
  const child = running.child;
  let failure: Error | undefined;
  const reported = new Set<Error>();
  const fail = (error: Error) => {
    if (reported.has(error)) return;
    reported.add(error);
    failure = failure ? combineFailures(failure, error, "Windows command and cleanup failed") : error;
  };
  child.on("error", fail);
  child.stdin?.on("error", fail);
  let completed: (() => void) | undefined;
  let releaseInput: (() => Promise<void>) | undefined;
  const cancelling = options.shutdown !== "drain";
  const cancel = () => {
    running.cancel();
  };
  try {
    try {
      completed = options.owner?.spawned(child.pid, false, true);
      connectOutput(child, options);
      releaseInput = connectInput(child, options.input, fail, cancel);
      if (cancelling) {
        options.signal.addEventListener("abort", cancel, { once: true });
        if (options.signal.aborted) cancel();
      }
      await running.admit();
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Windows command setup failed", { cause: error }));
      child.stdout?.resume();
      child.stderr?.resume();
      cancel();
    }
    const outcome = await running.completion;
    if (outcome.error) fail(outcome.error);
    try {
      await releaseInput?.();
      releaseInput = undefined;
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Windows command input cleanup failed", { cause: error }));
    }
    if (!outcome.jobEmpty) {
      try {
        options.owner?.markUncertain();
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Cannot retain uncertain process ownership", { cause: error }));
      }
      fail(new Error(`Windows process termination is uncertain; preserving ${running.directory}`));
    } else {
      try {
        await running.dispose();
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Windows process scratch cleanup failed", { cause: error }));
      }
      try {
        completed?.();
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Windows process ownership cleanup failed", { cause: error }));
      }
    }
    return {
      pid: outcome.pid,
      status: outcome.status,
      signal: null,
      ...(failure ? { error: failure } : {}),
      ...(!outcome.jobEmpty ? { descendantsActive: true } : {}),
    };
  } finally {
    await releaseInput?.();
    options.signal.removeEventListener("abort", cancel);
  }
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
  if (options.inheritOutput && options.output) throw new Error("Child output must be captured or inherited, not both");
  if (process.platform === "win32") return runWindowsOwnedChild(command, args, options);
  options.owner?.beforeSpawn();
  const cancelling = options.shutdown !== "drain";
  let child: OwnedChild;
  try {
    const settings = {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      // CREATE_NO_WINDOW would detach compiler workers from their private UTF-8 console.
      windowsHide: options.env.WORKBENCH_NATIVE_UTF8_CONSOLE !== "1",
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
    };
    const output = options.inheritOutput ? "inherit" : "pipe";
    child =
      options.input !== undefined
        ? spawn(command, args, { ...settings, stdio: ["pipe", output, output] })
        : spawn(command, args, { ...settings, stdio: [options.inheritInput ? "inherit" : "ignore", output, output] });
  } catch (error) {
    options.owner?.spawned(undefined, false);
    throw error;
  }
  let failure: Error | undefined;
  let descendantsActive = false;
  const stop = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
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
  let releaseInput: (() => Promise<void>) | undefined;
  try {
    completed = options.owner?.spawned(child.pid, true);
  } catch (error) {
    stop("SIGKILL");
    await closed;
    throw error;
  }
  try {
    try {
      connectOutput(child, options);
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Child output setup failed", { cause: error });
      child.stdout?.resume();
      child.stderr?.resume();
      stop("SIGKILL");
    }
    if (cancelling) {
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    }
    releaseInput = connectInput(
      child,
      options.input,
      (error) => {
        failure ??= error;
      },
      () => {
        stop("SIGKILL");
      },
    );
    const outcome = await closed;
    await releaseInput?.();
    releaseInput = undefined;
    if (cancelling && options.signal.aborted) stop("SIGKILL");
    if (child.pid !== undefined) {
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
      if (!descendantsActive) completed?.();
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
    await releaseInput?.();
    options.signal.removeEventListener("abort", abort);
    for (const timer of timers) clearTimeout(timer);
  }
}

/** Capture only small protocol/query output. Effectful verbose commands should retain streamed logs instead. */
export async function captureOwnedChild(
  command: string,
  args: string[],
  options: Omit<OwnedChildOptions, "output" | "inheritOutput">,
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
