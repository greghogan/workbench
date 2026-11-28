import { diagnosticError, restoreDiagnosticError, type DiagnosticError } from "../../diagnostics/diagnostics.mjs";
import { isRecord } from "../../runtime/values.mjs";
import type { CheckPhase } from "./check-report.js";
import type { CheckIsolationGroup } from "./check-isolation.js";
import { createHash } from "node:crypto";
export const CheckWorkerPhase = {
  Plan: "Worker configuration",
  Tools: "Worker tool and environment selection",
  Prepare: "Worker dependency and build preparation",
  Isolate: "Worker isolated source preparation",
} as const;
export const CheckMessage = {
  Ready: "workbench-check-ready",
  Start: "workbench-check-start",
  Cancel: "workbench-check-cancel",
  Failure: "workbench-check-failure",
  LogError: "workbench-check-log-error",
  Logs: "workbench-check-logs",
  BuildProducts: "workbench-check-build-products",
  Phase: "workbench-check-phase",
} as const;
export type CheckWorkerMessage =
  | { type: typeof CheckMessage.Ready | typeof CheckMessage.Cancel }
  | { type: typeof CheckMessage.Failure | typeof CheckMessage.LogError; error: DiagnosticError }
  | { type: typeof CheckMessage.BuildProducts; products: [string, string][] }
  | { type: typeof CheckMessage.Phase; phase: CheckPhase }
  | { type: typeof CheckMessage.Logs; directory: string; files: string[]; errors: DiagnosticError[] };
export function readCheckMessage(value: unknown): CheckWorkerMessage | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return;
  switch (value.type) {
    case CheckMessage.Ready:
    case CheckMessage.Cancel:
      return { type: value.type };
    case CheckMessage.Phase: {
      if (!("phase" in value) || !isRecord(value.phase)) return;
      const { name, started, durationMs, status } = value.phase;
      if (
        typeof name !== "string" ||
        !Object.values<string>(CheckWorkerPhase).includes(name) ||
        typeof started !== "string" ||
        started.length !== 24 ||
        !Number.isFinite(Date.parse(started)) ||
        typeof durationMs !== "number" ||
        !Number.isFinite(durationMs) ||
        durationMs < 0 ||
        (status !== "passed" && status !== "failed")
      )
        return;
      return { type: value.type, phase: { name, started, durationMs, status } };
    }
    case CheckMessage.Failure:
    case CheckMessage.LogError:
      if (!("error" in value)) return;
      return { type: value.type, error: diagnosticError(restoreDiagnosticError(value.error)) };
    case CheckMessage.BuildProducts: {
      if (!("products" in value) || !Array.isArray(value.products) || value.products.length > 10000) return;
      const products: [string, string][] = [];
      for (const entry of value.products as unknown[]) {
        if (!Array.isArray(entry) || entry.length !== 2) return;
        const [key, digest] = entry as unknown[];
        if (
          typeof key !== "string" ||
          typeof digest !== "string" ||
          !/^[0-9a-f]{64}$/.test(key) ||
          !/^[0-9a-f]{64}$/.test(digest)
        )
          return;
        products.push([key, digest]);
      }
      return { type: value.type, products };
    }
    case CheckMessage.Logs: {
      if (
        !("directory" in value) ||
        typeof value.directory !== "string" ||
        value.directory.length > 32768 ||
        !("files" in value) ||
        !Array.isArray(value.files) ||
        value.files.length > 10000 ||
        !value.files.every(
          (file: unknown) => typeof file === "string" && /^step-\d+\.[A-Za-z0-9]{4,12}(?:\.zst)?$/.test(file),
        ) ||
        !("errors" in value) ||
        !Array.isArray(value.errors) ||
        value.errors.length > 32
      )
        return;
      return {
        type: value.type,
        directory: value.directory,
        files: value.files as string[],
        errors: value.errors.map((error: unknown) => diagnosticError(restoreDiagnosticError(error))),
      };
    }
    default:
      return;
  }
}

export function checkAdmissionDigest(groups: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(groups)).digest("hex");
}

/** The admitted manifest must match the coordinator's independent command-line identity. */
export function readCheckAdmission(value: unknown, expected: string | undefined): CheckIsolationGroup[] | undefined {
  if (!isRecord(value) || value.type !== CheckMessage.Start) return;
  if (!Array.isArray(value.isolationGroups) || checkAdmissionDigest(value.isolationGroups) !== expected)
    throw new Error("Check worker admission does not match its isolation manifest");
  return value.isolationGroups as CheckIsolationGroup[];
}
