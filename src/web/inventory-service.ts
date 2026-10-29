import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../diagnostics.js";
import { applyInventorySize, emptyInventory, type CacheInventory, type CacheProgress } from "./cache-inventory.js";
import { CacheTasks } from "./cache-worker.js";
const automaticRefreshMilliseconds = 15 * 60 * 1000;
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
  private closed = false;
  private readonly listeners = new Set<(event?: CacheProgress) => void>();
  constructor(private readonly tasks: () => CacheTasks) {}
  get collectedAt(): string | undefined {
    return this.at ? new Date(this.at).toISOString() : undefined;
  }
  get refreshing(): boolean {
    return this.scan !== undefined;
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
    this.scan?.cancellation.abort();
    this.notify();
  }
  view(): InventoryView {
    return { ...this.value, complete: this.complete, refreshing: this.refreshing, problem: this.problem };
  }
  async read(fresh = false, forceSizes = false, priority?: string): Promise<InventoryView> {
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
      (fresh || (!this.problem && (this.dirty || Date.now() - this.at >= automaticRefreshMilliseconds)))
    ) {
      const epoch = this.epoch;
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
            // The new discovery carries persisted measurements, including stale values.
            this.value = event.value;
            this.complete = true;
            discovered();
          } else applyInventorySize(this.value, event.size);
          this.notify(event);
        },
        cancellation.signal,
      );
      const scan = { epoch, forced: forceSizes, operation, metadata, cancellation };
      this.scan = scan;
      void operation
        .then((value) => {
          discovered();
          if (epoch === this.epoch && !this.closed) {
            this.value = value;
            this.complete = true;
            this.at = Date.now();
            this.dirty = false;
            this.problem = "";
          }
        })
        .catch((error: unknown) => {
          unavailable(error);
          if (error instanceof Error && error.name === "AbortError") return;
          if (epoch === this.epoch && !this.closed)
            this.problem = error instanceof Error ? error.message : String(error);
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
  close(): void {
    this.closed = true;
    this.scan?.cancellation.abort();
    this.listeners.clear();
  }
}
