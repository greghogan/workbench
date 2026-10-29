import { cacheDeletionIdentity } from "../cache-plan-identity.js";
import { totalBytes } from "../byte-size.js";
import { workerFailure } from "./error-response.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Worker, parentPort } from "node:worker_threads";
import { distributionRoot } from "../project-context.js";
import { InvalidInput, StateConflict } from "../input-errors.js";
import { applyProjectCachePlan, projectCachePlan, type ProjectCachePlan } from "../project-cache.js";
import { registerConsumingProject } from "../project-registration.js";
import { keepCacheAsset, withProjectRegistryWrite } from "../project-registry.js";
import { inspectToolCache, prunableTools, pruneToolCache } from "../tool-cache.js";
import { collectCacheInventory, type CacheInventory, type CacheProgress } from "./cache-inventory.js";
import { decodeCacheError, decodeCacheProgress, decodeCacheResult, decodeCacheTask } from "./cache-protocol.js";
import { WebError } from "./errors.js";

export type CacheTask =
  | { kind: "inventory"; force?: boolean; priority?: string }
  | { kind: "register"; path: string }
  | { kind: "project"; path: string; root?: string }
  | { kind: "apply"; plan: ProjectCachePlan; remove: boolean }
  | { kind: "assets"; digest?: string }
  | { kind: "keep"; identity: string; keep: boolean };
export function assetPlan() {
  const report = inspectToolCache();
  const entries = prunableTools(report);
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        entries.map((entry) => [
          entry.id,
          entry.identity,
          entry.directory,
          cacheDeletionIdentity(entry.directory),
          entry.protections,
          entry.pinnedBy,
        ]),
      ),
    )
    .digest("hex");
  return { entries, digest, bytes: totalBytes(entries.map((entry) => entry.bytes)), issues: report.issues };
}
export interface CacheResults {
  inventory: CacheInventory;
  register: { registered: true };
  project: ProjectCachePlan;
  apply: { applied: true };
  assets: ReturnType<typeof assetPlan>;
  keep: { applied: true };
}
export function cacheTask<T extends CacheTask>(
  task: T,
  progress?: (event: CacheProgress) => void,
  signal?: AbortSignal,
): Promise<CacheResults[T["kind"]]>;
export async function cacheTask(
  task: CacheTask,
  progress?: (event: CacheProgress) => void,
  signal?: AbortSignal,
): Promise<CacheResults[keyof CacheResults]> {
  switch (task.kind) {
    case "inventory":
      return collectCacheInventory(progress, task.force, task.priority, signal);
    case "register":
      if (!task.path.trim()) throw new InvalidInput("Choose a Workbench project directory");
      await withProjectRegistryWrite(() => {
        registerConsumingProject(task.path);
      }, signal);
      return { registered: true };
    case "project":
      return projectCachePlan(task.path, task.root, signal);
    case "apply":
      await applyProjectCachePlan(task.plan, task.remove);
      return { applied: true };
    case "assets": {
      const plan = assetPlan();
      if (task.digest !== undefined) {
        if (task.digest !== plan.digest || plan.issues.length)
          throw new StateConflict("Unused assets changed or need inspection; prepare a fresh plan");
        const report = inspectToolCache();
        await pruneToolCache(
          {
            ...report,
            entries: report.entries.filter((entry) => plan.entries.some((selected) => selected.id === entry.id)),
          },
          undefined,
          true,
        );
      }
      return plan;
    }
    case "keep":
      await withProjectRegistryWrite(() => {
        keepCacheAsset(task.identity, task.keep);
      }, signal);
      return { applied: true };
  }
}
export function serveCacheWorker(input: unknown): void {
  const cancellation = new AbortController();
  const cancel = (message: unknown) => {
    if (message && typeof message === "object" && "cancel" in message && message.cancel === true) cancellation.abort();
  };
  parentPort?.on("message", cancel);
  const post = (value: unknown) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
      throw new Error("Cache worker message exceeds the browser limit; use the cache CLI");
    parentPort?.postMessage(value);
  };
  void Promise.resolve()
    .then(() =>
      cacheTask(
        decodeCacheTask(input),
        (value) => {
          post({ progress: value });
        },
        cancellation.signal,
      ),
    )
    .then((value) => {
      if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
        throw new Error("Cache inventory exceeds the browser limit; use the cache CLI");
      post({ value });
    })
    .catch((error: unknown) => {
      post(workerFailure(error));
    })
    .finally(() => {
      parentPort?.off("message", cancel);
      parentPort?.close();
    });
}
/** Scans have no elapsed deadline; shutdown cancels reads and drains admitted mutations. */
export class CacheTasks {
  private readonly running = new Set<Promise<unknown>>();
  private readonly inspections = new Set<Worker>();
  private readonly mutations = new Set<Worker>();
  private closed = false;
  private stopping = false;
  constructor(
    distribution: string,
    private readonly createWorker: (task: CacheTask) => Worker = (task) =>
      new Worker(bundle ?? join(distributionRoot(distribution), "bundle/main.cjs"), {
        workerData: { workbenchCache: task },
      }),
    bundle?: string,
  ) {}
  run<T extends CacheTask>(
    task: T,
    progress?: (event: CacheProgress) => void,
    signal?: AbortSignal,
  ): Promise<CacheResults[T["kind"]]> {
    const readOnly =
      task.kind === "inventory" || task.kind === "project" || (task.kind === "assets" && task.digest === undefined);
    if (this.closed || (this.stopping && readOnly) || this.running.size >= 2)
      return Promise.reject(new WebError(503, "Cache maintenance is busy; retry when the current operation completes"));
    const operation = new Promise<CacheResults[T["kind"]]>((resolve, reject) => {
      const worker = this.createWorker(task);
      if (readOnly) this.inspections.add(worker);
      else this.mutations.add(worker);
      if (this.stopping && !readOnly) worker.postMessage({ cancel: true });
      let message: CacheResults[T["kind"]] | undefined;
      let failure: Error | undefined;
      const cancel = () => {
        if (readOnly) {
          failure = new WebError(503, "Cache inspection superseded or cancelled");
          failure.name = "AbortError";
        }
        worker.postMessage({ cancel: true });
      };
      worker.on("message", (input: unknown) => {
        try {
          if (!input || typeof input !== "object") throw new Error("Invalid cache worker message");
          if ("progress" in input) {
            if (task.kind !== "inventory") throw new Error("Unexpected cache worker progress");
            const event = decodeCacheProgress(input.progress);
            if (!signal?.aborted && !this.stopping) progress?.(event);
          } else if ("error" in input) failure = decodeCacheError(input);
          else if ("value" in input && message === undefined)
            message = decodeCacheResult<T["kind"]>(task.kind, input.value);
          else throw new Error("Invalid or repeated cache worker result");
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          worker.postMessage({ cancel: true });
        }
      });
      worker.once("error", (error: Error) => {
        failure = error;
      });
      worker.once("exit", (code) => {
        signal?.removeEventListener("abort", cancel);
        this.inspections.delete(worker);
        this.mutations.delete(worker);
        if (readOnly && (signal?.aborted || this.stopping)) {
          const aborted = new WebError(503, "Cache inspection cancelled");
          aborted.name = "AbortError";
          reject(aborted);
        } else if (failure) reject(failure);
        else if (this.stopping && readOnly && !message) {
          const cancelled = new WebError(503, "Cache inspection cancelled while the service is stopping");
          cancelled.name = "AbortError";
          reject(cancelled);
        } else if (code !== 0 || !message) reject(new Error(`Cache worker stopped without a result (${String(code)})`));
        else resolve(message);
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    this.running.add(operation);
    void operation.finally(() => this.running.delete(operation)).catch(() => undefined);
    return operation;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cancelPending();
    await Promise.allSettled([...this.running]);
  }
  cancelPending(): void {
    this.stopping = true;
    for (const worker of [...this.mutations, ...this.inspections]) worker.postMessage({ cancel: true });
  }
}
