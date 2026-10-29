import { parentPort } from "node:worker_threads";
import {
  scanCoverageReports,
  convertCoverageScript,
  CoverageSources,
  CoverageAccumulator,
  type CoverageCandidate,
} from "./coverage-processing.mjs";
import { InvalidNodeCoverageReport } from "./node-coverage-reports.mjs";
import { required } from "./values.mjs";
import { describeError } from "./diagnostic-errors.mjs";
import type { CoverageTransportJob, CoverageWorkerReply } from "./coverage-workers.mjs";
const port = required(parentPort, "Coverage worker requires an owning thread");
let context:
  | {
      root: string;
      directory: string;
      candidates: CoverageCandidate[];
      sources: CoverageSources;
      accumulated?: CoverageAccumulator;
    }
  | undefined;
port.on("message", (job: CoverageTransportJob) => {
  void (async () => {
    try {
      let reply: CoverageWorkerReply;
      switch (job.kind) {
        case "initialize": {
          const sources = new CoverageSources(job.candidates);
          context = {
            root: job.root,
            directory: job.directory,
            candidates: job.candidates,
            sources,
            ...(job.mode === "accumulate"
              ? { accumulated: new CoverageAccumulator(job.root, job.candidates, sources) }
              : {}),
          };
          reply = { kind: "ready" };
          break;
        }
        case "scan": {
          const selected = required(context, "Coverage scan context is unavailable");
          if (selected.accumulated) {
            selected.accumulated.scan(selected.directory, job.files);
            reply = { kind: "scanned" };
          } else
            reply = {
              kind: "scan",
              result: scanCoverageReports(
                selected.directory,
                selected.root,
                selected.candidates,
                job.files,
                selected.sources,
              ),
            };
          break;
        }
        case "finish":
          reply = { kind: "finish", result: required(context?.accumulated, "No accumulated scan to finish").result() };
          context = undefined;
          break;
        case "convert":
          reply = { kind: "convert", result: await convertCoverageScript(job.script) };
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
