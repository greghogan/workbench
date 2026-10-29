import { settleCleanup } from "./diagnostic-errors.mjs";
import { Worker } from "node:worker_threads";
import { InvalidNodeCoverageReport } from "./node-coverage-reports.mjs";
import type { CoverageCandidate, MeasuredScript, ScannedCoverage } from "./coverage-processing.mjs";
import type { FileCoverageData } from "istanbul-lib-coverage";
import { positiveInteger } from "./cpu-budget.mjs";
import { admittedWork, type WorkAdmission } from "./work-admission.mjs";

interface ScanJob {
  kind: "scan";
  directory: string;
  root: string;
  candidates: CoverageCandidate[];
  files: string[];
}
interface ConvertJob {
  kind: "convert";
  script: MeasuredScript;
}
export type CoverageJob = ScanJob | ConvertJob;
export type CoverageTransportJob =
  | {
      kind: "initialize";
      directory: string;
      root: string;
      candidates: CoverageCandidate[];
      mode: "batch" | "accumulate";
    }
  | { kind: "scan"; files: string[] }
  | { kind: "finish" }
  | ConvertJob;
type CoverageResult = ScannedCoverage | Record<string, FileCoverageData>;
export type CoverageWorkerReply =
  | { kind: "ready" }
  | { kind: "scanned" }
  | { kind: "finish"; result: ScannedCoverage }
  | { kind: "scan"; result: ScannedCoverage }
  | { kind: "convert"; result: Record<string, FileCoverageData> }
  | { kind: "error"; error: string; diagnostic?: InvalidNodeCoverageReport["diagnostic"] };
type WorkerFactory = () => Worker;
const createCoverageWorker: WorkerFactory = () => new Worker(new URL("./coverage-worker.mjs", import.meta.url));

export interface CoverageQueueOptions {
  capacity: number;
  createWorker?: WorkerFactory;
  signal?: AbortSignal;
  admission?: WorkAdmission;
  scanBatchSize?: number;
  accumulate?: boolean;
}
/** Dynamic dispatch owns worker and capacity leases until every admitted job has drained. */
export function coverageJobs(
  jobs: ScanJob[],
  options: CoverageQueueOptions & { consume: (result: ScannedCoverage) => void },
): Promise<void>;
export function coverageJobs(
  jobs: ScanJob[],
  options: CoverageQueueOptions & { consume?: never },
): Promise<ScannedCoverage[]>;
export function coverageJobs(
  jobs: ConvertJob[],
  options: CoverageQueueOptions & { consume?: never },
): Promise<Record<string, FileCoverageData>[]>;
export async function coverageJobs(
  jobs: CoverageJob[],
  options: CoverageQueueOptions & { consume?: (result: ScannedCoverage) => void },
): Promise<CoverageResult[] | void> {
  positiveInteger(options.capacity, "coverage workers");
  if (options.scanBatchSize !== undefined) positiveInteger(options.scanBatchSize, "coverage scan batch");
  const first = jobs[0];
  if (
    options.accumulate &&
    (!options.consume ||
      jobs.some(
        (job) =>
          job.kind !== "scan" ||
          first?.kind !== "scan" ||
          job.directory !== first.directory ||
          job.root !== first.root ||
          job.candidates !== first.candidates,
      ))
  )
    throw new Error("Accumulated coverage requires one shared scan context and a consumer");
  const workers: Worker[] = [];
  const results: CoverageResult[] = new Array<CoverageResult>(options.consume ? 0 : jobs.length);
  const scope = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, scope.signal]) : scope.signal;
  let next = 0;
  const initialized = new WeakMap<Worker, ScanJob>();
  type Reply = Exclude<CoverageWorkerReply, { kind: "error" }>;
  const exchange = <K extends Reply["kind"]>(worker: Worker, request: CoverageTransportJob, expected: K) =>
    new Promise<Extract<Reply, { kind: K }>>((resolve, reject) => {
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
          reject(new Error(`Coverage worker returned ${reply.kind}; expected ${expected}`));
        else resolve(reply as Extract<Reply, { kind: K }>);
      };
      const failure = (error: Error) => {
        cleanup();
        reject(error);
      };
      const exited = (status: number) => {
        cleanup();
        reject(new Error(`Coverage worker exited before returning a result (${String(status)})`));
      };
      worker.once("message", message);
      worker.once("error", failure);
      worker.once("exit", exited);
      try {
        worker.postMessage(request);
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error("Cannot dispatch coverage work", { cause: error }));
      }
    });
  const execute = async (worker: Worker, job: CoverageJob): Promise<CoverageResult | undefined> => {
    if (job.kind === "convert") return (await exchange(worker, job, "convert")).result;
    const previous = initialized.get(worker);
    if (previous?.directory !== job.directory || previous.root !== job.root || previous.candidates !== job.candidates) {
      await exchange(
        worker,
        {
          kind: "initialize",
          directory: job.directory,
          root: job.root,
          candidates: job.candidates,
          mode: options.accumulate ? "accumulate" : "batch",
        },
        "ready",
      );
      initialized.set(worker, job);
    }
    if (options.accumulate) {
      await exchange(worker, { kind: "scan", files: job.files }, "scanned");
      return;
    }
    return (await exchange(worker, { kind: "scan", files: job.files }, "scan")).result;
  };
  const cancel = () => {
    for (const worker of workers) void worker.terminate();
  };
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  let failure: unknown;
  try {
    for (let index = 0; index < Math.min(options.capacity, jobs.length); index++)
      workers.push((options.createWorker ?? createCoverageWorker)());
    const outcomes = await Promise.allSettled(
      workers.map(async (worker) => {
        try {
          while (next < jobs.length) {
            signal.throwIfAborted();
            const index = next++;
            let job = jobs[index];
            if (!job) throw new Error("Missing coverage job");
            // Claim a bounded batch only when a worker becomes available; no worker owns a preassigned shard.
            if (job.kind === "scan" && options.consume && (options.scanBatchSize ?? 1) > 1) {
              const files = [...job.files];
              for (let count = 1; count < (options.scanBatchSize ?? 1); count++) {
                const candidate = jobs[next];
                if (
                  candidate?.kind !== "scan" ||
                  candidate.directory !== job.directory ||
                  candidate.root !== job.root ||
                  candidate.candidates !== job.candidates
                )
                  break;
                files.push(...candidate.files);
                next++;
              }
              job = { ...job, files };
            }
            const selected = job;
            await admittedWork(options.admission, signal, async () => {
              const result = await execute(worker, selected);
              if (selected.kind === "scan" && options.consume) {
                if (!options.accumulate) options.consume(result as ScannedCoverage);
              } else {
                if (!result) throw new Error("Coverage result is missing");
                results[index] = result;
              }
            });
          }
          const context = initialized.get(worker);
          if (context && options.accumulate && options.consume)
            await admittedWork(options.admission, signal, async () => {
              options.consume?.((await exchange(worker, { kind: "finish" }, "finish")).result);
            });
        } catch (error) {
          scope.abort(error);
          throw error;
        }
      }),
    );
    options.signal?.throwIfAborted();
    const failures = outcomes.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    if (failures.length) throw scope.signal.reason ?? failures[0];
    if (!options.consume) return results;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    await settleCleanup(
      workers.map((worker) => async () => {
        await worker.terminate();
      }),
      failure,
    );
  }
}
