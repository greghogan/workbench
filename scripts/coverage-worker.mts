import { parentPort } from "node:worker_threads";
import { convertCoverageScript, CoverageAccumulator } from "./coverage-processing.mjs";
import { collectNodeCoverageBatch, InvalidNodeCoverageReport } from "./node-coverage-reports.mjs";
import { required } from "../app/src/core/runtime/values.mjs";
import { describeError } from "../app/src/core/diagnostics/diagnostic-errors.mjs";
import type { CoverageTransportJob, CoverageWorkerReply } from "./coverage-workers.mjs";

const port = required(parentPort, "Coverage worker requires an owning thread");
let context: { directory: string; accumulator: CoverageAccumulator } | undefined;
port.on("message", (job: CoverageTransportJob) => {
  void (async () => {
    try {
      let reply: CoverageWorkerReply;
      switch (job.kind) {
        case "initialize":
          context = { directory: job.directory, accumulator: new CoverageAccumulator(job.root, job.candidates) };
          reply = { kind: "ready" };
          break;
        case "scan": {
          const reader = required(context, "Coverage scan context is unavailable");
          reply = {
            kind: "scan",
            result: collectNodeCoverageBatch(reader.directory, job, (report) => {
              reader.accumulator.add(report);
            }),
          };
          break;
        }
        case "finish":
          reply = { kind: "finish", result: required(context, "No accumulated scan to finish").accumulator.result() };
          context = undefined;
          break;
        case "convert":
          reply = { kind: "convert", result: await convertCoverageScript(job.script, job.execution) };
          break;
      }
      port.postMessage(reply);
    } catch (error) {
      port.postMessage({
        kind: "error",
        error: describeError(error),
        ...(error instanceof InvalidNodeCoverageReport ? { diagnostic: error.diagnostic } : {}),
      } satisfies CoverageWorkerReply);
    }
  })();
});
