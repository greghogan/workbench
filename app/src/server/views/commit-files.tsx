import { historyBlobSizes, historyPreviewBlobs, type HistoryFile } from "../../core/git/history.js";
import { fileContextLines, filePreviewByteLimit } from "../review/file-comparison.js";
import { WebError } from "../http/errors.js";
import { diffIcon } from "./diff-icons.js";
import { commitFileActions } from "./commit-file-actions.js";
import { Route, type RouteQuery } from "../routes/routes.js";
import type { ViewContext } from "../workspace/view-context.js";
import { badge } from "./components.js";
import { fileModeChange } from "./diff-view.js";
import { commitFileDiff } from "./commit-file-diff.js";
import { diffLayout } from "./render-links.js";
import { commitFileId } from "./commit-navigation.js";

const batchBudget = { files: 48, blobBytes: 256 * 1024, rows: 2000 };
interface DiffBatch {
  files: HistoryFile[];
  blobs: Set<string>;
}
const selections = new WeakMap<readonly HistoryFile[], ReturnType<typeof selectPreviews>>();

function blobIds(file: HistoryFile) {
  return [file.before, file.after].flatMap((entry) => (entry ? [entry.oid] : []));
}

/** Limit both Git reads and the cost of rendering many short or fragmented edits. */
function selectPreviews(root: string, changes: readonly HistoryFile[]) {
  const textFiles = changes.filter(
      (file) => file.additions !== null && file.before?.mode !== "160000" && file.after?.mode !== "160000",
    ),
    sizes = historyBlobSizes(root, [...new Set(textFiles.flatMap(blobIds))]),
    automatic = new Set<HistoryFile>();
  let batch: DiffBatch = { files: [], blobs: new Set() },
    bytes = 0,
    rows = 0;
  const batches = [batch];
  for (const file of textFiles) {
    const ids = [...new Set(blobIds(file))],
      fileBytes = ids.map((id) => sizes.get(id) ?? Infinity);
    if (fileBytes.some((size) => size > filePreviewByteLimit)) continue;
    const edits = (file.additions ?? 0) + (file.deletions ?? 0),
      context = file.before && file.after ? 2 * fileContextLines * edits : 0,
      estimatedRows = Math.min(batchBudget.rows, 1 + edits + context),
      addedBytes = ids.reduce((total, id, i) => total + (batch.blobs.has(id) ? 0 : (fileBytes[i] ?? 0)), 0);
    if (
      batch.files.length >= batchBudget.files ||
      rows + estimatedRows > batchBudget.rows ||
      bytes + addedBytes > batchBudget.blobBytes
    ) {
      batch = { files: [], blobs: new Set() };
      batches.push(batch);
      bytes = 0;
      rows = 0;
    }
    for (const [i, id] of ids.entries()) {
      if (batch.blobs.has(id)) continue;
      batch.blobs.add(id);
      bytes += fileBytes[i] ?? 0;
    }
    rows += estimatedRows;
    batch.files.push(file);
    automatic.add(file);
  }
  return { batches, automatic };
}

/** Source inspection is independent of record acknowledgment, including for Markdown files. */
export function inlineCommitFiles(
  context: ViewContext,
  query: RouteQuery<typeof Route.History>,
  changes: readonly HistoryFile[],
  revision: string,
  location: (values: RouteQuery<typeof Route.History>) => string,
) {
  const selection = selections.get(changes) ?? selectPreviews(context.root, changes);
  selections.set(changes, selection);
  const batchNumber = Number(query.batch ?? 0),
    batch = selection.batches[batchNumber];
  if (!batch || (query.batch !== undefined && (!/^\d+$/.test(query.batch) || batchNumber === 0)))
    throw new WebError(400, "Invalid file diff continuation");
  const split = query.layout === "split",
    contents = historyPreviewBlobs(context.root, [...batch.blobs], filePreviewByteLimit, batchBudget.blobBytes),
    rendered = new Set(batch.files),
    page = (values: RouteQuery<typeof Route.History>) =>
      location({ commit: revision, layout: split ? "split" : "unified", ...values }),
    next = selection.batches[batchNumber + 1] ? page({ batch: String(batchNumber + 1) }) : undefined,
    diff = (file: HistoryFile) =>
      commitFileDiff(file, file.before && contents.get(file.before.oid), file.after && contents.get(file.after.oid), {
        commit: revision,
        split,
        deferred: !rendered.has(file),
        automatic: !rendered.has(file) && selection.automatic.has(file),
        location: page,
      });
  if (query.batch !== undefined)
    return (
      <div data-file-diff-result={revision} data-file-diff-batch={next}>
        {batch.files.map(diff)}
      </div>
    );
  return (
    <section aria-label="Changed files">
      <div class="actions">{diffLayout(page({}), split)}</div>
      <div id="commit-file-list" data-commit={revision} data-file-diff-batch={next}>
        {changes.map((file) => {
          const mode = fileModeChange(file.before?.mode ?? "000000", file.after?.mode ?? "000000");
          return (
            <details
              class="panel commit-file"
              id={commitFileId(file.path)}
              data-commit-file={file.path}
              key={file.path}
              open
            >
              <summary class="commit-file-heading">
                {diffIcon("chevron")}
                <span class="commit-file-name">{file.path}</span>
                {file.additions !== undefined && file.additions !== null && (
                  <span class="diff-stat">
                    <span class="diff-count-added">+{String(file.additions)}</span>{" "}
                    <span class="diff-count-removed">−{String(file.deletions ?? 0)}</span>
                  </span>
                )}
                {!file.before ? badge("New file", "pending") : !file.after ? badge("Deleted file", "pending") : null}
              </summary>
              {commitFileActions(file, revision)}
              {mode && <p class="file-path">{mode}</p>}
              <div class="commit-file-body">
                {file.before?.mode === "160000" || file.after?.mode === "160000" ? (
                  <p>
                    Submodule reference:{" "}
                    <code>
                      {file.before?.oid ?? "absent"} → {file.after?.oid ?? "absent"}
                    </code>
                  </p>
                ) : (
                  diff(file)
                )}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
