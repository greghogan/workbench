import type { ServerResponse } from "node:http";
import { settleCleanup } from "../diagnostics.js";
import type { RegisteredProject } from "../project-registry.js";
import { projectBase } from "./project-mounts.js";
import { WebError } from "./errors.js";
import { startWebServer } from "./server.js";

interface Admission {
  done: Promise<void>;
  release: () => void;
}
/** Admission, resource ownership, and shutdown share one owner and one drain barrier. */
export class HubLifecycle {
  private phase: "open" | "closing" = "open";
  private readonly handlers = new Set<Admission>();
  private readonly resources = new Set<string>();
  get closing(): boolean {
    return this.phase === "closing";
  }
  get mutations(): number {
    return this.resources.size;
  }
  admit(): Admission {
    if (this.phase !== "open") throw new WebError(503, "Service is stopping");
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const admission = {
      done,
      release: () => {
        this.handlers.delete(admission);
        finish();
      },
    };
    this.handlers.add(admission);
    return admission;
  }
  claim(resource: string): () => void {
    if (this.resources.has(resource))
      throw new WebError(409, "This resource is being changed; retry when the operation completes");
    this.resources.add(resource);
    return () => this.resources.delete(resource);
  }
  stop(): void {
    this.phase = "closing";
  }
  async drain(): Promise<void> {
    await Promise.all([...this.handlers].map((entry) => entry.done));
  }
}
interface ProjectView {
  path: string;
  application: Promise<Awaited<ReturnType<typeof startWebServer>>>;
  active: number;
  used: number;
}
/** Evict idle views only; a response stream owns its view until the connection finishes. */
export class ProjectViews {
  private readonly entries = new Map<string, ProjectView>();
  private readonly blocked = new Set<string>();
  private sequence = 0;
  private closed = false;
  private readonly transitions = new Map<string, Promise<unknown>>();
  private readonly retiringById = new Map<string, Promise<void>>();
  private readonly retiring = new Set<Promise<void>>();
  private readonly disposals = new WeakMap<ProjectView, Promise<void>>();
  constructor(
    private readonly capacity = 16,
    private readonly workerBundle?: string,
  ) {}
  private async transition<T>(id: string, action: () => T | Promise<T>): Promise<T> {
    const previous = this.transitions.get(id) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(action);
    this.transitions.set(id, work);
    try {
      return await work;
    } finally {
      if (this.transitions.get(id) === work) this.transitions.delete(id);
    }
  }
  private dispose(id: string, entry: ProjectView): Promise<void> {
    const previous = this.disposals.get(entry);
    if (previous) return previous;
    const work = entry.application.then(
      (application) => application.close(),
      () => undefined,
    );
    this.disposals.set(entry, work);
    this.retiring.add(work);
    this.retiringById.set(id, work);
    void work.then(
      () => {
        this.retiring.delete(work);
        if (this.retiringById.get(id) === work) this.retiringById.delete(id);
      },
      () => undefined,
    );
    return work;
  }
  private acquire(project: RegisteredProject, cancelled: () => boolean): Promise<ProjectView> {
    if (this.closed) return Promise.reject(new WebError(503, "Project views are stopping"));
    if (this.blocked.has(project.id)) return Promise.reject(new WebError(409, "Project removal is in progress"));
    return this.transition(project.id, () => {
      if (cancelled()) throw new DOMException("Request closed", "AbortError");
      if (this.closed) throw new WebError(503, "Project views are stopping");
      if (this.blocked.has(project.id)) throw new WebError(409, "Project removal is in progress");
      let entry = this.entries.get(project.id);
      if (entry?.path !== project.path && this.retiring.size >= this.capacity)
        throw new WebError(503, "Project views are being released; retry after cleanup completes");
      const cleanup: Promise<void>[] = [];
      const retiring = this.retiringById.get(project.id);
      if (retiring) cleanup.push(retiring);
      if (entry && entry.path !== project.path) {
        this.entries.delete(project.id);
        cleanup.push(this.dispose(project.id, entry));
        entry = undefined;
      }
      if (!entry) {
        if (this.entries.size >= this.capacity) {
          const idle = [...this.entries]
            .filter(([, value]) => value.active === 0)
            .sort((a, b) => a[1].used - b[1].used)[0];
          if (!idle) throw new WebError(503, "All project views are active; close an idle browser tab and retry");
          this.entries.delete(idle[0]);
          cleanup.push(this.dispose(idle[0], idle[1]));
        }
        entry = {
          path: project.path,
          application: Promise.all(cleanup).then(() => {
            if (this.closed || this.blocked.has(project.id)) throw new WebError(503, "Project view is stopping");
            return startWebServer(project.path, {
              listen: false,
              ...(this.workerBundle ? { workerBundle: this.workerBundle } : {}),
              basePath: projectBase(project.id),
              projectName: project.name,
            });
          }),
          active: 0,
          used: ++this.sequence,
        };
        this.entries.set(project.id, entry);
        const created = entry;
        void entry.application.catch(() => {
          if (this.entries.get(project.id) === created) this.entries.delete(project.id);
        });
      }
      entry.active++;
      entry.used = ++this.sequence;
      return entry;
    });
  }
  async use(project: RegisteredProject, response: ServerResponse) {
    let entry: ProjectView | undefined,
      ended = response.destroyed || response.writableFinished;
    let disconnect!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      disconnect = resolve;
    });
    const release = () => {
      ended = true;
      if (entry) {
        entry.active--;
        entry.used = ++this.sequence;
        entry = undefined;
      }
      response.off("finish", release).off("close", release);
      disconnect();
    };
    response.once("finish", release).once("close", release);
    try {
      entry = await this.acquire(project, () => ended);
      if (ended) {
        release();
        throw new DOMException("Request closed", "AbortError");
      }
      return await Promise.race([
        entry.application,
        disconnected.then(() => {
          throw new DOMException("Request closed", "AbortError");
        }),
      ]);
    } catch (error) {
      release();
      throw error;
    }
  }
  async remove(id: string): Promise<() => void> {
    if (this.blocked.has(id)) throw new WebError(409, "Project removal is in progress");
    this.blocked.add(id);
    try {
      await this.transition(id, async () => {
        const entry = this.entries.get(id);
        this.entries.delete(id);
        if (entry) await this.dispose(id, entry);
        else await this.retiringById.get(id);
      });
    } catch (error) {
      this.blocked.delete(id);
      throw error;
    }
    return () => this.blocked.delete(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.transitions.values()]);
    const entries = [...this.entries];
    this.entries.clear();
    for (const [id, entry] of entries) void this.dispose(id, entry);
    await settleCleanup([...this.retiring].map((work) => () => work));
  }
  get size(): number {
    return this.entries.size;
  }
  async watchers(): Promise<number> {
    const values = await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => (await entry.application).monitor.watcherCount),
    );
    return values.reduce((sum, value) => sum + (value.status === "fulfilled" ? value.value : 0), 0);
  }
  async activeCollections(): Promise<number> {
    const values = await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => (await entry.application).activeCollections()),
    );
    return values.reduce((sum, value) => sum + (value.status === "fulfilled" ? value.value : 0), 0);
  }
}
