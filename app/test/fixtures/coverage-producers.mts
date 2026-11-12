import { channel } from "node:diagnostics_channel";
import type { ChildProcess } from "node:child_process";
import type { Worker } from "node:worker_threads";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Observational ownership evidence only: never capture command arguments, environment, or source text. */
export function traceCoverageProducers(
  directory: string,
  context: () => { testPath?: string; currentTestName?: string },
): () => void {
  const output = `${directory}-producers`;
  let unavailable = false;
  const write = (name: string, value: Record<string, unknown>) => {
    if (unavailable) return;
    try {
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, name), JSON.stringify(value) + "\n", { mode: 0o600 });
    } catch {
      unavailable = true;
      process.stderr.write("Coverage producer diagnostics unavailable.\n");
    }
  };
  const origin = () => ({
    parentPid: process.pid,
    ...context(),
    stack: new Error().stack
      ?.split("\n")
      .slice(1)
      .filter((line) => !line.includes("node:"))
      .slice(0, 8),
  });
  write(`process-${String(process.pid)}.json`, { pid: process.pid, ...context() });
  const processCreated = (value: unknown) => {
    const child = (value as { process: ChildProcess }).process;
    const owner = origin();
    const started = () => {
      if (!child.pid) return;
      const name = `process-${String(child.pid)}.json`,
        entry = { pid: child.pid, ...owner };
      write(name, entry);
      child.once("exit", (status, signal) => {
        write(name, { ...entry, status, signal });
      });
    };
    if (child.pid) started();
    else child.once("spawn", started);
  };
  const workerCreated = (value: unknown) => {
    const worker = (value as { worker: Worker }).worker;
    const thread = worker.threadId;
    const name = `worker-${String(process.pid)}-${String(thread)}.json`,
      entry = { pid: process.pid, thread, ...origin() };
    write(name, entry);
    worker.once("exit", (status) => {
      write(name, { ...entry, status });
    });
  };
  const processes = channel("child_process"),
    workers = channel("worker_threads");
  processes.subscribe(processCreated);
  workers.subscribe(workerCreated);
  return () => {
    processes.unsubscribe(processCreated);
    workers.unsubscribe(workerCreated);
  };
}
