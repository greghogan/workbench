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
export type CoverageTransportJob = (Omit<ScanJob, "candidates"> & { candidates?: CoverageCandidate[] }) | ConvertJob;
type CoverageResult = ScannedCoverage | Record<string, FileCoverageData>;
export type CoverageWorkerReply =
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
  const workers: Worker[] = [];
  const results: CoverageResult[] = new Array<CoverageResult>(options.consume ? 0 : jobs.length);
  const scope = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, scope.signal]) : scope.signal;
  let next = 0;
  const initialized = new WeakMap<Worker, ScanJob>();
  const execute = (worker: Worker, job: CoverageJob) =>
    new Promise<CoverageResult>((resolve, reject) => {
      const cleanup = () => {
        worker.off("message", message);
        worker.off("error", failure);
        worker.off("exit", exited);
      };
      const message = (reply: CoverageWorkerReply) => {
        cleanup();
        if (reply.kind === "error") {
          const diagnostic = reply.diagnostic;
          reject(
            diagnostic
              ? new InvalidNodeCoverageReport(diagnostic.file, diagnostic.bytes, diagnostic.reason)
              : new Error(reply.error),
          );
        } else if (reply.kind !== job.kind)
          reject(new Error(`Coverage worker returned ${reply.kind} for ${job.kind} job`));
        else resolve(reply.result);
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
        if (
          job.kind === "scan" &&
          initialized.get(worker)?.directory === job.directory &&
          initialized.get(worker)?.root === job.root &&
          initialized.get(worker)?.candidates === job.candidates
        ) {
          worker.postMessage({
            kind: job.kind,
            directory: job.directory,
            root: job.root,
            files: job.files,
          } satisfies CoverageTransportJob);
        } else {
          worker.postMessage(job);
          if (job.kind === "scan") initialized.set(worker, job);
        }
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error("Cannot dispatch coverage job", { cause: error }));
      }
    });
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
            const job = jobs[index];
            if (!job) throw new Error("Missing coverage job");
            await admittedWork(options.admission, signal, async () => {
              const result = await execute(worker, job);
              if (job.kind === "scan" && options.consume) options.consume(result as ScannedCoverage);
              else results[index] = result;
            });
          }
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
