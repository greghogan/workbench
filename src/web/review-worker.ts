import { decideCompatibilityFinding, CompatibilityDecision } from "../policy-findings.js";
import { policyCompatibilityReceipt } from "../policy-compatibility.js";
import { Worker, parentPort } from "node:worker_threads";
import { join } from "node:path";
import { distributionRoot } from "../project-context.js";
import { approvePresentedReview, type PresentedReview } from "../review-service.js";
import { decodeWorkerFailure, workerFailure } from "./error-response.js";

export interface ResolutionRequest {
  root: string;
  resolution: { policy_digest: string; finding: string; outcome: CompatibilityDecision };
}
export interface ReviewRequest {
  root: string;
  version: PresentedReview;
  digest: string;
  humanWritten: boolean;
}

/** A single admitted approval owns its worker until exit, including after a client disconnect. */
export function runReviewWorker(request: ReviewRequest | ResolutionRequest, bundle?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(bundle ?? join(distributionRoot(request.root), "bundle/main.cjs"), {
      workerData: { workbenchReview: request },
    });
    let received = false;
    let failure: Error | undefined;
    worker.on("message", (value: unknown) => {
      try {
        if (received) throw new Error("Repeated review worker result");
        received = true;
        if (!value || typeof value !== "object") throw new Error("Invalid review worker result");
        if ("error" in value) failure = decodeWorkerFailure(value);
        else if (!("ok" in value) || value.ok !== true) throw new Error("Invalid review worker result");
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    });
    worker.once("error", (error: Error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      if (failure) reject(failure);
      else if (code !== 0 || !received) reject(new Error(`Review worker stopped without a result (${String(code)})`));
      else resolve();
    });
  });
}

export function serveReviewWorker(input: unknown): void {
  const port = parentPort;
  if (!port) throw new Error("review requires a worker port");
  try {
    if (input && typeof input === "object" && "resolution" in input) {
      if (
        !("root" in input) ||
        typeof input.root !== "string" ||
        !input.resolution ||
        typeof input.resolution !== "object"
      )
        throw new Error("Invalid compatibility resolution request");
      const value = input.resolution;
      if (
        !("policy_digest" in value) ||
        typeof value.policy_digest !== "string" ||
        !("finding" in value) ||
        typeof value.finding !== "string" ||
        !("outcome" in value) ||
        !Object.values(CompatibilityDecision).some((decision) => decision === value.outcome)
      )
        throw new Error("Invalid compatibility resolution request");
      decideCompatibilityFinding(
        policyCompatibilityReceipt(input.root),
        value.policy_digest,
        value.finding,
        value.outcome as CompatibilityDecision,
      );
      port.postMessage({ ok: true });
      return;
    }
    if (
      !input ||
      typeof input !== "object" ||
      !("root" in input) ||
      typeof input.root !== "string" ||
      !("version" in input) ||
      !("digest" in input) ||
      typeof input.digest !== "string" ||
      !("humanWritten" in input) ||
      typeof input.humanWritten !== "boolean"
    )
      throw new Error("Invalid review worker request");
    approvePresentedReview(input.root, input.version, input.digest, input.humanWritten);
    port.postMessage({ ok: true });
  } catch (error) {
    port.postMessage(workerFailure(error));
  } finally {
    port.close();
  }
}
