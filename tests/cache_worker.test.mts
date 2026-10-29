import { decodeCacheError, decodeCacheProgress } from "../src/web/cache-protocol.ts";
import { InventoryService } from "../src/web/inventory-service.ts";
import { afterEach, expect, test, vi } from "vitest";
import { resolve } from "node:path";
import { emptyInventory } from "../src/web/cache-inventory.ts";
import { CacheTasks } from "../src/web/cache-worker.ts";

const workers = vi.hoisted(
  () =>
    [] as (import("node:events").EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
    })[],
);
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class Worker extends EventEmitter {
    private readonly readOnly: boolean;
    postMessage = vi.fn((message: unknown) => {
      if (message && typeof message === "object" && "cancel" in message && this.readOnly)
        queueMicrotask(() => this.emit("exit", 0));
    });
    terminate = vi.fn(() => {
      this.emit("exit", 1);
      return Promise.resolve(1);
    });
    constructor(_path: string, options: { workerData: { workbenchCache: { kind: string; digest?: string } } }) {
      super();
      const task = options.workerData.workbenchCache;
      this.readOnly = ["inventory", "project", "assets"].includes(task.kind) && task.digest === undefined;
      workers.push(this);
    }
  }
  return { Worker, parentPort: null };
});
afterEach(() => {
  workers.splice(0);
  vi.useRealTimers();
});
const distribution = resolve(import.meta.dirname, "..");
test("automatic inventory refresh reuses the snapshot for fifteen minutes", async () => {
  vi.useFakeTimers();
  const tasks = new CacheTasks(distribution),
    inventories = new InventoryService(() => tasks);
  try {
    await inventories.read();
    const worker = workers[0];
    if (!worker) throw new Error("Missing inventory worker");
    worker.emit("message", { value: emptyInventory() });
    worker.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(inventories.refreshing).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await inventories.read();
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(14 * 60_000 + 44_999);
    await inventories.read();
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await inventories.read();
    expect(workers).toHaveLength(2);
  } finally {
    inventories.close();
    await tasks.close();
  }
});
test("cache scans can finish after arbitrarily long elapsed time", async () => {
  vi.useFakeTimers();
  const tasks = new CacheTasks(distribution),
    result = tasks.run({ kind: "inventory" });
  let completed = false;
  void result.then(() => {
    completed = true;
  });
  const worker = workers[0];
  if (!worker) throw new Error("Expected inspection worker");
  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(completed).toBe(false);
  worker.emit("message", { value: emptyInventory() });
  worker.emit("exit", 0);
  await expect(result).resolves.toEqual(emptyInventory());
  await tasks.close();
});
test("shutdown cancels scans while draining an admitted mutation", async () => {
  const tasks = new CacheTasks(distribution),
    scan = tasks.run({ kind: "inventory" }),
    mutation = tasks.run({ kind: "keep", identity: "fixture", keep: true });
  const rejected = expect(scan).rejects.toMatchObject({ name: "AbortError", status: 503 });
  let closed = false;
  const closing = tasks.close().then(() => {
    closed = true;
  });
  await rejected;
  expect(workers[0]?.postMessage).toHaveBeenCalledWith({ cancel: true });
  expect(workers[1]?.terminate).not.toHaveBeenCalled();
  expect(closed).toBe(false);
  workers[1]?.emit("message", { value: { applied: true } });
  workers[1]?.emit("exit", 0);
  await mutation;
  await closing;
  expect(closed).toBe(true);
});

test("worker messages validate typed results and reject malformed or unexpected progress", async () => {
  const tasks = new CacheTasks(distribution);
  const result = tasks.run({ kind: "keep", identity: "/fixture", keep: true });
  const rejected = expect(result).rejects.toThrow("Invalid cache worker data");
  workers[0]?.emit("message", { value: { applied: "yes" } });
  workers[0]?.emit("exit", 0);
  await rejected;
  expect(workers[0]?.postMessage).toHaveBeenCalledWith({ cancel: true });
  await tasks.close();
});

test("fresh inventory requests can publish metadata while the owned size scan continues", async () => {
  const tasks = new CacheTasks(distribution),
    inventories = new InventoryService(() => tasks);
  const fresh = inventories.read(true);
  const value = emptyInventory();
  value.kept.push("/retained");
  const worker = workers[0];
  if (!worker) throw new Error("Missing inventory worker");
  worker.emit("message", { progress: { kind: "metadata", value } });
  expect(await fresh).toMatchObject({ complete: true, refreshing: true, kept: ["/retained"] });
  expect((await inventories.read()).kept).toEqual(["/retained"]);
  expect(workers).toHaveLength(1);
  inventories.invalidate();
  expect(inventories.view().kept).toEqual(["/retained"]);
  await vi.waitFor(() => {
    expect(inventories.refreshing).toBe(false);
  });
  const second = inventories.read(true);
  const replacement = workers[1];
  if (!replacement) throw new Error("Missing replacement worker");
  replacement.emit("message", { progress: { kind: "metadata", value: emptyInventory() } });
  await second;
  replacement.emit("message", { value: emptyInventory() });
  replacement.emit("exit", 0);
  inventories.close();
  await tasks.close();
});

test("forced remeasurement replaces an older scan rather than reusing already-published metadata", async () => {
  const tasks = new CacheTasks(distribution),
    inventories = new InventoryService(() => tasks);
  const first = inventories.read(true),
    worker = workers[0];
  if (!worker) throw new Error("Missing original worker");
  worker.emit("message", { progress: { kind: "metadata", value: emptyInventory() } });
  await first;
  const fresh = inventories.read(true, true);
  await vi.waitFor(() => {
    expect(workers).toHaveLength(2);
  });
  expect(worker.postMessage).toHaveBeenCalledWith({ cancel: true });
  const replacement = workers[1],
    value = emptyInventory();
  value.kept.push("/fresh");
  replacement?.emit("message", { progress: { kind: "metadata", value } });
  expect(await fresh).toMatchObject({ kept: ["/fresh"], refreshing: true });
  replacement?.emit("message", { value });
  replacement?.emit("exit", 0);
  inventories.close();
  await tasks.close();
});
test("protocol discriminators and error status reject coercible non-string and non-numeric values", () => {
  expect(() => decodeCacheError({ error: { message: "failure" }, status: "409" })).toThrow("Invalid worker failure");
  expect(() => decodeCacheProgress({ kind: "size", size: { directory: "/fixture", state: ["pending"] } })).toThrow(
    "Invalid cache worker data",
  );
});

test("shutdown admission rejects every read-only task including unused asset inspection", async () => {
  const tasks = new CacheTasks(distribution);
  tasks.cancelPending();
  await expect(tasks.run({ kind: "assets" })).rejects.toMatchObject({ status: 503 });
  expect(workers).toHaveLength(0);
  await tasks.close();
});
