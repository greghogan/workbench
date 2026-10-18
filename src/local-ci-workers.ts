import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { positiveInteger } from "../scripts/cpu-budget.mjs";
import { CILifecycle } from "./ci-lifecycle.js";

export interface CIInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface CIWorker {
  id: string;
  log: string;
  start: () => Promise<CIInvocation>;
  finish: (error?: Error) => Promise<void>;
}

/** Bound preparation and execution together; drain active jobs before cleanup. */
export async function runCIWorkers(workers: CIWorker[], concurrency: number, lifecycle: CILifecycle): Promise<void> {
  positiveInteger(concurrency, "CI worker concurrency");
  let next = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, workers.length) }, async () => {
      while (next < workers.length && (await lifecycle.ready())) {
        const worker = workers[next++];
        if (!worker) break;
        console.log(`Starting CI target ${worker.id}`);
        let error: Error | undefined;
        let child: ChildProcess | undefined;
        const output = createWriteStream(worker.log, { flags: "wx" });
        output.on("error", (failure) => {
          error ??= failure;
          // A failed log sink must not block the admitted mutation on a full output pipe.
          child?.stdout?.resume();
          child?.stderr?.resume();
        });
        try {
          await once(output, "open");
          const invocation = await worker.start();
          if (error) throw error;
          await new Promise<void>((resolve) => {
            child = spawn(invocation.command, invocation.args, {
              env: invocation.env,
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
            child.stdout?.pipe(output, { end: false });
            child.stderr?.pipe(output, { end: false });
            child.on("error", (failure) => {
              error ??= failure;
            });
            child.once("close", (code, signal) => {
              if (code !== 0) error ??= new Error(`CI worker failed: ${String(code ?? signal)}`);
              resolve();
            });
          });
        } catch (failure) {
          error = failure instanceof Error ? failure : new Error(String(failure));
        } finally {
          output.end();
          if (!output.closed)
            await once(output, "close").catch((failure: unknown) => {
              error ??= failure instanceof Error ? failure : new Error(String(failure));
            });
        }
        await worker.finish(error);
        console.log(`Finished CI target ${worker.id}; log: ${worker.log}`);
      }
    }),
  );
  const failures = outcomes.filter((outcome) => outcome.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((outcome) => outcome.reason as unknown),
      "CI worker coordination failed after draining active jobs",
    );
}
