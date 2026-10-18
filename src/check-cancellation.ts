import { spawn, spawnSync } from "node:child_process";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import type { ProcessLock } from "./process-lock.js";

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
    if (message && typeof message === "object" && "type" in message && message.type === "workbench-check-cancel")
      this.interrupt();
  };
  constructor(private readonly subject = "Checks") {
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
  async waitForStart(): Promise<void> {
    if (!process.send) return;
    if (!process.connected) this.cancel();
    this.checkpoint();
    await new Promise<void>((resolve) => {
      const finish = () => {
        process.removeListener("message", message);
        this.signal.removeEventListener("abort", finish);
        resolve();
      };
      const message = (value: unknown) => {
        if (value && typeof value === "object" && "type" in value && value.type === "workbench-check-start") finish();
      };
      process.on("message", message);
      this.signal.addEventListener("abort", finish, { once: true });
      process.send?.({ type: "workbench-check-ready" }, (error) => {
        if (error) this.cancel();
      });
      if (this.cancelled) finish();
    });
    this.checkpoint();
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
  ): Promise<void> {
    this.checkpoint();
    const [command, ...args] = invocation;
    if (!command) throw new Error("Command requires an executable");
    owner?.beforeSpawn();
    return new Promise((resolve, reject) => {
      const foreground = inheritInput && process.stdin.isTTY;
      const child = spawn(command, args, {
        cwd: directory,
        env,
        detached: process.platform !== "win32" && !foreground,
        windowsHide: true,
        stdio: foreground ? "inherit" : [inheritInput ? "inherit" : "ignore", "pipe", "pipe"],
      });
      let failure: Error | undefined;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const foregroundPids = new Set<number>();
      const stop = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === "win32") {
            const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
            if (result.error) failure ??= result.error;
          } else if (foreground) {
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
      child.stdout?.pipe(process.stdout, { end: false });
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
            if (process.platform !== "win32" && child.pid !== undefined) {
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
          if (failure) throw failure;
          if (this.cancelled) throw new ChecksCancelled(this.subject);
          if (code !== 0) throw new Error(`${command} failed: ${String(code ?? signal)}`);
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
        owner?.spawned(child.pid, !foreground);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
        this.cancel();
      }
    });
  }
}
