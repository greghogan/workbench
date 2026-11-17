import type { JSX } from "preact";
import { basename } from "node:path";
import { Route, type RouteQuery } from "../routes/routes.js";
import { routeURL } from "../routes/locations.js";
import { sourceURL } from "../routes/sources.js";
import { reviewLocation, taskReviewLocation } from "../review/review-navigation.js";
import type { ViewContext } from "../workspace/view-context.js";
import { reviewCollection } from "../review/review-queue.js";
import { badge } from "./components.js";
import { shell } from "./page-frame.js";
import { commitReviewContext } from "./commit-review-context.js";
import { compatibilityReviewItem } from "./compatibility-review.js";
import { workflowWindow } from "./workflow-pages.js";
import { workflowRecordURL } from "./workflow-navigation.js";
import { recordRow } from "./record-content.js";
import type { BrowserRecord } from "../../core/records/record-service.js";

interface ReviewRow {
  id: string;
  contents: () => JSX.Element | null;
}
interface CommitReviewRow extends ReviewRow {
  path: string;
}
interface ReviewPanel {
  id: string;
  heading?: () => JSX.Element;
  task?: BrowserRecord;
  rows: ReviewRow[];
}

interface ReviewScope {
  key: string;
  title: string;
  panels: ReviewPanel[];
}

function reviewPanels(scopes: ReviewScope[], visible: readonly ReviewRow[]): JSX.Element {
  const selected = new Set(visible.map((row) => row.id));
  return (
    <div data-task-items="">
      {scopes.map((scope) => {
        const panels = scope.panels.flatMap((group) => {
          const rows = group.rows.filter((row) => selected.has(row.id));
          if (!rows.length) return [];
          const heading =
            group.heading?.() ?? (group.task && !selected.has(group.task.id) ? <h3>{group.task.title}</h3> : null);
          return [
            <section
              key={group.id}
              class="panel review-group"
              aria-label={group.task?.title}
              data-task-group={group.id}
              data-review-commit={group.id.startsWith("commit:") ? group.id.slice(7) : undefined}
            >
              {heading && <div class="panel-heading">{heading}</div>}
              <div data-task-group-items="">
                {rows.map((row) => (
                  <div data-task-node={row.id} key={row.id}>
                    {row.contents()}
                  </div>
                ))}
              </div>
            </section>,
          ];
        });
        if (!panels.length) return null;
        return (
          <section
            key={scope.key}
            class="review-scope"
            aria-label={scope.title}
            data-task-group={scope.key}
            data-review-source={scope.key}
          >
            <h2>{scope.title}</h2>
            <div data-task-group-items="">{panels}</div>
          </section>
        );
      })}
    </div>
  );
}

/** Record versions keep their commit/source groups; task acceptance remains an independent human decision. */
export function reviewsPage(context: ViewContext, query: RouteQuery<typeof Route.Reviews> = {}): string {
  const commitRows = (
    unit: Pick<ViewContext["standaloneCommitReviews"][number], "revision" | "groups">,
    task?: string,
  ): CommitReviewRow[] =>
    unit.groups.map((group) => {
      const file = {
        commit: unit.revision,
        path: group.paths.includes(group.path) ? group.path : (group.paths[0] ?? group.path),
      };
      const href = task ? taskReviewLocation(context, task, file) : sourceURL(context, routeURL(Route.History, file));
      return {
        id: `${unit.revision}:${group.path}`,
        path: group.path,
        contents: () => (
          <article
            class="record-row"
            tabIndex={-1}
            data-card=""
            data-review-record={group.path}
            data-record-id={group.record?.id}
          >
            {group.record && badge(group.record.id)}
            <h3>
              <a data-card-link="" href={href}>
                {group.record?.title ?? basename(group.path)}
              </a>
            </h3>
            <p class="file-path">{group.path}</p>
          </article>
        ),
      };
    });
  const hierarchy = context.index.hierarchy;
  const scopes = new Map<string, ReviewScope>();
  for (const project of hierarchy.ordered()) {
    const key = `project:${project.id}`;
    scopes.set(key, { key, title: hierarchy.breadcrumb(project), panels: [] });
  }
  const collections = new Map<string, ReviewScope>();
  const collectionScope = (collection: string): ReviewScope => {
    const key = `collection:${collection}`;
    const scope = collections.get(key) ?? { key, title: `Collection: ${collection}`, panels: [] };
    collections.set(key, scope);
    return scope;
  };
  const rootKey = `project:${context.projects[0]?.id ?? ""}`;
  for (const task of context.workflowOutcomes) {
    scopes.get(`project:${task.scope}`)?.panels.push({
      id: `task:${task.id}`,
      task,
      rows: [
        ...context.taskDocumentReviews(task.id).flatMap((unit) => commitRows(unit, task.id)),
        { id: task.id, contents: () => recordRow(task, context, 3, workflowRecordURL(context, task.id)) },
      ],
    });
  }
  for (const unit of context.standaloneCommitReviews) {
    const rows = new Map<ReviewScope, ReviewRow[]>();
    for (const row of commitRows(unit)) {
      const collection = reviewCollection(row.path),
        project = collection ? undefined : context.index.projectForPath(row.path);
      const scope = collection ? collectionScope(collection) : scopes.get(project ? `project:${project.id}` : rootKey);
      if (!scope) continue;
      const group = rows.get(scope) ?? [];
      group.push(row);
      rows.set(scope, group);
    }
    for (const [scope, group] of rows) {
      scope.panels.push({
        id: `commit:${unit.revision}`,
        heading: () =>
          commitReviewContext(
            context.root,
            unit.revision,
            unit.subject,
            `${String(group.length)} ${group.length === 1 ? "review" : "reviews"}`,
            { headingLevel: 3 },
          ),
        rows: group,
      });
    }
  }
  for (const section of context.reviewSections) {
    const collection = section.groups[0]?.collection;
    const scope = collection ? collectionScope(collection) : scopes.get(section.key);
    scope?.panels.push({
      id: `working:${section.key}`,
      rows: section.groups.map((group) => ({
        id: `working:${group.path}`,
        contents: () => (
          <article class="record-row" tabIndex={-1} data-card="" data-record-id={group.record?.id}>
            {group.record && badge(group.record.id)}
            <h3>
              <a data-card-link="" href={reviewLocation(context, group)}>
                {group.record?.title ?? basename(group.path)}
              </a>
            </h3>
            <p class="file-path">{group.path}</p>
            {group.record?.summary && <p class="muted">{group.record.summary}</p>}
          </article>
        ),
      })),
    });
  }
  if (context.compatibilityNeedsHumanReview)
    scopes.get(rootKey)?.panels.push({
      id: "compatibility",
      rows: [{ id: "compatibility", contents: () => compatibilityReviewItem(context) }],
    });
  const sections = [...scopes.values(), ...[...collections.values()].sort((a, b) => a.title.localeCompare(b.title))];
  const rows = sections.flatMap((scope) => scope.panels.flatMap((panel) => panel.rows));
  const window = workflowWindow(context, query, Route.Reviews)("reviews", rows, (row) => row.id);
  const application = context.collectionApplication;
  return shell(
    context,
    "Reviews",
    "review",
    <>
      {application && (
        <section class="notice" aria-label="Collection application result">
          <p>
            {application.issues.length || application.omitted
              ? `Collection ${application.id} applied; preparation needs attention.`
              : `Collection ${application.id} applied. Project context synchronized and validation passed.`}
          </p>
          {application.issues.length > 0 && (
            <ul>
              {application.issues.map((issue) => (
                <li>{issue}</li>
              ))}
            </ul>
          )}
          {application.omitted > 0 && (
            <p>
              {String(application.omitted)} additional issues. Run <code>workbench validate</code> for the complete
              report.
            </p>
          )}
        </section>
      )}
      {context.index.snapshot.tasks.problem && <p class="notice">{context.index.snapshot.tasks.problem}</p>}
      {context.pendingReviews === 0 && <p class="empty">No reviews awaiting attention.</p>}
      {rows.length > 0 && (
        <div data-task-window={window.key} data-task-through={window.through} data-list-revision={window.revision}>
          {window.previous}
          {reviewPanels(sections, window.visible)}
          {window.loader}
        </div>
      )}
      <output id="task-loading-status" class="sr-only"></output>
    </>,
    { workflowList: "reviews" },
  );
}
