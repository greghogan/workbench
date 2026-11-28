import { execFileSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MachineAdmission } from "../../../../src/core/execution/checks/machine-admission.ts";
import { unixWorkerFifoSupported } from "../../../../src/core/execution/checks/unix-jobserver-protocol.ts";
import { UnixWorkerPipe } from "../../../../src/server/http/unix-worker-pipe.ts";

test.runIf(unixWorkerFifoSupported)("a FIFO slot remains reserved while a worker holds its token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-worker-pipe-"));
  const machine = new MachineAdmission({ maxJobs: 2, workerSlots: 2, memoryReserve: 0, settlingMs: 0 });
  machine.observe({ availableMemory: 1024 });
  const lifetime = new AbortController();
  const claimed = await machine.acquire("compile");
  let pipe: UnixWorkerPipe | undefined;
  let worker: number | undefined;
  try {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Linux worker pipes require a POSIX account");
    const path = join(directory, "workers.fifo");
    execFileSync("/usr/bin/mkfifo", ["-m", "600", path]);
    pipe = new UnixWorkerPipe(path, uid, 1, claimed);
    worker = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
    expect(pipe.supply(1)).toBe(1);
    const token = Buffer.alloc(1);
    expect(readSync(worker, token)).toBe(1);

    const waiting = machine.acquire("test", lifetime.signal);
    void waiting.catch(() => undefined);
    pipe.withdraw();
    expect(machine.inspect()).toMatchObject({ active: 1, waiting: 1, reason: "worker slots" });

    expect(writeSync(worker, token)).toBe(1);
    pipe.withdraw();
    const admitted = await waiting;
    expect(machine.inspect()).toMatchObject({ active: 2, waiting: 0 });
    await admitted.release();
    expect(pipe.supply(1)).toBe(1);
  } finally {
    lifetime.abort();
    if (worker !== undefined) closeSync(worker);
    pipe?.close();
    await claimed.release();
    rmSync(directory, { recursive: true });
  }
});
