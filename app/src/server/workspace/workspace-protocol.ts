import type { DiagnosticError } from "../../core/diagnostics/diagnostics.mjs";
import type { WorkspaceSnapshot } from "./workspace-service.js";
export const WorkspaceRequest = { Refresh: "refresh", Fresh: "fresh", Close: "close" } as const;
export type WorkspaceRequest = (typeof WorkspaceRequest)[keyof typeof WorkspaceRequest] | { changed: string[] };
export type WorkspaceResponse = (
  | { ok: true; snapshot: WorkspaceSnapshot }
  | { ok: true; unchanged: { revision: string; collectedAt: string } }
  | { ok: false; status: 400 | 403 | 404 | 406 | 409 | 413 | 500 | 503; error: DiagnosticError }
) & {
  cache?: { captureReused: boolean; publicationReused: boolean };
  timings?: { collect: number; formatting: number };
};
