import { parentPort } from "node:worker_threads";
import { scanCoverageReports, convertCoverageScript, CoverageSources } from "./coverage-processing.mjs";
import { InvalidNodeCoverageReport } from "./node-coverage-reports.mjs";
import { required } from "./values.mjs";
import { describeError } from "./diagnostic-errors.mjs";
import type { CoverageTransportJob, CoverageWorkerReply } from "./coverage-workers.mjs";

const port = required(parentPort, "Coverage worker requires an owning thread");
let context:
  | {
      root: string;
      directory: string;
      candidates: import("./coverage-processing.mjs").CoverageCandidate[];
      sources: CoverageSources;
    }
  | undefined;
port.on("message", (job: CoverageTransportJob) => {
  void (async () => {
    try {
      if (job.kind === "scan") {
        if (job.candidates)
          context = {
            root: job.root,
            directory: job.directory,
            candidates: job.candidates,
            sources: new CoverageSources(job.candidates),
          };
        if (context?.root !== job.root || context.directory !== job.directory)
          throw new Error("Coverage scan context is unavailable or mismatched");
        port.postMessage({
          kind: "scan",
          result: scanCoverageReports(job.directory, job.root, context.candidates, job.files, context.sources),
        } satisfies CoverageWorkerReply);
      } else
        port.postMessage({
          kind: "convert",
          result: await convertCoverageScript(job.script),
        } satisfies CoverageWorkerReply);
    } catch (error) {
      port.postMessage({
        kind: "error",
        error: describeError(error),
        ...(error instanceof InvalidNodeCoverageReport ? { diagnostic: error.diagnostic } : {}),
      } satisfies CoverageWorkerReply);
    }
  })();
});
