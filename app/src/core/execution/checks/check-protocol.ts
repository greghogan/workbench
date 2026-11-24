import { diagnosticError, restoreDiagnosticError, type DiagnosticError } from "../../diagnostics/diagnostics.mjs";
export const CheckMessage = {
  Ready: "workbench-check-ready",
  Start: "workbench-check-start",
  Cancel: "workbench-check-cancel",
  Failure: "workbench-check-failure",
  LogError: "workbench-check-log-error",
  Logs: "workbench-check-logs",
  BuildProducts: "workbench-check-build-products",
} as const;
export type CheckWorkerMessage =
  | { type: typeof CheckMessage.Ready | typeof CheckMessage.Start | typeof CheckMessage.Cancel }
  | { type: typeof CheckMessage.Failure | typeof CheckMessage.LogError; error: DiagnosticError }
  | { type: typeof CheckMessage.BuildProducts; products: [string, string][] }
  | { type: typeof CheckMessage.Logs; directory: string; files: string[]; errors: DiagnosticError[] };
export function readCheckMessage(value: unknown): CheckWorkerMessage | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return;
  switch (value.type) {
    case CheckMessage.Ready:
    case CheckMessage.Start:
    case CheckMessage.Cancel:
      return { type: value.type };
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
