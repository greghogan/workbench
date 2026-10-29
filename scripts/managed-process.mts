import { isRecord } from "./values.mjs";
import { runOwnedChild } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
export interface ManagedRunOptions {
  capture?: boolean;
  cleanup?: boolean;
  missing?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
}
export interface ManagedProcessScope {
  defer(cleanup: () => unknown, kind?: "release" | "shutdown"): void;
  run(
    command: string,
    args: readonly string[],
    options: ManagedRunOptions & { missing: true },
  ): Promise<string | undefined>;
  run(command: string, args: readonly string[], options?: ManagedRunOptions & { missing?: false }): Promise<string>;
}

/** Preparation owns children until exit and attempts every registered cleanup, including after cancellation. */
export async function withManagedProcesses<T>(action: (scope: ManagedProcessScope) => T | Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cleanups: { action: () => unknown; kind: "release" | "shutdown" }[] = [];
  const ownership = { uncertain: false };
  const interrupt = () => {
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const scope = {
    defer: (action: () => unknown, kind: "release" | "shutdown" = "release") => cleanups.push({ action, kind }),
    async run(
      command: string,
      args: readonly string[],
      { capture = false, cleanup = false, missing = false, cwd, env, limit = 16 * 1024 * 1024 }: ManagedRunOptions = {},
    ) {
      if (!cleanup) controller.signal.throwIfAborted();
      const captureController = new AbortController();
      const signal = cleanup
        ? captureController.signal
        : AbortSignal.any([controller.signal, captureController.signal]);
      const chunks: Buffer[] = [];
      let size = 0,
        failure: Error | undefined;
      const outcome = await runOwnedChild(command, [...args], {
        cwd: cwd ?? process.cwd(),
        env: env ?? process.env,
        signal,
        inheritInput: !capture,
        stopDescendantsOnExit: true,
        ...(capture
          ? {
              output: (stdout, stderr) => {
                stderr.pipe(process.stderr, { end: false });
                stdout.on("data", (chunk: Buffer) => {
                  size += chunk.length;
                  if (size <= limit) chunks.push(chunk);
                  else {
                    failure ??= new Error(`${command}: captured output exceeds ${String(limit)} bytes`);
                    captureController.abort(failure);
                  }
                });
              },
            }
          : { inheritOutput: true }),
      }).catch((error: unknown) => {
        if (missing && isRecord(error) && error.code === "ENOENT") return undefined;
        ownership.uncertain ||= !(isRecord(error) && error.code === "ENOENT");
        throw error;
      });
      if (outcome === undefined) return undefined;
      ownership.uncertain ||= outcome.descendantsActive === true;
      if (missing && isRecord(outcome.error) && outcome.error.code === "ENOENT") return undefined;
      if (!cleanup && controller.signal.aborted) failure ??= new Error("Managed preparation cancelled");
      const problem = processFailure(
        command,
        { ...outcome, ...(failure ? { error: failure } : {}) },
        {
          stdout: Buffer.concat(chunks),
        },
      );
      if (problem) throw problem;
      return Buffer.concat(chunks).toString("utf8").trim();
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
  if (ownership.uncertain) failures.push(new Error("Child termination is uncertain; preserving preparation resources"));
  for (const cleanup of cleanups.reverse()) {
    if (ownership.uncertain && cleanup.kind === "release") continue;
    try {
      await cleanup.action();
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
