import type { WorkspaceView } from "../workspace-service.js";
import { projectPath } from "./project-paths.js";
export function sourceURL(context: WorkspaceView, path: string): string {
  const url = new URL(path, "http://localhost");
  for (const key of ["all", "collection", "scope"]) url.searchParams.delete(key);
  if (context.all) url.searchParams.set("all", "1");
  else if (context.selection) url.searchParams.set("collection", context.selection);
  else if (context.scope) url.searchParams.set("scope", context.scope);
  return projectPath(url.pathname + url.search);
}
