import { open, mkdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { LogScope, LogRunState, diagnosticLogFile } from "../../diagnostics/diagnostics.mjs";
import { DiagnosticIssues } from "../../diagnostics/diagnostic-issues.js";
import { finishLogRun, type LogRetention } from "./log-storage.js";
import { marker, publish, readRun, startLogRun } from "./log-run.js";
import { withCacheLock } from "../cache-lock.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { terminalLogFile, type TerminalChannel } from "./terminal-log.js";

const sealing = new AsyncLocalStorage<boolean>();

export interface DiagnosticLogOptions {
  scope: typeof LogScope.Cli | typeof LogScope.Server;
  retention: LogRetention;
  rotateBytes: number;
  rotateMilliseconds: number;
  onSealed?: () => void;
}
/** One closed segment finalizes in the background; another rotation waits rather than growing a work queue. */
export class DiagnosticLog extends Writable {
  readonly ready: Promise<void>;
  private readonly collected = new DiagnosticIssues();
  private readonly files = new Map<string, FileHandle>();
  private segment = "";
  private sequence = 0;
  private bytes = 0;
  private opened = 0;
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> = Promise.resolve();
  private finalizing: Promise<void> = Promise.resolve();
  private finalizationFailure: Error | undefined;
  constructor(
    readonly directory: string,
    private readonly options: DiagnosticLogOptions,
  ) {
    super();
    this.ready = this.initialize();
    this.on("error", () => undefined);
  }
  get issues() {
    return this.collected.snapshot();
  }
  recordIssue(error: unknown): void {
    this.collected.add(error);
  }
  private get isServer(): boolean {
    return this.options.scope === LogScope.Server;
  }
  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    startLogRun(this.directory, { scope: this.options.scope, ...(this.isServer ? { segmented: true } : {}) });
    await this.openSegment();
  }
  private async openSegment(): Promise<void> {
    this.segment = this.isServer
      ? join(this.directory, `session-${String(this.sequence++).padStart(12, "0")}`)
      : this.directory;
    if (this.isServer) {
      await mkdir(this.segment, { mode: 0o700 });
      startLogRun(this.segment, { scope: LogScope.Server });
    }
    this.files.set(diagnosticLogFile, await open(join(this.segment, diagnosticLogFile), "wx", 0o600));
    this.opened = performance.now();
    this.bytes = 0;
  }
  private async closeSegment(): Promise<string> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.closeFiles();
    return this.segment;
  }
  private async closeFiles(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.files.values()].map((file) => file.close()));
    this.files.clear();
    const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as unknown] : []));
    if (failures.length) throw new AggregateError(failures, "Could not close diagnostic files");
  }
  private finalize(segment: string): Promise<void> {
    // Seal-related terminal warnings can be retained without triggering a new seal themselves.
    return sealing.run(true, () => this.seal(segment));
  }
  private async seal(segment: string): Promise<void> {
    const result = await withCacheLock(segment, () =>
      finishLogRun(segment, this.options.retention, this.isServer ? [] : this.issues, false),
    );
    if (!this.isServer) this.collected.clear();
    for (const error of result.errors) this.collected.add(error);
    if (!result.completed)
      throw new AggregateError(result.errors, "Diagnostic log completion failed; source preserved");
    this.options.onSealed?.();
  }
  private async rotate(): Promise<void> {
    const previous = await this.closeSegment();
    await this.finalizing;
    if (this.finalizationFailure) throw this.finalizationFailure;
    if (this.destroyed) return;
    await this.openSegment();
    this.finalizing = this.finalize(previous).catch((error: unknown) => {
      this.finalizationFailure =
        error instanceof Error ? error : new Error("Diagnostic finalization failed", { cause: error });
      this.collected.add(error);
      this.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  }
  private scheduleRotation(): void {
    if (
      this.timer ||
      !this.isServer ||
      !this.bytes ||
      !this.options.rotateMilliseconds ||
      this.destroyed ||
      this.writableEnded
    )
      return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (!this.destroyed && !this.writableEnded) this.write(Buffer.alloc(0));
      },
      Math.min(2147483647, Math.max(1, this.options.rotateMilliseconds - (performance.now() - this.opened))),
    );
    this.timer.unref();
  }
  private maintenanceEvent(chunk: Buffer): boolean {
    if (!chunk.length) return false;
    const event: unknown = JSON.parse(chunk.toString("utf8"));
    return Boolean(
      event &&
      typeof event === "object" &&
      "operation" in event &&
      typeof event.operation === "string" &&
      (event.operation.startsWith("logs.") || event.operation === "diagnostics.persist"),
    );
  }
  encodeTerminal(channel: TerminalChannel, text: string): string {
    // This prefix only crosses the in-memory Writable queue, never the file boundary.
    return `${sealing.getStore() ? "!" : ""}${channel}\n${text}`;
  }
  private async append(chunk: Buffer): Promise<void> {
    await this.ready;
    let name = diagnosticLogFile;
    let maintenance = false;
    if (chunk.length && chunk[0] !== 0x7b) {
      const boundary = chunk.indexOf(10),
        header = chunk.subarray(0, boundary).toString();
      maintenance = header.startsWith("!");
      const channel = maintenance ? header.slice(1) : header;
      if (boundary < 0 || !this.isServer || (channel !== "stdout" && channel !== "stderr"))
        throw new Error("Invalid diagnostic log write");
      name = terminalLogFile(channel);
      chunk = chunk.subarray(boundary + 1);
    }
    const due =
      this.options.rotateMilliseconds > 0 && performance.now() - this.opened >= this.options.rotateMilliseconds;
    const full = this.options.rotateBytes > 0 && this.bytes + chunk.length > this.options.rotateBytes;
    if (
      this.isServer &&
      this.bytes &&
      (due || full) &&
      !maintenance &&
      (name !== diagnosticLogFile || !this.maintenanceEvent(chunk))
    )
      await this.rotate();
    if (this.destroyed) return;
    if (chunk.length) {
      let file = this.files.get(name);
      if (!file) {
        file = await open(join(this.segment, name), "wx", 0o600);
        this.files.set(name, file);
      }
      await file.writeFile(chunk);
      this.bytes += chunk.length;
    }
    this.scheduleRotation();
  }
  private complete(operation: Promise<void>, callback: (error?: Error | null) => void): void {
    this.pending = operation;
    void operation.then(
      () => {
        callback();
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.complete(this.append(chunk), callback);
  }
  override _final(callback: (error?: Error | null) => void): void {
    clearTimeout(this.timer);
    this.complete(
      (async () => {
        await this.ready;
        const segment = await this.closeSegment();
        await this.finalizing;
        if (this.finalizationFailure) throw this.finalizationFailure;
        await this.finalize(segment);
        if (this.isServer)
          publish(join(this.directory, marker), {
            ...readRun(this.directory),
            state: LogRunState.Completed,
            completed: new Date().toISOString(),
            files: [],
            errors: this.issues,
          });
      })(),
      callback,
    );
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.timer);
    void this.ready
      .catch(() => undefined)
      .then(async () => {
        await this.pending.catch(() => undefined);
        await this.finalizing;
        await this.closeFiles();
      })
      .then(
        () => {
          callback(error);
        },
        (failure: unknown) => {
          callback(new AggregateError([error, failure].filter(Boolean), "Diagnostic file cleanup failed"));
        },
      );
  }
}
