import { CompatibilityDecision } from "../../core/collections/policy-findings.js";
import { WebAction } from "../../core/diagnostics/diagnostics.mjs";
import { decodePresentedReview } from "../../core/review/review-snapshot.js";
import type { PresentedReview } from "../../core/review/review-service.js";
import { InvalidInput } from "../../core/runtime/input-errors.js";
import { validation, type Validation } from "../../core/runtime/validation.js";

export type ReviewRequest = { root: string } & (
  | { operation: typeof WebAction.ReviewPrepare; path: string }
  | { operation: typeof WebAction.Review; version: PresentedReview; digest: string; humanWritten: boolean }
  | {
      operation: typeof WebAction.PolicyResolution;
      policyDigest: string;
      finding: string;
      outcome: CompatibilityDecision;
    }
);
export function decodeReviewRequest(value: unknown): ReviewRequest {
  const check: Validation = validation("Invalid review worker request", (message) => new InvalidInput(message));
  check(value && typeof value === "object", "request", "must be an object");
  check(
    "root" in value && typeof value.root === "string" && value.root.length > 0 && !value.root.includes("\0"),
    "root",
    "must be a nonempty path",
  );
  check("operation" in value, "operation", "is required");
  const root = value.root;
  const fields = (...allowed: string[]) => {
    for (const field of Object.keys(value))
      check(
        field === "root" || field === "operation" || allowed.includes(field),
        field,
        "is not allowed for this operation",
      );
  };
  switch (value.operation) {
    case WebAction.ReviewPrepare:
      fields("path");
      check(
        "path" in value &&
          typeof value.path === "string" &&
          value.path.length > 0 &&
          value.path.length <= 4096 &&
          !value.path.includes("\0"),
        "path",
        "must identify a protected record",
      );
      return { root, operation: value.operation, path: value.path };
    case WebAction.Review:
      fields("version", "digest", "humanWritten");
      check(
        "digest" in value && typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest),
        "digest",
        "must be a SHA-256 digest",
      );
      check("humanWritten" in value && typeof value.humanWritten === "boolean", "humanWritten", "must be a boolean");
      check("version" in value, "version", "is required");
      return {
        root,
        operation: value.operation,
        version: decodePresentedReview(value.version),
        digest: value.digest,
        humanWritten: value.humanWritten,
      };
    case WebAction.PolicyResolution: {
      fields("policyDigest", "finding", "outcome");
      check(
        "policyDigest" in value && typeof value.policyDigest === "string" && /^[a-f0-9]{64}$/.test(value.policyDigest),
        "policyDigest",
        "must be a SHA-256 digest",
      );
      check(
        "finding" in value && typeof value.finding === "string" && /^[a-f0-9]{64}$/.test(value.finding),
        "finding",
        "must be a SHA-256 digest",
      );
      check("outcome" in value, "outcome", "is required");
      const outcome = Object.values(CompatibilityDecision).find((outcome) => outcome === value.outcome);
      check(outcome, "outcome", "must be a compatibility decision");
      return { root, operation: value.operation, policyDigest: value.policyDigest, finding: value.finding, outcome };
    }
    default:
      check(false, "operation", "is unknown");
      throw new InvalidInput("Unknown review operation");
  }
}
