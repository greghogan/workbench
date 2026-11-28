import { CheckMessage, readCheckMessage, readCheckAdmission } from "./check-protocol.js";
import type { CheckIsolationGroup } from "./check-isolation.js";
import { spawn, spawnSync } from "node:child_process";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import type { ProcessLock } from "../../storage/process-lock.js";
import { processFailure } from "../../runtime/process-outcome.mjs";
import { runOwnedChild } from "../../runtime/owned-child.mjs";

export class ChecksCancelled extends Error {
  constructor(subject = "Checks") {
    super(`${subject} cancelled; active commands stopped and cleanup completed`);
  }
}

/** Commands own cancellation through shutdown; callers retain their locks until cleanup finishes. */
export class CheckCancellation {
  private readonly controller = new AbortController();
  private readonly interrupt = () => {
    this.cancel();
  };
  private readonly message = (message: unknown) => {
    if (readCheckMessage(message)?.type === CheckMessage.Cancel) this.interrupt();
  };
  constructor(
    private readonly subject = "Checks",
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {
    process.on("SIGINT", this.interrupt);
    process.on("SIGTERM", this.interrupt);
    process.on("message", this.message);
    process.on("disconnect", this.interrupt);
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }
  cancel(): void {
    this.controller.abort();
  }
  checkpoint(): void {
    if (this.cancelled) throw new ChecksCancelled(this.subject);
  }
  async ready(): Promise<boolean> {
    await nextTurn();
    return !this.cancelled;
  }
  /** A worker cannot launch commands until the coordinator has recorded its ownership. */
  async waitForStart(expected: string | undefined): Promise<CheckIsolationGroup[] | undefined> {
    if (!process.send) {
      if (expected) throw new Error("Check worker isolation requires coordinator admission");
      return;
    }
    if (!process.connected) this.cancel();
    this.checkpoint();
    const groups = await new Promise<CheckIsolationGroup[] | undefined>((resolve, reject) => {
      const cleanup = () => {
        process.removeListener("message", message);
        this.signal.removeEventListener("abort", aborted);
      };
      const finish = (groups?: CheckIsolationGroup[]) => {
        cleanup();
        resolve(groups);
      };
      const aborted = () => {
        finish();
      };
      const message = (value: unknown) => {
        try {
          const admission = readCheckAdmission(value, expected);
          if (admission) finish(admission);
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error("Check admission failed", { cause: error }));
        }
      };
      process.on("message", message);
      this.signal.addEventListener("abort", aborted, { once: true });
      process.send?.({ type: CheckMessage.Ready }, (error) => {
        if (error) this.cancel();
      });
      if (this.cancelled) finish();
    });
    this.checkpoint();
    return groups;
  }
  close(): void {
    process.removeListener("SIGINT", this.interrupt);
    process.removeListener("SIGTERM", this.interrupt);
    process.removeListener("message", this.message);
    process.removeListener("disconnect", this.interrupt);
  }

  async execute(
    invocation: string[],
    directory: string,
    env: NodeJS.ProcessEnv,
    inheritInput = false,
    owner?: ProcessLock,
    forwardExitStatus?: (status: number) => void,
  ): Promise<void> {
    this.checkpoint();
    const [command, ...args] = invocation;
    if (!command) throw new Error("Command requires an executable");
    const redirected = this.output !== process.stdout;
    if (process.platform === "win32") {
      const outcome = await runOwnedChild(command, args, {
        cwd: directory,
        env,
        signal: this.signal,
        inheritInput,
        inheritOutput: inheritInput && !redirected,
        ...(redirected
          ? {
              output: (stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream) => {
                stdout.pipe(this.output, { end: false });
                stderr.pipe(process.stderr, { end: false });
              },
            }
          : {}),
        stopDescendantsOnExit: true,
        ...(owner ? { owner } : {}),
      });
      if (outcome.error) throw outcome.error;
      this.checkpoint();
      if (outcome.status !== null && outcome.signal === null && forwardExitStatus) {
        forwardExitStatus(outcome.status);
        return;
      }
      const failure = processFailure(command, outcome);
      if (failure) throw failure;
      return;
    }
    owner?.beforeSpawn();
    return new Promise((resolve, reject) => {
      const foreground = inheritInput && process.stdin.isTTY;
      const child = spawn(command, args, {
        cwd: directory,
        env,
        detached: !foreground,
        windowsHide: true,
        // A redirected stdin does not make stdout/stderr noninteractive.
        stdio: inheritInput ? ["inherit", this.output, process.stderr] : ["ignore", "pipe", "pipe"],
      });
      let failure: Error | undefined;
      let completed: (() => void) | undefined;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const foregroundPids = new Set<number>();
      const stop = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          if (foreground) {
            // Foreground terminal readers share our process group; never signal that entire group.
            const listing = spawnSync("ps", ["-e", "-o", "pid=,ppid="], { encoding: "utf8" });
            if (listing.error || listing.status !== 0) throw new Error("Cannot inspect the foreground command tree");
            foregroundPids.add(child.pid);
            const rows = listing.stdout
              .trim()
              .split("\n")
              .map((line) => line.trim().split(/\s+/).map(Number));
            for (const ancestor of foregroundPids)
              for (const [pid, parent] of rows) if (pid && parent === ancestor) foregroundPids.add(pid);
            // Keep discovered children through parent exit so final cleanup also reaches them.
            for (const pid of [...foregroundPids].reverse()) {
              try {
                process.kill(pid, signal);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
              }
            }
          } else process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            failure ??= error instanceof Error ? error : new Error(String(error));
        }
      };
      const interrupt = () => {
        stop("SIGINT");
        timers.push(
          setTimeout(() => {
            stop("SIGTERM");
          }, 5000),
        );
        timers.push(
          setTimeout(() => {
            stop("SIGKILL");
          }, 10000),
        );
      };
      child.stdout?.pipe(this.output, { end: false });
      child.stderr?.pipe(process.stderr, { end: false });
      child.once("error", (error) => {
        failure ??= error;
      });
      child.once("close", (code, signal) => {
        const finish = async () => {
          let terminated = false;
          const terminate = () => {
            if (this.cancelled && !terminated) {
              stop("SIGKILL");
              terminated = true;
            }
          };
          terminate();
          if (this.cancelled || owner) {
            if (child.pid !== undefined) {
              const pids = foreground ? [...foregroundPids] : [-child.pid];
              const deadline = Date.now() + 5000;
              for (const pid of pids) {
                for (;;) {
                  terminate();
                  try {
                    process.kill(pid, 0);
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
                    throw error;
                  }
                  if (Date.now() >= deadline) throw new Error(`Cannot confirm command shutdown: ${String(pid)}`);
                  await delay(10);
                }
              }
            }
          }
          completed?.();
          if (failure) throw failure;
          if (this.cancelled) throw new ChecksCancelled(this.subject);
          if (code !== null && signal === null && forwardExitStatus) {
            forwardExitStatus(code);
            return;
          }
          const problem = processFailure(command, { pid: child.pid ?? 0, status: code, signal });
          if (problem) throw problem;
        };
        void finish()
          .finally(() => {
            this.controller.signal.removeEventListener("abort", interrupt);
            for (const timer of timers) clearTimeout(timer);
          })
          .then(resolve, reject);
      });
      this.controller.signal.addEventListener("abort", interrupt, { once: true });
      if (this.cancelled) interrupt();
      try {
        completed = owner?.spawned(child.pid, !foreground);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
        this.cancel();
      }
    });
  }
}
