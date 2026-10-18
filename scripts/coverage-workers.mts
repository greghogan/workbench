import { Worker } from "node:worker_threads";
import { InvalidNodeCoverageReport } from "./node-coverage-reports.mjs";
import type { MeasuredScript, ScannedCoverage } from "./coverage-processing.mjs";
import type { FileCoverageData } from "istanbul-lib-coverage";
import { positiveInteger } from "./cpu-budget.mjs";

export type CoverageJob =
  | { kind: "scan"; directory: string; root: string; candidates: MeasuredScript[]; files: string[] }
  | { kind: "convert"; script: MeasuredScript };
type Result<T extends CoverageJob> = T extends { kind: "scan" } ? ScannedCoverage : Record<string, FileCoverageData>;
export type CoverageWorkerReply =
  | { result: ScannedCoverage | Record<string, FileCoverageData> }
  | { error: string; diagnostic?: InvalidNodeCoverageReport["diagnostic"] };

/** A bounded phase owns its workers and drains them before returning or removing raw inputs. */
export async function coverageJobs<T extends CoverageJob>(jobs: T[], limit: number): Promise<Result<T>[]> {
  positiveInteger(limit, "coverage workers");
  const workers: Worker[] = [];
  const results: Result<T>[] = new Array<Result<T>>(jobs.length);
  let next = 0;
  const execute = (worker: Worker, job: T) =>
    new Promise<Result<T>>((resolve, reject) => {
      const cleanup = () => {
        worker.off("message", message);
        worker.off("error", failure);
        worker.off("exit", exited);
      };
      const message = (reply: CoverageWorkerReply) => {
        cleanup();
        if ("error" in reply) {
          const diagnostic = reply.diagnostic;
          reject(
            diagnostic
              ? new InvalidNodeCoverageReport(diagnostic.file, diagnostic.bytes, diagnostic.reason)
              : new Error(reply.error),
          );
        } else resolve(reply.result as Result<T>);
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
        worker.postMessage(job);
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error("Cannot dispatch coverage job", { cause: error }));
      }
    });
  try {
    for (let index = 0; index < Math.min(limit, jobs.length); index++)
      workers.push(new Worker(new URL("./coverage-worker.mjs", import.meta.url)));
    await Promise.all(
      workers.map(async (worker) => {
        while (next < jobs.length) {
          const index = next++;
          const job = jobs[index];
          if (!job) throw new Error("Missing coverage job");
          results[index] = await execute(worker, job);
        }
      }),
    );
    return results;
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}
