import { isRecord, errorFrom } from "./values.mjs";
export interface ManagedRunOptions {
  capture?: boolean;
  cleanup?: boolean;
  missing?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
}
export interface ManagedProcessScope {
  defer(cleanup: () => unknown): void;
  run(
    command: string,
    args: readonly string[],
    options: ManagedRunOptions & { missing: true },
  ): Promise<string | undefined>;
  run(command: string, args: readonly string[], options?: ManagedRunOptions & { missing?: false }): Promise<string>;
}
import { spawn } from "node:child_process";

/** Preparation owns children until exit and attempts every registered cleanup, including after cancellation. */
export async function withManagedProcesses<T>(action: (scope: ManagedProcessScope) => T | Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cleanups: (() => unknown)[] = [];
  const interrupt = () => {
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const scope = {
    defer: (cleanup: () => unknown) => cleanups.push(cleanup),
    async run(
      command: string,
      args: readonly string[],
      { capture = false, cleanup = false, missing = false, cwd, env, limit = 16 * 1024 * 1024 }: ManagedRunOptions = {},
    ) {
      if (!cleanup) controller.signal.throwIfAborted();
      return await new Promise<string | undefined>((resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          env,
          detached: process.platform !== "win32",
          stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
        });
        const chunks: Buffer[] = [];
        let size = 0,
          failure: Error | undefined,
          escalation: NodeJS.Timeout | undefined;
        const stop = (signal: NodeJS.Signals) => {
          if (!child.pid) return;
          try {
            if (process.platform === "win32") child.kill(signal);
            else process.kill(-child.pid, signal);
          } catch (error) {
            if (!isRecord(error) || error.code !== "ESRCH") failure ??= errorFrom(error);
          }
        };
        const abort = () => {
          failure ??= new Error("Managed preparation cancelled");
          stop("SIGTERM");
          escalation ??= setTimeout(() => {
            stop("SIGKILL");
          }, 2000);
        };
        child.stdout?.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= limit) chunks.push(chunk);
          else {
            failure ??= new Error(`${command}: captured output exceeds ${String(limit)} bytes`);
            abort();
          }
        });
        child.once("error", (error) => {
          failure ??= errorFrom(error);
        });
        child.once("close", (code, signal) => {
          controller.signal.removeEventListener("abort", abort);
          if (escalation) clearTimeout(escalation);
          if (missing && isRecord(failure) && failure.code === "ENOENT") resolve(undefined);
          else if (failure) reject(failure);
          else if (code !== 0) reject(new Error(`${command} failed: ${String(code ?? signal)}`));
          else resolve(Buffer.concat(chunks).toString("utf8").trim());
        });
        if (!cleanup) {
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
        }
      });
    },
  };
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    // Missing executables produce undefined only when the caller explicitly permits them.
    result = await action(scope as ManagedProcessScope);
  } catch (error) {
    failures.push(error);
  }
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, failures.map((error) => String(error)).join("; "));
  // A completed action may itself return undefined; a failed action was thrown above.
  return result as T;
}
