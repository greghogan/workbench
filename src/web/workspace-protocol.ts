import type { DiagnosticError } from "../diagnostics.js";
import type { WorkspaceSnapshot } from "../workspace-service.js";
export const WorkspaceRequest = { Refresh: "refresh", Close: "close" } as const;
export type WorkspaceRequest = (typeof WorkspaceRequest)[keyof typeof WorkspaceRequest];
export type WorkspaceResponse =
  | { ok: true; snapshot: WorkspaceSnapshot }
  | { ok: false; status: 400 | 403 | 404 | 409 | 413 | 500 | 503; error: DiagnosticError };
