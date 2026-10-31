import { workerFailure } from "./error-response.js";
import { parentPort } from "node:worker_threads";
import { diagnosticError } from "../diagnostics.js";
import { WorkspaceCollector } from "../workspace-service.js";
import { WorkspaceRequest, type WorkspaceResponse } from "./workspace-protocol.js";

/** One worker owns the disposable catalog and diff caches for the lifetime of the service. */
export function serveWorkspaceWorker(root: string): void {
  const port = parentPort;
  if (!port) throw new Error("workspace acquisition requires a worker port");
  const collector = new WorkspaceCollector(root);
  let previous: ReturnType<WorkspaceCollector["collect"]> | undefined;
  port.on("message", (request: unknown) => {
    if (request === WorkspaceRequest.Close) {
      port.close();
      return;
    }
    if (request !== WorkspaceRequest.Refresh && request !== WorkspaceRequest.Fresh) {
      port.postMessage({
        ok: false,
        status: 500,
        error: diagnosticError(new Error("invalid workspace worker request")),
      } satisfies WorkspaceResponse);
      return;
    }
    try {
      const snapshot = collector.collect(request === WorkspaceRequest.Fresh);
      const response: WorkspaceResponse =
        snapshot === previous
          ? { ok: true, unchanged: { revision: snapshot.revision, collectedAt: new Date().toISOString() } }
          : { ok: true, snapshot };
      port.postMessage(response);
      previous = snapshot;
    } catch (error) {
      port.postMessage({ ok: false, ...workerFailure(error) } satisfies WorkspaceResponse);
    }
  });
}
