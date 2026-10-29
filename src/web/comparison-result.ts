import type { SourceDifference } from "./diff.js";
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
