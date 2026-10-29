import type { ServerResponse } from "node:http";
import { settleCleanup } from "../diagnostics.js";
import type { RegisteredProject } from "../project-registry.js";
import { WebError } from "./errors.js";
import { startWebServer } from "./server.js";

interface Admission {
  done: Promise<void>;
  release: () => void;
}
/** Admission, transitions, and shutdown share one owner and one drain barrier. */
export class HubLifecycle {
  private phase: "open" | "transition" | "closing" = "open";
  private readonly handlers = new Set<Admission>();
  private readonly resources = new Set<string>();
  private transitionOperation: Promise<void> | undefined;
  get closing(): boolean {
    return this.phase === "closing";
  }
  get mutations(): number {
    return this.resources.size;
  }
  admit(): Admission {
    if (this.phase !== "open")
      throw new WebError(503, this.closing ? "Service is stopping" : "Service is switching to the demonstration");
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
  async transition(current: Admission | undefined, action: () => Promise<void>): Promise<void> {
    if (this.phase !== "open") throw new WebError(503, "Service transition is already in progress");
    this.phase = "transition";
    const operation = (async () => {
      await Promise.all([...this.handlers].filter((entry) => entry !== current).map((entry) => entry.done));
      if (!this.closing) await action();
    })();
    this.transitionOperation = operation;
    try {
      await operation;
    } finally {
      this.transitionOperation = undefined;
      if (!this.closing) this.phase = "open";
    }
  }
  stop(): void {
    this.phase = "closing";
  }
  async finishTransition(): Promise<void> {
    await Promise.allSettled([this.transitionOperation]);
  }
  async drain(): Promise<void> {
    await Promise.all([...this.handlers].map((entry) => entry.done));
  }
}
interface ProjectView {
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
  private queue = Promise.resolve();
  constructor(private readonly capacity = 16) {}
  private async acquire(project: RegisteredProject): Promise<ProjectView> {
    let resolve!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((done) => {
      resolve = done;
    });
    await previous;
    try {
      if (this.closed) throw new WebError(503, "Project views are stopping");
      if (this.blocked.has(project.id)) throw new WebError(409, "Project removal is in progress");
      let entry = this.entries.get(project.id);
      if (!entry) {
        if (this.entries.size >= this.capacity) {
          const idle = [...this.entries]
            .filter(([, value]) => value.active === 0)
            .sort((a, b) => a[1].used - b[1].used)[0];
          if (!idle) throw new WebError(503, "All project views are active; close an idle browser tab and retry");
          this.entries.delete(idle[0]);
          await (await idle[1].application).close();
        }
        entry = {
          application: startWebServer(project.path, {
            listen: false,
            basePath: `/p/${project.id}`,
            projectName: project.name,
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
    } finally {
      resolve();
    }
  }
  async use(project: RegisteredProject, response: ServerResponse) {
    const entry = await this.acquire(project);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        entry.active--;
        entry.used = ++this.sequence;
      }
    };
    response.once("finish", release).once("close", release);
    try {
      return await entry.application;
    } catch (error) {
      release();
      throw error;
    }
  }
  async remove(id: string): Promise<() => void> {
    this.blocked.add(id);
    const entry = this.entries.get(id);
    this.entries.delete(id);
    try {
      if (entry) await (await entry.application).close();
    } catch (error) {
      this.blocked.delete(id);
      throw error;
    }
    return () => this.blocked.delete(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await settleCleanup(entries.map((entry) => async () => (await entry.application).close()));
  }
  reopen(): void {
    this.closed = false;
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
