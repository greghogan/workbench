import type { SourceDifference } from "./diff.js";
export type ReviewBaseline = { kind: "new" } | { kind: "commit" } | { kind: "review"; approvedAt: string };
export const hasReviewBaseline = (baseline: ReviewBaseline): boolean => baseline.kind !== "new";

export type ComparisonResult =
  | { state: "available"; difference: SourceDifference | null }
  | { state: "unavailable"; difference: null; problem: string };
export function acquireComparison(read: () => SourceDifference | null): ComparisonResult {
  try {
    return { state: "available", difference: read() };
  } catch (error) {
    return { state: "unavailable", difference: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

export const comparisonChanged = (result: ComparisonResult): boolean =>
  result.state === "unavailable" ||
  (!!result.difference && (result.difference.before !== result.difference.after || result.difference.patch.length > 0));
