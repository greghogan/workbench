import { settleCleanup } from "../app/src/core/diagnostics/diagnostic-errors.mjs";
import { errorFrom } from "../app/src/core/runtime/values.mjs";
import { Worker } from "node:worker_threads";
import {
  collectNodeCoverageBatch,
  InvalidNodeCoverageReport,
  type CoverageBatchResult,
  type CoverageReader,
} from "./node-coverage-reports.mjs";
import {
  CoverageAccumulator,
  type CoverageCandidate,
  type MeasuredScript,
  type ScannedCoverage,
} from "./coverage-processing.mjs";
import type { Profiler } from "node:inspector";
import type { FileCoverageData } from "istanbul-lib-coverage";
import { positiveInteger } from "../app/src/core/execution/checks/cpu-budget.mjs";
import { admittedWork, type WorkAdmission } from "../app/src/core/execution/checks/work-admission.mjs";

interface ScanContext {
  directory: string;
  root: string;
  candidates: CoverageCandidate[];
}

interface ConvertJob {
  kind: "convert";
  script: MeasuredScript;
  execution: Profiler.ScriptCoverage;
}

export type CoverageTransportJob =
  | ({ kind: "initialize" } & ScanContext)
  | ({ kind: "scan" } & Parameters<CoverageReader>[0])
  | { kind: "finish" }
  | ConvertJob;

export type CoverageWorkerReply =
  | { kind: "ready" }
  | { kind: "scan"; result: CoverageBatchResult }
  | { kind: "finish"; result: ScannedCoverage }
  | { kind: "convert"; result: Record<string, FileCoverageData> }
  | { kind: "error"; error: string; diagnostic?: InvalidNodeCoverageReport["diagnostic"] };

interface CoverageQueueOptions {
  capacity: number;
  createWorker?: () => Worker;
  signal?: AbortSignal;
  admission?: WorkAdmission;
}

/** Own worker lifetime and outstanding protocol requests for both collection and conversion. */
function coverageWorkers(options: CoverageQueueOptions) {
  positiveInteger(options.capacity, "coverage workers");
  options.signal?.throwIfAborted();
  const workers: Worker[] = [];
  const failures = new WeakMap<Worker, Error>();
  const cancel = () => {
    for (const worker of workers) void worker.terminate();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });

  type Reply = Exclude<CoverageWorkerReply, { kind: "error" }>;
  const exchange = <K extends Reply["kind"]>(worker: Worker, request: CoverageTransportJob, expected: K) =>
    new Promise<Extract<Reply, { kind: K }>>((resolve, reject) => {
      const existing = failures.get(worker);
      if (existing) {
        reject(existing);
        return;
      }
      if (worker.threadId === -1) {
        reject(new Error("Coverage worker already exited"));
        return;
      }
      const cleanup = () => {
        worker.off("message", message);
        worker.off("error", failure);
        worker.off("exit", exited);
      };
      const message = (reply: CoverageWorkerReply) => {
        cleanup();
        if (reply.kind === "error")
          reject(
            reply.diagnostic
              ? new InvalidNodeCoverageReport(reply.diagnostic.file, reply.diagnostic.bytes, reply.diagnostic.reason)
              : new Error(reply.error),
          );
        else if (reply.kind !== expected)
          reject(new Error("Coverage worker returned " + reply.kind + "; expected " + expected));
        else resolve(reply as Extract<Reply, { kind: K }>);
      };
      const failure = (error: Error) => {
        cleanup();
        reject(errorFrom(error));
      };
      const exited = (status: number) => {
        cleanup();
        reject(new Error("Coverage worker exited before returning a result (" + String(status) + ")"));
      };
      worker.once("message", message);
      worker.once("error", failure);
      worker.once("exit", exited);
      try {
        worker.postMessage(request);
      } catch (error) {
        cleanup();
        reject(errorFrom(error));
      }
    });

  return {
    workers,
    exchange,
    add() {
      const worker = options.createWorker?.() ?? new Worker(new URL("./coverage-worker.mjs", import.meta.url));
      worker.on("error", (error) => failures.set(worker, error));
      workers.push(worker);
    },
    async close(failure?: unknown) {
      options.signal?.removeEventListener("abort", cancel);
      await settleCleanup(
        workers.splice(0).map((worker) => async () => {
          await worker.terminate();
        }),
        failure,
      );
    },
  };
}

export async function coverageReaders(context: ScanContext, options: CoverageQueueOptions) {
  if (options.capacity === 1) {
    const accumulator = new CoverageAccumulator(context.root, context.candidates);
    const read: CoverageReader = (batch) =>
      admittedWork(options.admission, options.signal, () =>
        Promise.resolve(
          collectNodeCoverageBatch(context.directory, batch, (report) => {
            accumulator.add(report);
          }),
        ),
      );
    return {
      readers: [read],
      finish: () => Promise.resolve([accumulator.result()]),
      close: () => Promise.resolve(),
    };
  }
  const pool = coverageWorkers(options);
  try {
    for (let index = 0; index < options.capacity; index++) pool.add();
    await Promise.all(pool.workers.map((worker) => pool.exchange(worker, { kind: "initialize", ...context }, "ready")));
    return {
      readers: pool.workers.map(
        (worker): CoverageReader =>
          (batch) =>
            admittedWork(
              options.admission,
              options.signal,
              async () => (await pool.exchange(worker, { kind: "scan", ...batch }, "scan")).result,
            ),
      ),
      finish: () =>
        Promise.all(
          pool.workers.map(async (worker) => (await pool.exchange(worker, { kind: "finish" }, "finish")).result),
        ),
      close: () => pool.close(),
    };
  } catch (error) {
    await pool.close(error);
    throw error;
  }
}

/** Available workers claim the next conversion and release their lease when it completes. */
export async function coverageJobs(jobs: ConvertJob[], options: CoverageQueueOptions) {
  const scope = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, scope.signal]) : scope.signal;
  const pool = coverageWorkers({ ...options, signal });
  const results: Record<string, FileCoverageData>[] = [];
  let next = 0;
  let failure: unknown;
  try {
    for (let index = 0; index < Math.min(options.capacity, jobs.length); index++) pool.add();
    await Promise.allSettled(
      pool.workers.map(async (worker) => {
        try {
          while (!signal.aborted && next < jobs.length) {
            const index = next++;
            const job = jobs[index];
            if (!job) throw new Error("Missing coverage job");
            results[index] = await admittedWork(
              options.admission,
              signal,
              async () => (await pool.exchange(worker, job, "convert")).result,
            );
          }
        } catch (error) {
          scope.abort(error);
        }
      }),
    );
    signal.throwIfAborted();
    return results;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await pool.close(failure);
  }
}
