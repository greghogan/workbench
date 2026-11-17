import type { JSX } from "preact";
import { basename } from "node:path";
import { Route, type RouteQuery } from "../routes/routes.js";
import { reviewRowLocation, workflowRecordURL } from "../review/review-navigation.js";
import type { ViewContext } from "../workspace/view-context.js";
import { reviewScopes, type ReviewScope, type ReviewRow } from "../review/review-layout.js";
import { badge } from "./components.js";
import { shell } from "./page-frame.js";
import { commitReviewContext } from "./commit-review-context.js";
import { compatibilityReviewItem } from "./compatibility-review.js";
import { workflowWindow } from "./workflow-pages.js";
import { recordRow } from "./record-content.js";

function reviewRow(context: ViewContext, row: ReviewRow): JSX.Element {
  const href = reviewRowLocation(context, row);
  if (row.kind === "task") return recordRow(row.record, context, 3, href);
  const { group } = row;
  const owner = row.kind === "commit" && !row.task ? context.index.reviewTaskOwners.get(row.commit) : undefined;
  return (
    <article
      class="record-row"
      tabIndex={-1}
      data-card=""
      data-review-record={row.kind === "commit" ? group.path : undefined}
      data-record-id={group.record?.id}
    >
      {group.record && badge(group.record.id)}
      <h3>
        <a data-card-link="" href={href}>
          {group.record?.title ?? basename(group.path)}
        </a>
      </h3>
      <p class="file-path">{group.path}</p>
      {row.kind === "working" && group.record?.summary && <p class="muted">{group.record.summary}</p>}
      {owner && (
        <a class="muted" href={workflowRecordURL(context, owner.reference)}>
          {owner.reference}
        </a>
      )}
    </article>
  );
}

function reviewPanels(context: ViewContext, scopes: ReviewScope[], visible: readonly ReviewRow[]): JSX.Element {
  const selected = new Set(visible.map((row) => row.id));
  return (
    <div data-task-items="">
      {scopes.map((scope) => {
        const panels = scope.panels.flatMap((group) => {
          const rows = group.rows.filter((row) => selected.has(row.id));
          if (!rows.length) return [];
          const heading = group.commit ? (
            commitReviewContext(
              context.root,
              group.commit.revision,
              group.commit.subject,
              `${String(group.rows.length)} ${group.rows.length === 1 ? "review" : "reviews"}`,
              { headingLevel: 3 },
            )
          ) : group.task && !selected.has(group.task.id) ? (
            <h3>{group.task.title}</h3>
          ) : null;
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
                    {reviewRow(context, row)}
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
  const approvals: { id: string; contents: () => JSX.Element | null }[] = context.workflowApprovals.map((record) => ({
    id: record.id,
    contents: () => recordRow(record, context, 3, workflowRecordURL(context, record.id)),
  }));
  if (context.compatibilityNeedsHumanReview)
    approvals.push({ id: "compatibility", contents: () => compatibilityReviewItem(context) });
  const sections = reviewScopes(context);
  const rows = sections.flatMap((scope) => scope.panels.flatMap((panel) => panel.rows));
  const windows = workflowWindow(context, query, Route.Reviews);
  const approvalWindow = windows("approvals", approvals, (row) => row.id);
  const window = windows("reviews", rows, (row) => row.id);
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
      {approvals.length > 0 && (
        <section
          aria-label="Awaiting approval"
          data-task-window={approvalWindow.key}
          data-task-through={approvalWindow.through}
          data-list-revision={approvalWindow.revision}
        >
          <h2>Awaiting approval</h2>
          {approvalWindow.previous}
          <div data-task-items="">
            {approvalWindow.visible.map((row) => (
              <div class="panel" data-task-node={row.id} key={row.id}>
                {row.contents()}
              </div>
            ))}
          </div>
          {approvalWindow.loader}
        </section>
      )}
      {rows.length > 0 && (
        <section
          aria-label="Awaiting acceptance"
          data-task-window={window.key}
          data-task-through={window.through}
          data-list-revision={window.revision}
        >
          <h2>Awaiting acceptance</h2>
          {window.previous}
          {reviewPanels(context, sections, window.visible)}
          {window.loader}
        </section>
      )}
      <output id="task-loading-status" class="sr-only"></output>
    </>,
    { workflowList: "reviews" },
  );
}
