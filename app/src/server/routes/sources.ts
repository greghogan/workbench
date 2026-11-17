import type { WorkspaceView } from "../workspace/workspace-service.js";
import { projectPath } from "./project-paths.js";
import type { SourceQuery } from "./routes.js";
type Source = Pick<WorkspaceView, "scope" | "selection" | "all">;
export function sourceQuery(context: Source): SourceQuery {
  return context.all
    ? { all: "1" }
    : context.selection
      ? { collection: context.selection }
      : context.scope
        ? { scope: context.scope }
        : {};
}
export function sourceURL(context: Source, path: string): string {
  const url = new URL(path, "http://localhost");
  for (const key of ["all", "collection", "scope"]) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(sourceQuery(context)))
    if (typeof value === "string") url.searchParams.set(key, value);
  return projectPath(url.pathname + url.search);
}
