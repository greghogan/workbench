import { decideCompatibilityFinding } from "../../core/collections/policy-findings.js";
import { policyCompatibilityReceipt } from "../../core/collections/policy-compatibility.js";
import { Worker, parentPort } from "node:worker_threads";
import { join } from "node:path";
import { distributionRoot } from "../../core/projects/project-context.js";
import { combineFailures } from "../../core/diagnostics/diagnostic-errors.mjs";
import { approvePresentedReview } from "../../core/review/review-service.js";
import { decodeWorkerFailure, workerFailure } from "../http/error-response.js";
import { formatPendingReviews } from "../../core/review/review-formatting.js";

import { decodeReviewRequest, type ReviewRequest } from "./review-protocol.js";
import { WebAction } from "../../core/diagnostics/diagnostics.mjs";

/** A single admitted review operation owns its worker until exit, including after a client disconnect. */
export function runReviewWorker(request: ReviewRequest, bundle?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(bundle ?? join(distributionRoot(request.root), "bundle/main.cjs"), {
      workerData: { workbenchReview: request },
    });
    let received = false;
    let failure: Error | undefined;
    const failed = (error: unknown) => {
      const current = error instanceof Error ? error : new Error(String(error));
      failure = failure ? combineFailures(failure, current, "Review worker and result reporting failed") : current;
    };
    worker.on("message", (value: unknown) => {
      try {
        if (received) throw new Error("Repeated review worker result");
        received = true;
        if (!value || typeof value !== "object") throw new Error("Invalid review worker result");
        if ("error" in value) failure = decodeWorkerFailure(value);
        else if (!("ok" in value) || value.ok !== true) throw new Error("Invalid review worker result");
      } catch (error) {
        failed(error);
      }
    });
    worker.once("error", (error: Error) => {
      failed(error);
    });
    worker.once("exit", (code) => {
      if (failure) reject(failure);
      else if (code !== 0 || !received) reject(new Error(`Review worker stopped without a result (${String(code)})`));
      else resolve();
    });
  });
}

export async function serveReviewWorker(input: unknown): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error("review requires a worker port");
  try {
    const request = decodeReviewRequest(input);
    switch (request.operation) {
      case WebAction.ReviewPrepare:
        await formatPendingReviews(request.root, join(request.root, request.path));
        break;
      case WebAction.Review:
        approvePresentedReview(request.root, request.version, request.digest, request.humanWritten);
        break;
      case WebAction.PolicyResolution:
        decideCompatibilityFinding(
          policyCompatibilityReceipt(request.root),
          request.policyDigest,
          request.finding,
          request.outcome,
        );
        break;
    }
    port.postMessage({ ok: true });
  } catch (error) {
    port.postMessage(workerFailure(error));
  } finally {
    port.close();
  }
}
