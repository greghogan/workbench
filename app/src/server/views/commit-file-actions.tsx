import type { HistoryFile } from "../../core/git/history.js";
import { routeURL } from "../routes/locations.js";
import { Route } from "../routes/routes.js";

export function commitFileActions(file: HistoryFile, commit: string) {
  if (file.before?.mode === "160000" || file.after?.mode === "160000") return null;
  return (
    <details class="commit-file-actions">
      <summary aria-label={`File actions: ${file.path}`}>
        <span aria-hidden="true">⋯</span>
      </summary>
      <div>
        {file.before && (
          <a href={routeURL(Route.HistoryFile, { commit, path: file.path, side: "before" })}>Download previous file</a>
        )}
        {file.after && (
          <a href={routeURL(Route.HistoryFile, { commit, path: file.path, side: "after" })}>Download current file</a>
        )}
      </div>
    </details>
  );
}
