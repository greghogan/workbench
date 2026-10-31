import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceMonitor } from "../src/web/live.ts";
import { WorkspaceCollector } from "../src/workspace-service.ts";
import { WorkspaceRequest } from "../src/web/workspace-protocol.ts";
import { workerFailure } from "../src/web/error-response.ts";
import { InvalidInput } from "../src/input-errors.ts";
import { webServers } from "./fixtures/web.mjs";
const fixtures = webServers();
class ControlledWorker extends EventEmitter {
  postMessage = vi.fn((message: unknown) => {
    if (message === WorkspaceRequest.Close) queueMicrotask(() => this.emit("exit", 0));
  });
}
afterEach(() => vi.useRealTimers());
test("failed read workers back off, retain the snapshot, and allow explicit recovery after exhaustion", async () => {
  const root = fixtures.project(),
    snapshot = new WorkspaceCollector(root).collect(),
    workers: ControlledWorker[] = [];
  vi.useFakeTimers();
  const monitor = new WorkspaceMonitor(root, 100000, undefined, () => {
    const worker = new ControlledWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  try {
    const ready = monitor.ready();
    workers[0]?.emit("message", { ok: true, snapshot });
    await ready;

    for (let attempt = 0; attempt < 4; attempt++) {
      const previous = monitor.index;
      workers[attempt]?.emit("exit", 1);
      expect(monitor.index).toBe(previous);
      if (attempt < 3) {
        await vi.advanceTimersByTimeAsync(1000 * 2 ** attempt);
        expect(workers).toHaveLength(attempt + 2);
        workers[attempt + 1]?.emit("message", { ok: true, snapshot });
        await vi.advanceTimersByTimeAsync(0);
      }
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(workers).toHaveLength(4);
    expect(monitor.problem).toContain("exhausted");
    const retry = monitor.retry();
    expect(workers).toHaveLength(5);
    workers[4]?.emit("message", { ok: true, snapshot });
    await retry;
    expect(monitor.problem).toBe("");
    expect(monitor.revision).toBe(snapshot.revision);
  } finally {
    await monitor.close();
  }
});
test("ordinary invalid documents are reported without restarting the read worker", async () => {
  const root = fixtures.project(),
    workers: ControlledWorker[] = [];
  vi.useFakeTimers();
  const monitor = new WorkspaceMonitor(root, 100000, undefined, () => {
    const worker = new ControlledWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  try {
    const ready = monitor.ready();
    workers[0]?.emit("message", { ok: false, ...workerFailure(new InvalidInput("Malformed record")) });
    await expect(ready).rejects.toThrow("Malformed record");
    await vi.advanceTimersByTimeAsync(7000);
    expect(workers).toHaveLength(1);
  } finally {
    await monitor.close();
  }
});

test("unchanged publications preserve the index and explicit reconciliation requests fresh inputs", async () => {
  const root = fixtures.project(),
    snapshot = new WorkspaceCollector(root).collect(),
    worker = new ControlledWorker();
  const monitor = new WorkspaceMonitor(root, 100000, undefined, () => worker as unknown as Worker);
  try {
    const ready = monitor.ready();
    worker.emit("message", { ok: true, snapshot });
    await ready;
    const index = monitor.index;
    const pending = monitor.reconcile();
    worker.emit("message", {
      ok: true,
      unchanged: { revision: snapshot.revision, collectedAt: "2030-01-01T00:00:00.000Z" },
    });
    await pending;
    expect(monitor.index).toBe(index);
    expect(monitor.index?.snapshot.collectedAt).toBe("2030-01-01T00:00:00.000Z");
    const fresh = monitor.reconcile(true);
    expect(worker.postMessage).toHaveBeenLastCalledWith(WorkspaceRequest.Fresh);
    worker.emit("message", { ok: true, snapshot });
    await fresh;
    const invalid = monitor.reconcile();
    worker.emit("message", { ok: true, unchanged: { revision: "other", collectedAt: "invalid" } });
    await expect(invalid).rejects.toThrow("invalid unchanged");
  } finally {
    await monitor.close();
  }
});
