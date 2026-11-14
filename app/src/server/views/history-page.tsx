import { isUtf8 } from "node:buffer";
import { historyFiles, historyFile, historyText } from "../../core/git/history.js";
import { historicalRecords } from "../review/historical-records.js";
import { recordPane } from "./record-pane.js";
import { committedReview } from "../../core/review/review-units.js";
import { presentedReviewDigest, reviewedBaselines } from "../../core/review/review-service.js";
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
import { commitReviewContext } from "./commit-review-context.js";
import { WebError } from "../http/errors.js";
import { codeDifference } from "./code-difference.js";

interface TaskHistoryContext {
  location: (values: RouteQuery<typeof Route.History>) => string;
  parents: { label: string; href: string }[];
}

export function historyPage(
  context: ViewContext,
  query: RouteQuery<typeof Route.History>,
  versions: ReviewVersions,
  task?: TaskHistoryContext,
): string {
  const location =
    task?.location ??
    ((values: RouteQuery<typeof Route.History>) => sourceURL(context, routeURL(Route.History, values)));
  if (!query.commit) throw new WebError(400, "Select a commit from its task or document review");
  const unit = committedReview(context.root, query.commit),
    files = historyFiles(context.root, unit.revision),
    split = query.layout === "split",
    pendingPaths = new Set(context.commitReviews.find((item) => item.revision === unit.revision)?.paths),
    candidates = unit.provisional
      ? unit.changes.filter((change) => !change.approved && pendingPaths.has(change.path))
      : [],
    selectedPath = query.path ?? (task ? undefined : candidates[0]?.path),
    title = unit.message.split("\n")[0] ?? unit.revision.slice(0, 12),
    messageBody = unit.message
      .replace(/^.*\n?/, "")
      .replace(/^Workbench-Provisional: true\s*$/m, "")
      .trim(),
    fileList = (
      <details open={!selectedPath}>
        <summary>{String(files.changes.length)} changed files</summary>
        <ul class="commit-files">
          {files.changes.map((file) => (
            <li key={file.path}>
              <a href={location({ commit: unit.revision, path: file.path, layout: split ? "split" : "unified" })}>
                {file.path}
              </a>
            </li>
          ))}
        </ul>
      </details>
    ),
    commitHeading = (
      <section class="panel">
        <div class="panel-body">
          <p class="muted">
            <code>{unit.revision.slice(0, 12)}</code>
            {" · "}
            {unit.author.replace(/ \d+ [+-]\d{4}$/, "")}
          </p>
          {messageBody && (
            <pre class="source" aria-label="Commit message">
              {messageBody}
            </pre>
          )}
          {fileList}
        </div>
      </section>
    );
  if (!selectedPath)
    return shell(context, title, task ? "queue" : "review", commitHeading, {
      parents: task?.parents ?? [{ label: "Review queue", href: sourceURL(context, routeURL(Route.Review, {})) }],
    });
  const file = historyFile(context.root, unit.revision, selectedPath, files),
    change = unit.changes.find((change) => change.path === selectedPath),
    before = historyText(context.root, file.before),
    after = historyText(context.root, file.after),
    tooLarge = (!!file.before && before === undefined) || (!!file.after && after === undefined),
    binary = [before, after].some((bytes) => bytes !== undefined && (bytes.includes(0) || !isUtf8(bytes))),
    markdownFile = selectedPath.endsWith(".md") && !binary && !tooLarge,
    historical = historicalRecords(
      context.root,
      after ? unit.revision : (unit.parents[0] ?? unit.revision),
      after ? files.logicalAfter : files.logicalBefore,
    ),
    owner =
      historical.references.path(`${context.root}/${selectedPath}`) ??
      historical.references.owner(`${context.root}/${selectedPath}`),
    record = {
      directory: context.root,
      path: selectedPath,
      ...(owner ? { scope: owner.scope, type: owner.type } : {}),
      history: {
        commit: after ? unit.revision : (unit.parents[0] ?? unit.revision),
        paths: historical.paths,
        ...(task ? { location: (path: string) => location({ commit: unit.revision, path }) } : {}),
      },
    },
    base = location({ commit: unit.revision, path: selectedPath }),
    reviewing =
      !task && !!change && unit.provisional && !change.approved && pendingPaths.has(selectedPath) && !tooLarge,
    reviewed = !task && change ? reviewedBaselines(context.root, unit.head).get(selectedPath) : undefined;
  const digest = change ? presentedReviewDigest(change, unit.head) : "";
  if (reviewing)
    versions.retainBatch(
      [
        {
          change,
          document: { error: "", before: before?.toString("base64") ?? null, after: after?.toString("base64") ?? null },
          downloadBefore: !markdownFile,
        },
      ],
      unit.head,
    );
  const list = reviewing ? candidates : files.changes,
    selected = list.findIndex((item) => item.path === selectedPath),
    previous = list[selected - 1],
    next = list[selected + 1],
    mode = fileModeChange(file.before?.mode ?? "000000", file.after?.mode ?? "000000"),
    same = file.before?.oid === file.after?.oid && file.before?.mode === file.after?.mode;
  return shell(
    context,
    reviewing ? (owner?.title ?? selectedPath) : title,
    reviewing ? "review" : "queue",
    <>
      {reviewing
        ? commitReviewContext(
            context.root,
            unit.revision,
            title,
            `File ${String(selected + 1)} of ${String(candidates.length)}`,
          )
        : commitHeading}
      <p class="file-path">
        {selectedPath}{" "}
        {!file.before ? badge("New file", "pending") : !file.after ? badge("Deleted file", "pending") : null}
      </p>
      {mode && <p>{mode}</p>}
      {recordPane(
        panel(
          markdownFile ? (
            before && after && !same ? (
              sourceDiffView(
                { patch: "", before: reviewed?.contents ?? before.toString(), after: after.toString() },
                { record, records: historical.references },
                split,
              )
            ) : (
              markdown((after ?? before)?.toString() ?? "", record, historical.references)
            )
          ) : tooLarge || binary ? (
            <p class="notice">
              {tooLarge
                ? "File exceeds the preview limit; download and inspect it."
                : "Binary file: download and inspect it before review."}
            </p>
          ) : (
            codeDifference(before?.toString(), after?.toString(), split)
          ),
          { tools: !tooLarge && !binary && before && after && !same ? diffLayout(base, split) : null },
        ),
        {
          previous: previous
            ? { href: location({ commit: unit.revision, path: previous.path, layout: split ? "split" : "unified" }) }
            : undefined,
          next: next
            ? { href: location({ commit: unit.revision, path: next.path, layout: split ? "split" : "unified" }) }
            : undefined,
          label: reviewing ? "review file" : "changed file",
        },
      )}
      {!markdownFile && (
        <div class="actions">
          {file.before && (
            <a href={routeURL(Route.HistoryFile, { commit: unit.revision, path: selectedPath, side: "before" })}>
              Download previous file
            </a>
          )}
          {file.after && (
            <a href={routeURL(Route.HistoryFile, { commit: unit.revision, path: selectedPath, side: "after" })}>
              Download current file
            </a>
          )}
        </div>
      )}
      {reviewing &&
        mutationForm({
          action: Route.Approve,
          context,
          csrf: context.csrf,
          class: "review-action",
          fields: {
            path: selectedPath,
            digest,
            review_commit: unit.revision,
            review_layout: split ? "split" : "unified",
            reviewed: "yes",
            human_written: change.charter ? "yes" : "no",
          },
          children: () =>
            submitButton(!file.after ? "Confirm deletion" : !file.before ? "Confirm new file" : "Confirm changes", {
              approve: true,
            }),
        })}
    </>,
    {
      parents: task
        ? task.parents
        : reviewing
          ? [{ label: "Review queue", href: sourceURL(context, routeURL(Route.Review, {})) }]
          : [{ label: "Review queue", href: sourceURL(context, routeURL(Route.Review, {})) }],
    },
  );
}
