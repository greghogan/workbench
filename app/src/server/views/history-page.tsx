import { RecordLookup } from "../../core/records/record-lookup.js";
import { isUtf8 } from "node:buffer";
import { renderToString } from "preact-render-to-string";
import { historyFiles, historyFile, historyFilePreviews } from "../../core/git/history.js";
import { historicalRecords } from "../review/historical-records.js";
import { recordPane } from "./record-pane.js";
import { committedReview } from "../../core/review/review-units.js";
import { presentedReviewDigest, reviewedBaselines } from "../../core/review/review-service.js";
import { fileModeChange } from "./diff-view.js";
import { panel, submitButton, badge } from "./components.js";
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
import { historyComparison } from "./history-comparison.js";
import { commitFileDiff } from "./commit-file-diff.js";
import { commitFileId, commitNavigation } from "./commit-navigation.js";
import { commitFileActions } from "./commit-file-actions.js";
import { filePreviewByteLimit } from "../review/file-comparison.js";
import { inlineCommitFiles } from "./commit-files.js";
import { taskReviewFiles } from "../review/review-navigation.js";
import { taskReviewNeighbors, workflowParent, workflowRecordURL } from "./workflow-navigation.js";
import type { Breadcrumb } from "./breadcrumbs.js";

interface TaskHistoryContext {
  location: (values: RouteQuery<typeof Route.History>) => string;
  parents: Breadcrumb[];
  active: "plans" | "work" | "review" | "TSK";
}

export function historyPage(
  context: ViewContext,
  query: RouteQuery<typeof Route.History>,
  versions: ReviewVersions,
  task?: TaskHistoryContext,
): string {
  const location =
    task?.location ??
    ((values: RouteQuery<typeof Route.History>) =>
      sourceURL(
        context,
        routeURL(Route.History, {
          ...(query.view ? { view: query.view } : {}),
          ...(query.task ? { task: query.task } : {}),
          ...values,
        }),
      ));
  if (!query.commit) throw new WebError(400, "Select a commit from its task or document review");
  const reviews = workflowParent(context, Route.Reviews);
  const taskRecord = query.task ? context.index.byId.get(query.task) : undefined;
  const trail = task?.parents ?? [
    reviews,
    ...(taskRecord ? [{ label: taskRecord.title, href: workflowRecordURL(context, taskRecord.id, query.layout) }] : []),
  ];
  const taskFiles = query.task ? taskReviewFiles(context, query.task) : undefined;
  const taskFile = taskFiles?.find((file) => file.commit === query.commit && (!query.path || file.path === query.path));
  if (query.task) {
    if (query.view || query.batch || query.context || query.load) throw new WebError(400, "Select a file to review");
    if (!taskFile)
      throw new WebError(404, "This file is no longer pending review for the selected task", {
        recovery: { href: reviews.href, label: "Return to Reviews" },
      });
  }
  const files = historyFiles(context.root, query.commit);
  if (query.batch !== undefined) {
    if (query.path || query.context || query.load) throw new WebError(400, "Invalid file diff continuation");
    return renderToString(inlineCommitFiles(context, query, files.changes, files.unit.revision, location));
  }
  const unit = files.unit,
    review = task || query.view === "files" ? undefined : committedReview(context.root, unit.revision),
    split = query.layout === "split",
    pendingPaths = new Set(
      taskFiles
        ? taskFiles.filter((file) => file.commit === unit.revision).map((file) => file.path)
        : review &&
            context.commitReviews
              .find((item) => item.revision === unit.revision)
              ?.groups.flatMap((group) => group.paths),
    ),
    unacknowledged = new Set(review?.changes.filter((change) => !change.approved).map((change) => change.path)),
    candidates = review?.provisional
      ? [...pendingPaths].filter((path) => unacknowledged.has(path)).map((path) => ({ path }))
      : [],
    selectedPath = taskFile?.path ?? query.path ?? candidates[0]?.path,
    title = unit.message.split("\n")[0] ?? unit.revision.slice(0, 12),
    messageBody = unit.message
      .replace(/^.*\n?/, "")
      .replace(/^Workbench-Provisional: true\s*$/m, "")
      .trim(),
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
        </div>
      </section>
    );
  const filesPage = selectedPath
    ? location({ commit: unit.revision, layout: split ? "split" : "unified", ...(task ? {} : { view: "files" }) })
    : "";
  const workspace = (children: import("preact").ComponentChildren) =>
    commitNavigation(files.changes, selectedPath, (path) => `${filesPage}#${commitFileId(path)}`, children);
  if (!selectedPath)
    return shell(
      context,
      title,
      task?.active ?? "review",
      <>
        {commitHeading}
        {workspace(inlineCommitFiles(context, query, files.changes, unit.revision, location))}
      </>,
      { parents: trail },
    );
  const file = historyFile(context.root, unit.revision, selectedPath, files),
    change = review?.changes.find((change) => change.path === selectedPath),
    protectedReview = !!change,
    maximum = protectedReview || query.load === "1" ? 2 * 1024 * 1024 : filePreviewByteLimit,
    { before, after } = historyFilePreviews(context.root, file, maximum),
    tooLarge = (!!file.before && before === undefined) || (!!file.after && after === undefined),
    binary = [before, after].some((bytes) => bytes !== undefined && (bytes.includes(0) || !isUtf8(bytes))),
    markdownFile = selectedPath.endsWith(".md") && !binary && !tooLarge,
    historical = protectedReview
      ? historicalRecords(context.root, after ? unit.revision : (unit.parents[0] ?? unit.revision), () =>
          after ? files.logicalAfter : files.logicalBefore,
        )
      : { paths: new Set<string>(), references: new RecordLookup([]) },
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
    base = location({
      commit: unit.revision,
      path: selectedPath,
      ...(query.context ? { context: query.context } : {}),
      ...(query.load ? { load: query.load } : {}),
    }),
    reviewing = protectedReview && unit.provisional && !change.approved && pendingPaths.has(selectedPath) && !tooLarge,
    reviewed =
      review && change ? reviewedBaselines(context.root, review.head, selectedPath).get(selectedPath) : undefined;
  const digest = review && change ? presentedReviewDigest(change, review.head) : "";
  if (reviewing && review)
    versions.retainBatch(
      [
        {
          change,
          document: { error: "", before: before?.toString("base64") ?? null, after: after?.toString("base64") ?? null },
          downloadBefore: !markdownFile,
        },
      ],
      review.head,
    );
  const list =
      taskFiles ?? (reviewing ? candidates : files.changes).map(({ path }) => ({ commit: unit.revision, path })),
    selected = list.findIndex((item) => item.commit === unit.revision && item.path === selectedPath),
    previous = list[selected - 1],
    next = list[selected + 1],
    mode = fileModeChange(file.before?.mode ?? "000000", file.after?.mode ?? "000000"),
    same = file.before?.oid === file.after?.oid && file.before?.mode === file.after?.mode;
  const layout = split ? "split" : "unified";
  const commitHref = sourceURL(
    context,
    taskRecord && files.after.has(taskRecord.path)
      ? routeURL(Route.TaskHistory, {
          id: taskRecord.id,
          commit: unit.revision,
          tip: unit.revision,
          workflow: "1",
          layout,
        })
      : routeURL(Route.History, { commit: unit.revision, view: "files", layout }),
  );
  const recordTitle = owner?.title.startsWith(`${owner.id.slice(owner.scope.length + 1)}: `)
    ? `${owner.scope}:${owner.title}`
    : (owner?.title ?? selectedPath);
  const navigation =
    query.task && taskFiles
      ? {
          ...taskReviewNeighbors(context, query.task, layout, { position: selected, files: taskFiles }),
          label: "review",
        }
      : {
          previous: previous ? { href: location({ ...previous, layout }) } : undefined,
          next: next ? { href: location({ ...next, layout }) } : undefined,
          label: reviewing ? "review file" : "changed file",
        };
  return shell(
    context,
    reviewing ? recordTitle : title,
    task?.active ?? "review",
    <>
      {reviewing
        ? commitReviewContext(
            context.root,
            unit.revision,
            title,
            `File ${String(selected + 1)} of ${String(list.length)}`,
            { showTasks: !taskRecord, commitHref },
          )
        : commitHeading}
      {protectedReview && (
        <>
          <p class="file-path">
            {selectedPath}{" "}
            {!file.before ? badge("New file", "pending") : !file.after ? badge("Deleted file", "pending") : null}
          </p>
          {mode && <p>{mode}</p>}
        </>
      )}
      {protectedReview ? (
        <>
          {" "}
          {recordPane(
            panel(
              historyComparison(reviewed ? Buffer.from(reviewed.contents) : before, after, {
                purpose: "record",
                path: selectedPath,
                record,
                references: historical.references,
                split,
                tooLarge,
              }),
              { tools: !tooLarge && !binary && before && after && !same ? diffLayout(base, split) : null },
            ),
            navigation,
          )}
        </>
      ) : (
        workspace(
          <>
            <div class="actions">{diffLayout(base, split)}</div>
            <section class="panel commit-file" data-commit-file={selectedPath}>
              <div class="panel-heading">
                <h2>{selectedPath}</h2>
                {!file.before ? badge("New file", "pending") : !file.after ? badge("Deleted file", "pending") : null}
              </div>
              {commitFileActions(file, unit.revision)}
              {mode && <p class="file-path">{mode}</p>}
              <div class="commit-file-body">
                {commitFileDiff(file, before, after, {
                  commit: unit.revision,
                  split,
                  ...(query.context ? { context: query.context } : {}),
                  loaded: query.load === "1",
                  location,
                })}
              </div>
            </section>
          </>,
        )
      )}
      {protectedReview && !markdownFile && (
        <div class="actions">
          {file.before && file.before.mode !== "160000" && (
            <a href={routeURL(Route.HistoryFile, { commit: unit.revision, path: selectedPath, side: "before" })}>
              Download previous file
            </a>
          )}
          {file.after && file.after.mode !== "160000" && (
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
            ...(query.task ? { review_task: query.task } : {}),
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
    { parents: trail },
  );
}
