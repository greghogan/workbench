import type { HistoryFile } from "../../core/git/history.js";
import { Route, type RouteQuery } from "../routes/routes.js";
import { historyComparison } from "./history-comparison.js";

export function commitFileDiff(
  file: HistoryFile,
  before: Buffer | undefined,
  after: Buffer | undefined,
  options: {
    commit: string;
    split: boolean;
    context?: string;
    loaded?: boolean;
    deferred?: boolean;
    automatic?: boolean;
    location: (query: RouteQuery<typeof Route.History>) => string;
  },
) {
  const tooLarge = (!!file.before && !before) || (!!file.after && !after),
    location = (context?: string) =>
      options.location({
        commit: options.commit,
        path: file.path,
        layout: options.split ? "split" : "unified",
        load: "1",
        ...(context ? { context } : {}),
      });
  return (
    <div data-file-diff="" data-file-path={file.path} data-file-commit={options.commit}>
      {file.additions === null ? (
        <p class="notice">Binary file: download and inspect it.</p>
      ) : options.deferred || (tooLarge && !options.loaded) ? (
        <div class="diff-placeholder">
          <a
            class="button secondary"
            data-file-diff-link=""
            data-file-diff-auto={options.automatic ? "" : undefined}
            href={location()}
          >
            Load diff
          </a>
        </div>
      ) : (
        historyComparison(before, after, {
          purpose: "file",
          path: file.path,
          split: options.split,
          tooLarge,
          ...(options.context ? { context: options.context } : {}),
          location,
        })
      )}
    </div>
  );
}
