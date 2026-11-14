import { isUtf8 } from "node:buffer";
import { recordPane } from "./record-pane.js";
import { committedReview, commitVersion, pendingCommitReviews } from "../../core/review/review-units.js";
import { presentedReviewDigest, reviewedBaselines, reviewFileContents } from "../../core/review/review-service.js";
import { sourceDiffView, fileModeChange } from "./diff-view.js";
import { panel, submitButton, badge } from "./components.js";
import { markdown } from "./markdown-view.js";
import { shell } from "./page-frame.js";
import { mutationForm } from "./action-forms.js";
import { routeURL } from "../routes/locations.js";
import { sourceURL } from "../routes/sources.js";
import { diffLayout } from "./render-links.js";
import { Route, type RouteQuery } from "../routes/routes.js";
import type { ViewContext } from "../workspace/view-context.js";
import type { ReviewVersions } from "../review/review-versions.js";
import { WebError } from "../http/errors.js";

export function historyPage(
  context: ViewContext,
  query: RouteQuery<typeof Route.History>,
  versions: ReviewVersions,
): string {
  if (!query.commit) {
    const units = pendingCommitReviews(context.root);
    return shell(
      context,
      "Commit reviews",
      "review",
      <>
        {units.length ? (
          units.map((unit) => (
            <article class="panel" key={unit.revision}>
              <h2>
                <a href={sourceURL(context, routeURL(Route.History, { commit: unit.revision }))}>
                  {unit.message.split("\n")[0]}
                </a>
              </h2>
              <p>
                <code>{unit.revision.slice(0, 12)}</code> · {String(unit.pending)} pending /{" "}
                {String(unit.changes.length)} files
              </p>
            </article>
          ))
        ) : (
          <p class="empty">No provisional commits.</p>
        )}
      </>,
    );
  }
  const unit = committedReview(context.root, query.commit),
    split = query.layout === "split",
    candidates = unit.changes.filter((change) => !change.approved),
    change = query.path ? unit.changes.find((change) => change.path === query.path) : candidates[0];
  const title = unit.message.split("\n")[0] ?? unit.revision.slice(0, 12);
  if (query.path && !change) throw new WebError(404, "Protected file not found in this commit");
  const parent = unit.parents[0] ? commitVersion(context.root, unit.parents[0]) : undefined;
  if (!change)
    return shell(
      context,
      title,
      "review",
      <>
        <p>No pending protected files in this commit.</p>
        <a class="button" href={sourceURL(context, routeURL(Route.History, {}))}>
          Commit reviews
        </a>
      </>,
    );
  const before = reviewFileContents(context.root, change.before, unit.snapshot),
    after = reviewFileContents(context.root, change.after, unit.snapshot),
    binary = [before, after].some((bytes) => bytes !== undefined && (bytes.includes(0) || !isUtf8(bytes))),
    markdownFile = change.path.endsWith(".md") && !binary,
    record = { directory: context.root, path: change.path },
    base = sourceURL(context, routeURL(Route.History, { commit: unit.revision, path: change.path })),
    document = { error: "", before: before?.toString("base64") ?? null, after: after?.toString("base64") ?? null };
  const digest = presentedReviewDigest(change, unit.head);
  versions.retainBatch([{ change, document, downloadBefore: !markdownFile }], unit.head);
  const reviewed = reviewedBaselines(context.root, unit.head).get(change.path);
  const selected = candidates.findIndex((item) => item.path === change.path),
    label = !after ? "Confirm deletion" : !before ? "Confirm new file" : "Confirm changes",
    mode = fileModeChange(change.before.split(":")[0], change.after.split(":")[0]);
  return shell(
    context,
    title,
    "review",
    <>
      <p>
        <code>{unit.revision.slice(0, 12)}</code>
        {parent && (
          <>
            {" "}
            · parent <code>{parent.revision.slice(0, 12)}</code>
          </>
        )}{" "}
        · {String(unit.pending)} pending / {String(unit.changes.length)} files
      </p>
      <p class="muted">
        File {String(selected + 1)} of {String(candidates.length)}
      </p>
      <p class="file-path">
        {change.path} {!before ? badge("New file", "pending") : !after ? badge("Deleted file", "pending") : null}
      </p>
      {mode && <p>{mode}</p>}
      {recordPane(
        panel(
          markdownFile ? (
            before && after ? (
              sourceDiffView(
                { patch: "", before: reviewed?.contents ?? before.toString(), after: after.toString() },
                { record, records: context.index.references },
                split,
              )
            ) : (
              markdown((after ?? before)?.toString() ?? "", record, context.index.references)
            )
          ) : (
            <pre class="source">
              {binary ? "Binary file: download and inspect it before review." : (after ?? before)?.toString()}
            </pre>
          ),
          { tools: markdownFile && before && after ? diffLayout(base, split) : null },
        ),
        {
          previous: candidates[selected - 1]
            ? {
                href: sourceURL(
                  context,
                  routeURL(Route.History, {
                    commit: unit.revision,
                    path: candidates[selected - 1]?.path ?? "",
                    layout: split ? "split" : "unified",
                  }),
                ),
              }
            : undefined,
          next: candidates[selected + 1]
            ? {
                href: sourceURL(
                  context,
                  routeURL(Route.History, {
                    commit: unit.revision,
                    path: candidates[selected + 1]?.path ?? "",
                    layout: split ? "split" : "unified",
                  }),
                ),
              }
            : undefined,
          label: "review file",
        },
      )}
      {!markdownFile && (
        <div class="actions">
          {before && (
            <a href={routeURL(Route.ReviewFile, { path: change.path, digest, side: "before" })}>
              Download previous file
            </a>
          )}
          {after && (
            <a href={routeURL(Route.ReviewFile, { path: change.path, digest, side: "after" })}>Download current file</a>
          )}
        </div>
      )}
      {!change.approved &&
        mutationForm({
          action: Route.Approve,
          context,
          csrf: context.csrf,
          class: "review-action",
          fields: {
            path: change.path,
            digest,
            review_commit: unit.revision,
            review_layout: split ? "split" : "unified",
            reviewed: "yes",
            human_written: change.charter ? "yes" : "no",
          },
          children: () => submitButton(label, { approve: true }),
        })}
    </>,
    { parents: [{ label: "Commit reviews", href: sourceURL(context, routeURL(Route.History, {})) }] },
  );
}
