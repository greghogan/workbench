import { decodeWorkerFailure } from "./error-response.js";
import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { distributionRoot } from "../project-context.js";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../diagnostics.js";
import { WorkspaceIndex } from "../workspace-service.js";
import { WebMetrics } from "./observability.js";
import { decodeWorkspaceSnapshot as readSnapshot } from "./workspace-codec.js";
import { WorkspaceRequest } from "./workspace-protocol.js";

/** Watch notifications are hints. A worker reconciles periodically; readers retain the last complete snapshot. */
export class WorkspaceMonitor extends EventEmitter {
  private readonly watchers = new Map<string, FSWatcher>();
  private worker: Worker | undefined;
  private generation = 0;
  private restartAttempts = 0;
  private restart: ReturnType<typeof setTimeout> | undefined;
  private workerStarted = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private settle: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private closed = false;
  private exited = false;
  private readonly degraded = new Set<string>();
  index: WorkspaceIndex | undefined;
  problem = "";
  constructor(
    private readonly root: string,
    interval = 3000,
    readonly metrics = new WebMetrics(),
    private readonly createWorker: (root: string) => Worker = (root) =>
      new Worker(bundle ?? join(distributionRoot(root), "bundle/main.cjs"), {
        workerData: { workbenchWorkspace: root },
      }),
    bundle?: string,
  ) {
    super();
    this.startWorker();
    this.timer = setInterval(() => {
      this.schedule(0);
    }, interval);
    this.timer.unref();
  }
  private startWorker(): void {
    if (this.closed) return;
    const generation = ++this.generation;
    this.workerStarted = performance.now();
    this.exited = false;
    let worker: Worker;
    try {
      worker = this.createWorker(this.root);
    } catch (error) {
      this.exited = true;
      this.problem = error instanceof Error ? error.message : String(error);
      this.recover();
      return;
    }
    this.worker = worker;
    worker.on("message", (response: unknown) => {
      if (generation !== this.generation) return;
      const pending = this.settle;
      this.settle = undefined;
      if (!pending) return;
      try {
        if (!response || typeof response !== "object" || !("ok" in response))
          throw new Error("invalid workspace worker response");
        if (response.ok !== true) {
          throw decodeWorkerFailure(response);
        }
        if (this.closed) {
          diagnostic(
            LogLevel.Debug,
            DiagnosticOperation.WorkspaceRefresh,
            DiagnosticOutcome.Discarded,
            {},
            undefined,
            "result discarded during shutdown",
          );
          pending.resolve();
          return;
        }
        if ("unchanged" in response) {
          const current = response.unchanged;
          if (
            !current ||
            typeof current !== "object" ||
            !("revision" in current) ||
            !("collectedAt" in current) ||
            typeof current.collectedAt !== "string" ||
            !Number.isFinite(Date.parse(current.collectedAt)) ||
            !this.index ||
            current.revision !== this.index.snapshot.revision
          )
            throw new Error("invalid unchanged workspace response");
          this.index.snapshot.collectedAt = current.collectedAt;
          this.problem = "";
          if (performance.now() - this.workerStarted >= 60_000) this.restartAttempts = 0;
          pending.resolve();
          return;
        }
        const snapshot = readSnapshot("snapshot" in response ? response.snapshot : undefined);
        if (snapshot.root !== this.root) throw new Error("workspace worker returned another project");
        const previous = this.revision;
        this.index = new WorkspaceIndex(snapshot, this.index);
        if (this.problem) diagnostic(LogLevel.Info, DiagnosticOperation.WorkspaceRefresh, DiagnosticOutcome.Recovered);
        this.problem = "";
        if (performance.now() - this.workerStarted >= 60_000) this.restartAttempts = 0;
        this.watchDirectories(snapshot.directories);
        if (this.revision !== previous) this.emit("change", this.revision);
        pending.resolve();
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    worker.on("error", (error) => {
      if (generation !== this.generation) return;
      diagnostic(LogLevel.Error, DiagnosticOperation.WorkspaceWorker, DiagnosticOutcome.Failed, {}, error);
      this.problem = error.message;
    });
    worker.on("exit", (code) => {
      if (generation !== this.generation) return;
      this.exited = true;
      this.worker = undefined;
      if (!this.closed) {
        this.problem = `Workspace worker exited (${String(code)})`;
        diagnostic(
          LogLevel.Error,
          DiagnosticOperation.WorkspaceWorker,
          DiagnosticOutcome.Stopped,
          { exitStatus: code },
          undefined,
          "exited",
        );
        this.emit("freshness");
      }
      if (this.settle) {
        this.settle.reject(new Error(`workspace worker exited before publication: ${String(code)}`));
        this.settle = undefined;
      }
      if (!this.closed) this.recover();
    });
  }
  private recover(): void {
    if (this.closed || this.restart) return;
    if (this.restartAttempts >= 3) {
      this.problem += "; automatic recovery exhausted; retry workspace refresh";
      this.emit("freshness");
      return;
    }
    const delay = 1000 * 2 ** this.restartAttempts++;
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.WorkspaceWorker,
      DiagnosticOutcome.Retrying,
      { attempt: this.restartAttempts, delayMs: delay },
      undefined,
      "restarting failed read-only worker",
    );
    this.restart = setTimeout(() => {
      this.restart = undefined;
      if (this.closed) return;
      this.startWorker();
      this.emit("restart");
      if (!this.exited) void this.reconcile().catch(() => undefined);
    }, delay);
    this.emit("freshness");
  }
  /** Initial acquisition may recover a failed worker; ordinary document errors remain visible. */
  async ready(): Promise<void> {
    while (!this.closed && !this.index) {
      try {
        await this.reconcile();
      } catch (error) {
        if (!this.restart) throw error;
        await new Promise<void>((resolve) => {
          this.once("restart", resolve);
        });
      }
    }
  }
  retry(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.exited) {
      clearTimeout(this.restart);
      this.restart = undefined;
      this.restartAttempts = 0;
      this.startWorker();
    }
    return this.reconcile(true);
  }
  get records() {
    return this.index ? [...this.index.byId.values()] : [];
  }
  get revision() {
    return this.index?.snapshot.revision ?? "";
  }
  get refreshing() {
    return this.pending !== undefined;
  }
  get watcherCount(): number {
    return this.watchers.size;
  }
  reconcile(fresh = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending)
      return fresh ? this.pending.catch(() => undefined).then(() => this.reconcile(true)) : this.pending;
    const started = performance.now();
    this.metrics.count("refreshes");
    this.pending = new Promise<void>((resolve, reject) => {
      if (this.exited) {
        reject(new Error(this.problem || "workspace worker is unavailable"));
        return;
      }
      this.settle = { resolve, reject };
      this.worker?.postMessage(fresh ? WorkspaceRequest.Fresh : WorkspaceRequest.Refresh);
    })
      .catch((error: unknown) => {
        this.metrics.count("refreshFailures");
        const message = error instanceof Error ? error.message : String(error);
        if (message !== this.problem)
          diagnostic(
            LogLevel.Warn,
            DiagnosticOperation.WorkspaceRefresh,
            DiagnosticOutcome.Failed,
            { hasSnapshot: this.index !== undefined },
            error,
            "failed; previous snapshot retained",
          );
        this.problem = message;
        throw error;
      })
      .finally(() => {
        const durationMs = performance.now() - started;
        this.metrics.duration("refresh", durationMs);
        diagnostic(
          LogLevel.Debug,
          DiagnosticOperation.WorkspaceRefresh,
          this.closed
            ? DiagnosticOutcome.Discarded
            : this.problem
              ? DiagnosticOutcome.Unavailable
              : DiagnosticOutcome.Completed,
          {
            durationMs,
            records: this.index?.byId.size ?? 0,
            watchers: this.watchers.size,
          },
        );
        this.pending = undefined;
        this.emit("freshness");
      });
    this.emit("freshness");
    return this.pending;
  }
  private watchDirectories(directories: string[]): void {
    if (this.closed) return;
    for (const directory of this.degraded) if (!directories.includes(directory)) this.degraded.delete(directory);
    for (const [directory, watcher] of this.watchers)
      if (!directories.includes(directory)) {
        watcher.close();
        this.watchers.delete(directory);
      }
    for (const directory of directories)
      if (!this.watchers.has(directory))
        try {
          const watcher = watch(directory, () => {
            this.schedule(120);
          });
          watcher.on("error", (error) => {
            this.watchFailure(directory, error);
            watcher.close();
            if (this.watchers.get(directory) === watcher) this.watchers.delete(directory);
          });
          this.watchers.set(directory, watcher);
          if (this.degraded.delete(directory)) {
            this.metrics.count("watchRecoveries");
            diagnostic(LogLevel.Info, DiagnosticOperation.WorkspaceWatch, DiagnosticOutcome.Recovered, { directory });
          }
        } catch (error) {
          this.watchFailure(directory, error);
        }
  }
  private watchFailure(directory: string, error: unknown): void {
    if (this.degraded.has(directory)) return;
    // One entry per snapshot directory; removed watches do not retain their errors forever.
    this.degraded.add(directory);
    this.metrics.count("watchFailures");
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.WorkspaceWatch,
      DiagnosticOutcome.Degraded,
      { directory },
      error,
      "periodic reconciliation fallback",
    );
  }
  private schedule(delay: number): void {
    if (this.closed || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.reconcile().catch(() => undefined);
    }, delay);
  }
  close(): Promise<void> {
    if (this.closed) return this.finished;
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.restart);
    this.restart = undefined;
    this.emit("restart");
    clearTimeout(this.debounce);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.finished = (async () => {
      await this.pending?.catch(() => undefined);
      if (!this.exited && this.worker) {
        const worker = this.worker;
        const exit = new Promise<void>((resolve) => {
          worker.once("exit", () => {
            resolve();
          });
        });
        worker.postMessage(WorkspaceRequest.Close);
        await exit;
      }
      this.removeAllListeners();
    })();
    return this.finished;
  }
  private finished = Promise.resolve();
}
