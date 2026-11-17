import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../../core/diagnostics/diagnostics.mjs";
import { applyInventorySize, emptyInventory, type CacheInventory, type CacheProgress } from "./cache-inventory.js";
import { CacheTasks } from "./cache-worker.js";
import { performance } from "node:perf_hooks";
import { WebMetrics } from "../http/observability.js";
import { InputWatch } from "../workspace/input-watch.js";
import { cacheGenerationMarker, cacheSizeMarker } from "../../core/storage/cache-generation.mjs";
import { dirname, join } from "node:path";
import { userDirectory } from "../../core/storage/storage.js";
import type { CacheSize } from "../../core/storage/cache-size.js";
const automaticRefreshMilliseconds = 15 * 60 * 1000;
const ownershipUnavailable = (value: CacheInventory) =>
  value.issues.some((issue) => issue.phase === "discovery" && ["registry", "builds"].includes(issue.component));
export interface InventoryView extends CacheInventory {
  complete: boolean;
  refreshing: boolean;
  problem: string;
}
/** One scan publishes metadata, then changed measurements; invalidation retains the last usable values. */
export class InventoryService {
  private value = emptyInventory();
  private complete = false;
  private at = 0;
  private dirty = true;
  private epoch = 0;
  private scan:
    | {
        epoch: number;
        forced: boolean;
        operation: Promise<CacheInventory>;
        metadata: Promise<void>;
        cancellation: AbortController;
      }
    | undefined;
  private problem = "";
  private failures = 0;
  private retryAt = 0;
  private closed = false;
  private reconciledAt = 0;
  private readonly measurements = new Set<string>();
  private readonly measuring = new Map<string, { generation: number; cancellation: AbortController }>();
  private readonly sizeGenerations = new Map<string, number>();
  private knownSizes = new Set<string>();
  private readonly watch = new InputWatch((paths) => {
    if (paths.includes(join(userDirectory("state"), "projects.json"))) {
      this.invalidate();
      return;
    }
    for (const path of paths) {
      const directory = dirname(path);
      if (!this.knownSizes.has(directory)) continue;
      if (path.endsWith(cacheSizeMarker) && this.measuring.has(directory)) continue;
      this.sizeGenerations.set(directory, (this.sizeGenerations.get(directory) ?? 0) + 1);
      this.measurements.add(directory);
    }
    this.measureChanged();
  });
  private readonly listeners = new Set<(event?: CacheProgress) => void>();
  constructor(
    private readonly tasks: () => CacheTasks,
    private readonly metrics = new WebMetrics(),
  ) {
    this.watch.update([join(userDirectory("state"), "projects.json")]);
  }
  get collectedAt(): string | undefined {
    return this.at ? new Date(this.at).toISOString() : undefined;
  }
  get refreshing(): boolean {
    return this.scan !== undefined || this.measuring.size > 0;
  }
  get watcherCount(): number {
    return this.watch.watcherCount;
  }
  onChange(listener: (event?: CacheProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(event?: CacheProgress): void {
    for (const listener of this.listeners) listener(event);
  }
  invalidate(): void {
    this.epoch++;
    this.dirty = true;
    this.problem = "";
    this.failures = 0;
    this.retryAt = 0;
    this.scan?.cancellation.abort();
    for (const value of this.measuring.values()) value.cancellation.abort();
    this.notify();
  }
  view(): InventoryView {
    return { ...this.value, complete: this.complete, refreshing: this.refreshing, problem: this.problem };
  }
  async read(fresh = false, forceSizes = false, priority?: string): Promise<InventoryView> {
    if (!this.closed && Date.now() - this.reconciledAt >= 15_000) {
      this.reconciledAt = Date.now();
      this.watch.reconcile();
    }
    if (forceSizes) fresh = true;
    if (forceSizes && this.scan && !this.scan.forced && this.scan.epoch === this.epoch) this.invalidate();
    if (fresh && this.scan && this.scan.epoch !== this.epoch) {
      await this.scan.operation.catch(() => undefined);
      await Promise.resolve();
      return this.read(fresh, forceSizes, priority);
    }
    if (
      !this.closed &&
      !this.scan &&
      (fresh || (Date.now() >= this.retryAt && (this.dirty || Date.now() - this.at >= automaticRefreshMilliseconds)))
    ) {
      const epoch = this.epoch;
      const started = performance.now();
      let metadataAt = started;
      if (this.failures) this.metrics.count("cacheInventoryRetries");
      const cancellation = new AbortController();
      let discovered!: () => void, unavailable!: (error: unknown) => void;
      const metadata = new Promise<void>((resolve, reject) => {
        discovered = resolve;
        unavailable = reject;
      });
      void metadata.catch(() => undefined);
      const operation = this.tasks().run(
        { kind: "inventory", force: forceSizes, ...(priority ? { priority } : {}) },
        (event) => {
          if (epoch !== this.epoch || this.closed) return;
          if (event.kind === "metadata") {
            metadataAt = performance.now();
            this.metrics.phase("cacheDiscovery", metadataAt - started);
            if (!event.value.pendingComponents?.length) discovered();
            if (this.complete && ownershipUnavailable(event.value)) return;
            // The new discovery carries persisted measurements, including stale values.
            this.value = event.value;
            this.complete = true;
            this.watchSizes();
            this.notify(event);
          } else this.publishSize(event.size);
        },
        cancellation.signal,
      );
      const scan = { epoch, forced: forceSizes, operation, metadata, cancellation };
      this.scan = scan;
      void operation
        .then((value) => {
          this.metrics.phase("cacheMeasurement", performance.now() - metadataAt);
          discovered();
          if (epoch === this.epoch && !this.closed) {
            const failed = value.issues.filter((issue) => issue.phase === "discovery");
            if (this.complete && ownershipUnavailable(value)) {
              const reported = new Set(this.value.issues.map((issue) => issue.message));
              this.problem = failed
                .filter((issue) => !reported.has(issue.message))
                .map((issue) => issue.message)
                .join("; ");
              this.dirty = true;
              this.retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6));
              return;
            }
            this.value = value;
            this.complete = true;
            this.at = Date.now();
            this.dirty = false;
            this.problem = "";
            this.failures = 0;
            this.retryAt = 0;
            this.watchSizes();
          }
        })
        .catch((error: unknown) => {
          unavailable(error);
          if (error instanceof Error && error.name === "AbortError") return;
          if (epoch === this.epoch && !this.closed) {
            this.problem = error instanceof Error ? error.message : String(error);
            this.dirty = true;
            this.retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6));
          }
          diagnostic(
            LogLevel.Warn,
            DiagnosticOperation.WebRequest,
            DiagnosticOutcome.Failed,
            { operation: "cache inventory", phase: "worker" },
            error,
          );
        })
        .finally(() => {
          if (this.scan === scan) this.scan = undefined;
          this.measureChanged();
          if (!this.closed) this.notify();
        });
    }
    if (fresh && this.scan) {
      const scan = this.scan,
        epoch = this.epoch;
      try {
        await scan.metadata;
      } catch (error) {
        if (epoch === this.epoch || this.closed) throw error;
      }
      if (epoch !== this.epoch && !this.closed) {
        await scan.operation.catch(() => undefined);
        await Promise.resolve();
        return this.read(true, forceSizes, priority);
      }
    }
    return this.view();
  }
  private watchSizes(): void {
    this.watch.update([
      join(userDirectory("state"), "projects.json"),
      ...this.value.sizes.flatMap((size) => [
        join(size.directory, cacheGenerationMarker),
        join(size.directory, cacheSizeMarker),
      ]),
    ]);
    const directories = new Set(this.value.sizes.map((size) => size.directory));
    this.knownSizes = directories;
    // A queued change can be newer than a ready measurement from the inventory worker.
    for (const directory of this.sizeGenerations.keys())
      if (!directories.has(directory)) this.sizeGenerations.delete(directory);
    for (const directory of this.measurements) if (!directories.has(directory)) this.measurements.delete(directory);
  }
  private measureChanged(): void {
    if (this.closed || this.scan || this.measuring.size) return;
    const directory = this.measurements.values().next().value;
    if (directory === undefined) return;
    this.measurements.delete(directory);
    const generation = this.sizeGenerations.get(directory) ?? 0,
      epoch = this.epoch;
    const cancellation = new AbortController();
    this.measuring.set(directory, { generation, cancellation });
    void this.tasks()
      .run({ kind: "measure", directory }, undefined, cancellation.signal)
      .then(({ size }) => {
        if (this.closed || epoch !== this.epoch || generation !== (this.sizeGenerations.get(directory) ?? 0)) return;
        this.publishSize(size);
      })
      .catch((error: unknown) => {
        if (!this.closed && !cancellation.signal.aborted) {
          this.dirty = true;
          this.retryAt = Date.now() + 1000;
          diagnostic(
            LogLevel.Warn,
            DiagnosticOperation.WorkspaceRefresh,
            DiagnosticOutcome.Failed,
            { operation: "cache size refresh", directory },
            error,
          );
        }
      })
      .finally(() => {
        this.measuring.delete(directory);
        this.measureChanged();
        if (!this.closed && !this.refreshing) this.notify();
      });
  }
  private publishSize(size: CacheSize): void {
    const measurement = applyInventorySize(this.value, size);
    if (measurement) this.notify({ kind: "size", size: measurement });
  }
  close(): void {
    this.closed = true;
    this.scan?.cancellation.abort();
    this.watch.close();
    for (const value of this.measuring.values()) value.cancellation.abort();
    this.measurements.clear();
    this.listeners.clear();
  }
}
