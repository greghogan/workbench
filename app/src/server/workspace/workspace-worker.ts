import { PreparationState } from "../review/review-state.js";
import { workerFailure } from "../http/error-response.js";
import { parentPort } from "node:worker_threads";
import { diagnosticError } from "../../core/diagnostics/diagnostics.mjs";
import { performance } from "node:perf_hooks";
import { checkReviewFormatting } from "./review-preparation.js";
import { ReviewFormatter } from "../../core/review/review-formatting.js";
import { WorkspaceCollector } from "./workspace-service.js";
import { WorkspaceRequest, type WorkspaceResponse } from "./workspace-protocol.js";

/** One worker owns the disposable catalog and diff caches for the lifetime of the service. */
export function serveWorkspaceWorker(root: string): void {
  const port = parentPort;
  if (!port) throw new Error("workspace acquisition requires a worker port");
  const collector = new WorkspaceCollector(root);
  const formatter = new ReviewFormatter();
  let queued = Promise.resolve();
  let retryFormatting = false;
  let capture: ReturnType<WorkspaceCollector["collect"]> | undefined;
  let previous: ReturnType<WorkspaceCollector["collect"]> | undefined;
  port.on("message", (request: unknown) => {
    queued = queued.then(async () => {
      if (request === WorkspaceRequest.Close) {
        port.close();
        return;
      }
      const changed =
        request &&
        typeof request === "object" &&
        "changed" in request &&
        Array.isArray(request.changed) &&
        request.changed.length <= 256 &&
        request.changed.every((path: unknown) => typeof path === "string")
          ? request.changed
          : undefined;
      if (request !== WorkspaceRequest.Refresh && request !== WorkspaceRequest.Fresh && changed === undefined) {
        port.postMessage({
          ok: false,
          status: 500,
          error: diagnosticError(new Error("invalid workspace worker request")),
        } satisfies WorkspaceResponse);
        return;
      }
      try {
        const started = performance.now();
        const next = collector.collect(request === WorkspaceRequest.Fresh, changed);
        const captureReused = next === capture;
        const collected = performance.now();
        const snapshot =
          captureReused && previous && !retryFormatting ? previous : await checkReviewFormatting(next, formatter);
        const publicationReused = snapshot.revision === previous?.revision;
        const timings = { collect: collected - started, formatting: performance.now() - collected };
        const response: WorkspaceResponse = publicationReused
          ? { ok: true, unchanged: { revision: snapshot.revision, collectedAt: new Date().toISOString() } }
          : { ok: true, snapshot };
        port.postMessage({
          ...response,
          timings,
          cache: { captureReused, publicationReused },
        } satisfies WorkspaceResponse);
        capture = next;
        previous = snapshot;
        retryFormatting = [...snapshot.reviewPreparation.files.values()].some(
          (entry) => entry.state === PreparationState.Unavailable,
        );
      } catch (error) {
        port.postMessage({ ok: false, ...workerFailure(error) } satisfies WorkspaceResponse);
      }
    });
  });
}
