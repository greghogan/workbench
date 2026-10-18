import type { FileSummary } from "./coverage-summary.mjs";
import { isRecord } from "./values.mjs";

export const checkDetailPrefix = "WORKBENCH_CHECK_DETAIL\t";
export type CheckDetail =
  | { version: 1; kind: "coverage-unavailable"; root: string; reason: string }
  | {
      version: 1;
      kind: "coverage";
      root: string;
      revision: string;
      current: FileSummary;
      baseline?: FileSummary;
      notice?: string;
    }
  | {
      version: 1;
      kind: "slow";
      scope: "suite" | "test";
      name: string;
      elapsedSeconds: number;
      thresholdSeconds: number;
    };

function metrics(value: unknown): value is FileSummary {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([key, entry]) =>
        ["lines", "statements", "functions", "branches"].includes(key) &&
        isRecord(entry) &&
        ["total", "covered", "skipped"].every(
          (name) => typeof entry[name] === "number" && Number.isFinite(entry[name]) && entry[name] >= 0,
        ) &&
        (entry.pct === "Unknown" ||
          (typeof entry.pct === "number" && Number.isFinite(entry.pct) && entry.pct >= 0 && entry.pct <= 100)),
    )
  );
}

export function readCheckDetail(value: unknown): CheckDetail {
  if (!isRecord(value) || value.version !== 1) throw new Error("Invalid check detail version");
  if (value.kind === "coverage-unavailable" && typeof value.root === "string" && typeof value.reason === "string")
    return { version: 1, kind: "coverage-unavailable", root: value.root, reason: value.reason };
  if (
    value.kind === "coverage" &&
    typeof value.root === "string" &&
    typeof value.revision === "string" &&
    metrics(value.current) &&
    (value.baseline === undefined || metrics(value.baseline)) &&
    (value.notice === undefined || typeof value.notice === "string")
  ) {
    return {
      version: 1,
      kind: "coverage",
      root: value.root,
      revision: value.revision,
      current: value.current,
      ...(value.baseline === undefined ? {} : { baseline: value.baseline }),
      ...(value.notice === undefined ? {} : { notice: value.notice }),
    };
  }
  if (
    value.kind === "slow" &&
    (value.scope === "suite" || value.scope === "test") &&
    typeof value.name === "string" &&
    typeof value.elapsedSeconds === "number" &&
    Number.isFinite(value.elapsedSeconds) &&
    value.elapsedSeconds >= 0 &&
    typeof value.thresholdSeconds === "number" &&
    Number.isFinite(value.thresholdSeconds) &&
    value.thresholdSeconds > 0
  )
    return {
      version: 1,
      kind: "slow",
      scope: value.scope,
      name: value.name,
      elapsedSeconds: value.elapsedSeconds,
      thresholdSeconds: value.thresholdSeconds,
    };
  throw new Error("Invalid structured check detail");
}

export function emitCheckDetail(detail: CheckDetail): void {
  if (process.env.WORKBENCH_CHECK_DETAILS === "1") console.log(`${checkDetailPrefix}${JSON.stringify(detail)}`);
}
