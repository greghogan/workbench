import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { userConfigValues } from "../../configuration/user-config.js";
import {
  diagnostic,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  LogScope,
} from "../../diagnostics/diagnostics.mjs";
import { diagnosticRetention } from "./log-storage.js";
import { maintainLogRuns } from "./log-retention.js";

/** One session owns policy, sweep admission, timer scheduling, and shutdown. */
export class LogMaintenance {
  readonly policies;
  readonly rotation;
  private readonly interval: number;
  private pending: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  constructor(
    private readonly directory: string,
    private readonly scope: typeof LogScope.Cli | typeof LogScope.Server,
    user = userConfigValues(),
  ) {
    this.policies = {
      cli: diagnosticRetention(LogScope.Cli, user),
      server: diagnosticRetention(LogScope.Server, user),
    };
    this.rotation = {
      rotateBytes: user["logs.server_rotate_bytes"] as number,
      rotateMilliseconds: (user["logs.server_rotate_hours"] as number) * 3600000,
    };
    this.interval = (user["logs.prune_interval_seconds"] as number) * 1000;
  }
  request(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      for (const scope of this.scope === LogScope.Server
        ? ([LogScope.Cli, LogScope.Server] as const)
        : ([LogScope.Cli] as const)) {
        const directory = join(this.directory, scope);
        try {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          await maintainLogRuns(directory, this.policies[scope], this.interval, {
            layout: scope === LogScope.Server ? "segments" : "runs",
          });
        } catch (error) {
          diagnostic(
            LogLevel.Warn,
            DiagnosticOperation.LogRetention,
            DiagnosticOutcome.Preserved,
            { directory },
            error,
            "log retention failed; existing evidence preserved",
          );
        }
      }
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  start(): void {
    void this.request().then(() => {
      this.schedule();
    });
  }
  private schedule(): void {
    if (this.stopped || this.scope !== LogScope.Server || !this.interval) return;
    this.timer = setTimeout(
      () => {
        void this.request().then(() => {
          this.schedule();
        });
      },
      Math.min(this.interval, 2147483647),
    );
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }
}
