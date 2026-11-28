import { isAbsolute } from "node:path";
import { parentPort, Worker } from "node:worker_threads";
import type { RegisteredProject } from "../../core/projects/project-registry.js";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../../core/diagnostics/diagnostics.mjs";
import { validation, type Validation } from "../../core/runtime/validation.js";
import { decodeWorkerFailure, workerFailure } from "../http/error-response.js";
import { ReviewInventory } from "./review-inventory.js";
import { performance } from "node:perf_hooks";
import { WebMetrics } from "../http/observability.js";
import type { WorkspaceIndex } from "../workspace/workspace-service.js";

export interface ProjectReviewCount {
  count?: number;
  problem?: string;
  revision?: number;
}
type ProjectLocation = Pick<RegisteredProject, "id" | "path">;
const check: Validation = validation("Invalid project review summary");
function locations(input: unknown): ProjectLocation[] {
  check(Array.isArray(input), "projects", "must be an array");
  const ids = new Set<string>();
  return input.map((value: unknown) => {
    check(value && typeof value === "object", "project", "must be an object");
    check("id" in value && typeof value.id === "string" && /^[a-f0-9]{24}$/.test(value.id), "id", "is invalid");
    check("path" in value && typeof value.path === "string" && isAbsolute(value.path), "path", "must be absolute");
    check(!ids.has(value.id), "id", "must be unique");
    ids.add(value.id);
    return { id: value.id, path: value.path };
  });
}

interface ReviewJob extends ProjectLocation {
  generation: number;
}
interface Summary extends ProjectReviewCount {
  path: string;
  generation: number;
  at: number;
  delegated: boolean;
  dirty: boolean;
}
function job(input: unknown): ReviewJob {
  const [project] = locations([input]);
  check(
    project &&
      input &&
      typeof input === "object" &&
      "generation" in input &&
      Number.isSafeInteger(input.generation) &&
      Number(input.generation) >= 0,
    "generation",
    "is invalid",
  );
  return { ...project, generation: Number(input.generation) };
}

export function serveProjectReviewWorker(): void {
  const port = parentPort;
  if (!port) throw new Error("Project review summaries require a worker port");
  const readers = new Map<string, { path: string; reader: ReviewInventory }>();
  let pending = Promise.resolve();
  port.on("message", (input: unknown) => {
    pending = pending.then(async () => {
      if (input && typeof input === "object" && "retain" in input) {
        check(
          Array.isArray(input.retain) && input.retain.every((id: unknown) => typeof id === "string"),
          "retain",
          "must list project IDs",
        );
        const ids = new Set(input.retain);
        for (const id of readers.keys()) if (!ids.has(id)) readers.delete(id);
        return;
      }
      const project = job(input);
      const started = performance.now();
      try {
        let saved = readers.get(project.id);
        if (saved?.path !== project.path) {
          saved = { path: project.path, reader: new ReviewInventory(project.path) };
          readers.delete(project.id);
          if (readers.size >= 4) {
            const oldest = readers.keys().next().value;
            if (oldest !== undefined) readers.delete(oldest);
          }
          readers.set(project.id, saved);
        }
        const result = await saved.reader.collect();
        port.postMessage({ ...project, count: result.count, durationMs: performance.now() - started });
      } catch (error) {
        port.postMessage({ ...project, ...workerFailure(error) });
      }
    });
    void pending.catch((error: unknown) => {
      port.postMessage(workerFailure(error));
      port.close();
    });
  });
}

/** A bounded processing queue lets independent projects finish and keeps only complete counts. */
export class ProjectReviews {
  private readonly workers = new Map<Worker, ReviewJob | undefined>();
  private readonly values = new Map<string, Summary>();
  private projects: ProjectLocation[] = [];
  private closed = false;
  private sequence = 0;
  constructor(
    private readonly bundle: string,
    private readonly changed: (id: string, value: ProjectReviewCount) => void,
    private readonly createWorker: () => Worker = () =>
      new Worker(this.bundle, { workerData: { workbenchProjectReviews: true } }),
    private readonly metrics = new WebMetrics(),
  ) {}
  read(projects: readonly ProjectLocation[]): ReadonlyMap<string, ProjectReviewCount> {
    const membershipChanged =
      JSON.stringify(this.projects) !== JSON.stringify(projects.map(({ id, path }) => ({ id, path })));
    this.projects = projects.map(({ id, path }) => ({ id, path }));
    if (membershipChanged)
      for (const worker of this.workers.keys()) worker.postMessage({ retain: projects.map((project) => project.id) });
    const paths = new Map(projects.map((project) => [project.id, project.path]));
    const active = new Set([...this.workers.values()].flatMap((value) => (value ? [value.id] : [])));
    for (const [id, value] of this.values) if (paths.get(id) !== value.path) this.values.delete(id);
    for (const project of projects) {
      let value = this.values.get(project.id);
      if (!value) {
        value = {
          path: project.path,
          generation: ++this.sequence,
          at: 0,
          revision: 0,
          delegated: false,
          dirty: true,
        };
        this.values.set(project.id, value);
      }
      if (!value.delegated && !value.dirty && !active.has(project.id) && Date.now() - value.at >= 3000) {
        value.at = Date.now();
        value.dirty = true;
        value.generation = ++this.sequence;
      }
    }
    this.dispatch();
    return this.values;
  }
  /** Open project monitors already own acquisition; their published queue is authoritative. */
  observe(project: ProjectLocation, index?: WorkspaceIndex): void {
    const previous = this.values.get(project.id);
    if (!index) {
      if (previous) previous.delegated = false;
      return;
    }
    const count = index.select({}).pendingReviews;
    this.metrics.count("reviewSummaryReuses");
    this.values.set(project.id, {
      path: project.path,
      count,
      revision: previous?.count === count && !previous.problem ? (previous.revision ?? 0) : ++this.sequence,
      generation: ++this.sequence,
      at: Date.now(),
      delegated: true,
      dirty: false,
    });
    if (previous?.count !== count || previous.problem)
      this.changed(project.id, { count, revision: this.values.get(project.id)?.revision ?? 0 });
    this.dispatch();
  }
  invalidate(id?: string): void {
    for (const [key, value] of this.values)
      if (id === undefined || id === key) {
        value.generation = ++this.sequence;
        value.dirty = true;
      }
    this.dispatch();
  }
  private dispatch(): void {
    if (this.closed) return;
    const unmonitored = this.projects.filter((project) => !this.values.get(project.id)?.delegated);
    if (!unmonitored.length) {
      const workers = [...this.workers.keys()];
      this.workers.clear();
      for (const worker of workers) void worker.terminate();
      return;
    }
    const active = new Set([...this.workers.values()].flatMap((value) => (value ? [value.id] : [])));
    const queued = unmonitored.filter((project) => {
      const value = this.values.get(project.id);
      return value?.dirty && !active.has(project.id);
    });
    for (const project of queued) {
      let worker = [...this.workers].find(([, value]) => !value)?.[0];
      if (!worker) {
        if (this.workers.size >= 2) break;
        try {
          worker = this.start();
        } catch (error) {
          this.failed(project, error);
          continue;
        }
      }
      const value = this.values.get(project.id);
      if (!value) continue;
      const request = { ...project, generation: value.generation };
      this.metrics.count("reviewSummaryJobs");
      this.workers.set(worker, request);
      value.dirty = false;
      try {
        worker.postMessage(request);
      } catch (error) {
        this.failed(request, error);
        this.workers.delete(worker);
        void worker.terminate();
      }
    }
  }
  private failed(project: ProjectLocation, error: unknown): void {
    const value = this.values.get(project.id);
    if (
      value?.path !== project.path ||
      value.delegated ||
      ("generation" in project && project.generation !== value.generation)
    )
      return;
    const problem = error instanceof Error ? error.message : String(error);
    const changed = value.problem !== problem;
    value.problem = problem;
    value.at = Date.now();
    value.dirty = false;
    this.metrics.count("reviewSummaryFailures");
    if (!changed) return;
    value.revision = ++this.sequence;
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.WorkspaceRefresh,
      DiagnosticOutcome.Failed,
      { operation: "project review summary", project: project.id },
      error,
    );
    if (!this.closed) this.changed(project.id, value);
  }
  private start(): Worker {
    const worker = this.createWorker();
    this.workers.set(worker, undefined);
    worker.on("message", (input: unknown) => {
      const request = this.workers.get(worker);
      if (this.closed || !request) return;
      try {
        const response = job(input);
        check(
          response.id === request.id && response.path === request.path && response.generation === request.generation,
          "response",
          "does not match its request",
        );
        const previous = this.values.get(response.id);
        if (previous?.generation === response.generation && !previous.delegated) {
          if ("error" in (input as object)) this.failed(request, decodeWorkerFailure(input));
          else {
            check(
              input &&
                typeof input === "object" &&
                "count" in input &&
                Number.isSafeInteger(input.count) &&
                Number(input.count) >= 0,
              "response",
              "is invalid",
            );
            const count = Number(input.count),
              changed = previous.count !== count || !!previous.problem;
            if ("durationMs" in input && typeof input.durationMs === "number")
              this.metrics.phase("reviews", input.durationMs);
            const value = {
              ...previous,
              count,
              at: Date.now(),
              revision: changed ? ++this.sequence : (previous.revision ?? 0),
            };
            delete value.problem;
            this.values.set(response.id, value);
            if (changed) this.changed(response.id, { count, revision: value.revision });
          }
        } else this.metrics.count("reviewSummaryDiscards");
        this.workers.set(worker, undefined);
        this.dispatch();
      } catch (error) {
        this.failed(request, error);
        this.workers.delete(worker);
        void worker.terminate();
        this.dispatch();
      }
    });
    worker.once("error", (error: Error) => {
      const request = this.workers.get(worker);
      if (request) this.failed(request, error);
      this.workers.delete(worker);
      void worker.terminate();
      this.dispatch();
    });
    worker.once("exit", (code) => {
      const request = this.workers.get(worker);
      this.workers.delete(worker);
      if (!this.closed && request) this.failed(request, new Error(`Project review worker exited (${String(code)})`));
      this.dispatch();
    });
    return worker;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.workers.keys()].map(async (worker) => worker.terminate()));
    this.workers.clear();
    this.values.clear();
  }
}
