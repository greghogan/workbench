import { parentPort } from "node:worker_threads";
import { scanCoverageReports, convertCoverageScript } from "./coverage-processing.mjs";
import { InvalidNodeCoverageReport } from "./node-coverage-reports.mjs";
import { required } from "./values.mjs";
import { errorMessage } from "./ci-results.mjs";
import type { CoverageJob, CoverageWorkerReply } from "./coverage-workers.mjs";

const port = required(parentPort, "Coverage worker requires an owning thread");
port.on("message", (job: CoverageJob) => {
  void (async () => {
    try {
      const result =
        job.kind === "scan"
          ? scanCoverageReports(job.directory, job.root, job.candidates, job.files)
          : await convertCoverageScript(job.script);
      port.postMessage({ result } satisfies CoverageWorkerReply);
    } catch (error) {
      port.postMessage({
        error: errorMessage(error),
        ...(error instanceof InvalidNodeCoverageReport ? { diagnostic: error.diagnostic } : {}),
      } satisfies CoverageWorkerReply);
    }
  })();
});
