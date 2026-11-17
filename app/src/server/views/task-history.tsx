import type { JSX } from "preact";
import type { BrowserRecord } from "../../core/records/record-service.js";
import { taskCommits } from "../../core/git/history.js";
import { WebError } from "../http/errors.js";
import { Route, type RouteQuery } from "../routes/routes.js";
import { routeURL } from "../routes/locations.js";
import { sourceURL } from "../routes/sources.js";
import type { ViewContext } from "../workspace/view-context.js";
import type { ReviewVersions } from "../review/review-versions.js";
import { taskRecordTrail } from "./workflow-navigation.js";
import { historyPage } from "./history-page.js";
import { shell } from "./page-frame.js";

function taskLocation(
  context: ViewContext,
  record: BrowserRecord,
  query: Omit<RouteQuery<typeof Route.TaskHistory>, "id">,
) {
  return sourceURL(
    context,
    routeURL(Route.TaskHistory, { ...query, id: record.id, ...(context.workflow ? { workflow: "1" } : {}) }),
  );
}

function commitList(context: ViewContext, record: BrowserRecord, query: RouteQuery<typeof Route.TaskHistory>) {
  const offset = query.offset === undefined ? 0 : Number(query.offset),
    history = taskCommits(
      context.root,
      record.path,
      query.tip ?? (context.index.snapshot.review.head || "HEAD"),
      offset,
    ),
    page = { tip: history.tip, ...(offset ? { offset: String(offset) } : {}) };
  return {
    history,
    location: (values: RouteQuery<typeof Route.History>) => taskLocation(context, record, { ...page, ...values }),
    contents: (
      <>
        {history.commits.map((commit) => (
          <a class="task-commit" href={taskLocation(context, record, { ...page, commit: commit.revision })}>
            <span>{commit.subject}</span>
            <code>{commit.revision.slice(0, 12)}</code>
          </a>
        ))}
        {history.next !== undefined && (
          <div class="actions">
            <a
              class="button secondary"
              href={taskLocation(context, record, { tip: history.tip, offset: String(history.next) })}
            >
              Older task commits
            </a>
          </div>
        )}
      </>
    ),
  };
}

/** Delivered changes are inspected alongside the task's outcome decision, without browsing unrelated history. */
export function taskHistoryPanel(context: ViewContext, record: BrowserRecord): JSX.Element | null {
  if (record.type !== "TSK" || record.local || record.collection || record.archive) return null;
  const list = commitList(context, record, { id: record.id });
  if (!list.history.commits.length) return null;
  return (
    <section class="panel" aria-label="Task commits">
      <div class="panel-heading">
        <h2>Commits</h2>
      </div>
      {list.contents}
    </section>
  );
}

export function taskHistoryPage(
  context: ViewContext,
  query: RouteQuery<typeof Route.TaskHistory>,
  versions: ReviewVersions,
): string {
  const record = context.records.find(
    (item) => item.id === query.id && item.type === "TSK" && !item.collection && !item.local && !item.archive,
  );
  if (!record) throw new WebError(404, "Task is unavailable in the selected scope");
  const list = commitList(context, record, query),
    { parents, active } = taskRecordTrail(context, record);
  if (!query.commit)
    return shell(context, "Commits", active, <section class="panel">{list.contents}</section>, { parents });
  if (!list.history.commits.some((commit) => commit.revision === query.commit))
    throw new WebError(404, "Commit is not part of this task history page");
  return historyPage(context, query, versions, {
    location: list.location,
    active,
    parents: [
      ...parents,
      {
        label: "Commits",
        href: taskLocation(context, record, {
          tip: list.history.tip,
          ...(query.offset ? { offset: query.offset } : {}),
        }),
      },
    ],
  });
}
