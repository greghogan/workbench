import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, test } from "vitest";
import { MachineAdmission } from "../../../../src/core/execution/checks/machine-admission.ts";

const healthy = { cpuSaturated: false, availableMemory: 4096 };

test("admission rotates runnable projects while preserving arrival order and a machine-wide job limit", async () => {
  const machine = new MachineAdmission({ maxJobs: 1, workerSlots: 4, memoryReserve: 100, settlingMs: 0 });
  machine.observe(healthy);
  const first = await machine.acquire("alice/source");
  const order: string[] = [];
  const request = (project: string, label: string) =>
    machine.acquire(project).then((lease) => {
      order.push(label);
      return lease;
    });
  const a1 = request("alice/source", "a1");
  const a2 = request("alice/source", "a2");
  const b1 = request("bob/source", "b1");
  const b2 = request("bob/source", "b2");
  expect(machine.inspect()).toEqual({ active: 1, waiting: 4, reason: "job limit" });
  await first.release();
  await nextTurn();
  expect(order).toEqual(["b1"]);
  const second = await b1;
  await first.release();
  expect(machine.inspect()).toMatchObject({ active: 1, waiting: 3 });
  await second.release();
  await nextTurn();
  expect(order).toEqual(["b1", "a1"]);
  await (await a1).release();
  await nextTurn();
  expect(order).toEqual(["b1", "a1", "b2"]);
  await (await b2).release();
  await nextTurn();
  expect(order).toEqual(["b1", "a1", "b2", "a2"]);
  await (await a2).release();
  expect(machine.inspect()).toMatchObject({ active: 0, waiting: 0 });
});

test("settling, sustained CPU recovery, and memory pressure delay fresh work without interrupting leases", async () => {
  let clock = 0;
  const machine = new MachineAdmission(
    { maxJobs: 4, workerSlots: 2, memoryReserve: 100, settlingMs: 500 },
    () => clock,
  );
  machine.observe(healthy);
  const first = await machine.acquire("one");
  const second = machine.acquire("two");
  expect(machine.inspect()).toMatchObject({ active: 1, waiting: 1, reason: "job startup" });
  clock += 500;
  machine.observe({ ...healthy, cpuSaturated: true });
  expect(machine.inspect()).toMatchObject({ active: 1, waiting: 1, reason: "CPU saturation" });
  machine.observe(healthy);
  expect(machine.inspect().reason).toBe("CPU saturation");
  machine.observe({ ...healthy, availableMemory: 99 });
  expect(machine.inspect().reason).toBe("memory pressure");
  machine.observe({ ...healthy, memoryPressure: true });
  expect(machine.inspect().reason).toBe("memory pressure");
  machine.observe(healthy);
  expect(machine.inspect()).toMatchObject({ active: 2, waiting: 0 });
  const leased = await second;
  const third = machine.acquire("three");
  expect(machine.inspect()).toMatchObject({ active: 2, waiting: 1, reason: "worker slots" });
  clock += 500;
  await first.release();
  expect(machine.inspect()).toMatchObject({ active: 2, waiting: 0 });
  await (await third).release();
  await leased.release();
  expect(machine.inspect()).toMatchObject({ active: 0, waiting: 0 });
});

test("unavailable memory observation permits one job, with cancellation and shutdown preserving active ownership", async () => {
  const machine = new MachineAdmission({ maxJobs: 4, workerSlots: 4, memoryReserve: 100, settlingMs: 0 });
  const active = await machine.acquire("one");
  const stop = new AbortController();
  const cancelled = machine.acquire("two", stop.signal);
  const waiting = machine.acquire("three");
  expect(machine.inspect()).toMatchObject({ active: 1, waiting: 2, reason: "memory pressure" });
  stop.abort(new Error("The caller stopped waiting"));
  await expect(cancelled).rejects.toThrow("The caller stopped waiting");
  machine.close();
  await expect(waiting).rejects.toThrow("stopped accepting work");
  await expect(machine.acquire("four")).rejects.toThrow("stopped accepting work");
  expect(machine.inspect()).toMatchObject({ active: 1, waiting: 0 });
  await active.release();
  expect(machine.inspect()).toMatchObject({ active: 0, waiting: 0 });
});
