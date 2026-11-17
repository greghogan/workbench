import { decodeCacheError, decodeCacheProgress } from "../../../src/server/cache/cache-protocol.ts";
import { InventoryService } from "../../../src/server/cache/inventory-service.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { invalidateCacheSize } from "../../../src/core/storage/cache-generation.mjs";
import { emptyInventory } from "../../../src/server/cache/cache-inventory.ts";
import { CacheTasks } from "../../../src/server/cache/cache-worker.ts";
import { workerFailure } from "../../../src/server/http/error-response.ts";

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
      this.readOnly = ["inventory", "measure", "project", "assets"].includes(task.kind) && task.digest === undefined;
      workers.push(this);
    }
  }
  return { Worker, parentPort: null };
});
const inventoriesUnderTest: InventoryService[] = [];
let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "workbench-cache-service-"));
  vi.stubEnv("WORKBENCH_STATE_HOME", state);
});
function inventoryService(tasks: CacheTasks): InventoryService {
  const service = new InventoryService(() => tasks);
  inventoriesUnderTest.push(service);
  return service;
}
afterEach(() => {
  for (const service of inventoriesUnderTest.splice(0)) service.close();
  workers.splice(0);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(state, { recursive: true, force: true });
});
const distribution = resolve(import.meta.dirname, "../../../..");
test("automatic inventory refresh reuses the snapshot for fifteen minutes", async () => {
  vi.useFakeTimers();
  const tasks = new CacheTasks(distribution),
    inventories = inventoryService(tasks);
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

test("failed inventory refreshes retain the complete values and retry automatically after backoff", async () => {
  vi.useFakeTimers();
  const tasks = new CacheTasks(distribution),
    inventories = inventoryService(tasks);
  const original = emptyInventory();
  original.kept = ["/retained"];
  try {
    await inventories.read();
    workers[0]?.emit("message", { value: original });
    workers[0]?.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);
    inventories.invalidate();
    await inventories.read();
    workers[1]?.emit("message", workerFailure(new Error("Temporary inventory failure")));
    workers[1]?.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(inventories.view()).toMatchObject({ kept: ["/retained"], problem: "Temporary inventory failure" });
    await inventories.read();
    expect(workers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await inventories.read();
    expect(workers).toHaveLength(3);
    const replacement = emptyInventory();
    replacement.kept = ["/new"];
    workers[2]?.emit("message", { value: replacement });
    workers[2]?.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(inventories.view()).toMatchObject({ kept: ["/new"], problem: "" });
  } finally {
    inventories.close();
    await tasks.close();
  }
});

test("fresh project discovery replaces old totals before auxiliary discovery finishes", async () => {
  const tasks = new CacheTasks(distribution),
    inventories = inventoryService(tasks);
  try {
    const fresh = inventories.read(true);
    let completed = false;
    void fresh.then(() => {
      completed = true;
    });
    workers[0]?.emit("message", {
      progress: { kind: "metadata", value: { ...emptyInventory(), pendingComponents: ["builders"] } },
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(inventories.view().pendingComponents).toEqual(["builders"]);
    const original = emptyInventory();
    original.kept = ["/retained"];
    workers[0]?.emit("message", { progress: { kind: "metadata", value: original } });
    expect((await fresh).kept).toEqual(["/retained"]);
    workers[0]?.emit("message", { value: original });
    workers[0]?.emit("exit", 0);
    await vi.waitFor(() => {
      expect(inventories.refreshing).toBe(false);
    });
    inventories.invalidate();
    const refresh = inventories.read(true);
    workers[1]?.emit("message", {
      progress: { kind: "metadata", value: { ...emptyInventory(), pendingComponents: ["builders"] } },
    });
    expect(inventories.view()).toMatchObject({ kept: [], pendingComponents: ["builders"] });
    const revised = emptyInventory();
    revised.issues.push({ component: "tools", phase: "discovery", message: "Tool inspection failed" });
    workers[1]?.emit("message", { progress: { kind: "metadata", value: revised } });
    expect(await refresh).toMatchObject({ kept: [], issues: revised.issues });
    workers[1]?.emit("message", { value: revised });
    workers[1]?.emit("exit", 0);
    await vi.waitFor(() => {
      expect(inventories.view()).toMatchObject({ kept: [], issues: revised.issues, refreshing: false });
    });
  } finally {
    inventories.close();
    await tasks.close();
  }
});

test.each([false, true])(
  "a directory generation change refreshes only that measurement (active scan: %s)",
  async (scanning) => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "workbench-measure-invalidation-"));
    const first = join(root, "first"),
      second = join(root, "second");
    for (const path of [first, second]) {
      mkdirSync(path);
      invalidateCacheSize(path, true);
    }
    const tasks = new CacheTasks(distribution),
      inventories = inventoryService(tasks);
    try {
      const value = emptyInventory();
      value.sizes = [first, second].map((directory, index) => ({
        directory,
        state: "ready",
        bytes: (index + 1) * 10,
        measuredAt: new Date().toISOString(),
      }));
      await inventories.read();
      const finishScan = async () => {
        workers[0]?.emit("message", { value });
        workers[0]?.emit("exit", 0);
        await vi.advanceTimersByTimeAsync(0);
      };
      if (scanning) workers[0]?.emit("message", { progress: { kind: "metadata", value } });
      else await finishScan();
      const calls = vi.spyOn(tasks, "run");
      invalidateCacheSize(first, true);
      await vi.advanceTimersByTimeAsync(15_000);
      await inventories.read();
      if (scanning) {
        expect(calls).not.toHaveBeenCalled();
        await finishScan();
      }
      expect(calls.mock.calls.map(([task]) => task.kind)).toEqual(["measure"]);
      expect(inventories.view().sizes.map((size) => size.bytes)).toEqual([10, 20]);
      workers[1]?.emit("message", {
        value: { size: { directory: first, state: "ready", bytes: 15, measuredAt: new Date().toISOString() } },
      });
      workers[1]?.emit("exit", 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(inventories.view().sizes.map((size) => size.bytes)).toEqual([15, 20]);
      expect(calls).toHaveBeenCalledOnce();
    } finally {
      inventories.close();
      await tasks.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
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
    inventories = inventoryService(tasks);
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
    inventories = inventoryService(tasks);
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
