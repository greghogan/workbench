import type { ComponentChildren, JSX } from "preact";
import { badge, panel, submitButton } from "./components.js";
import { diffLayout, tabs as viewTabs } from "./render-links.js";
import { comparisonView, sourceDiffView, fileModeChange } from "./diff-view.js";
import { mutationForm } from "./action-forms.js";
import { routeURL, withView } from "../routes/locations.js";
import { Route, type RouteQuery } from "../routes/routes.js";
import { markdown } from "./markdown-view.js";
import { shell } from "./page-frame.js";
import { type ViewContext, type PageKey } from "../workspace/view-context.js";
import { prepareReviewPage, reviewPageModel, resolveReviewPage } from "../review/review-model.js";
import { reviewLocation } from "../review/review-navigation.js";
import { sourceURL } from "../routes/sources.js";
import { recordPane } from "./record-pane.js";
import { basename } from "node:path";
import { DifferenceLayout, differenceLayout } from "../routes/navigation-state.js";
import { PreparationState } from "../review/review-state.js";
import { taskWorkflowNavigation, tasksParent, workflowParent } from "./workflow-navigation.js";
import type { Breadcrumb } from "./breadcrumbs.js";
export function reviewPreparationPage(
  context: ViewContext,
  prepared: Pick<NonNullable<ReturnType<typeof resolveReviewPage>>, "heading" | "owner" | "layout"> & {
    task?: { reference: string; expected: string };
    workflow?: "1";
    recordView?: "read" | "changes";
  },
  view?: RouteQuery<typeof Route.Review>["view"],
  active: PageKey = "review",
  parents: Breadcrumb[] = [workflowParent(context, Route.Reviews)],
): string {
  return shell(
    context,
    prepared.heading,
    active,
    panel(
      mutationForm({
        action: Route.ReviewPrepare,
        context,
        csrf: context.csrf,
        fields: {
          path: prepared.owner,
          review_layout: prepared.layout,
          ...(view ? { review_view: view } : {}),
          expected: prepared.task?.expected ?? context.index.reviewChange(prepared.owner)?.digest ?? context.revision,
          ...(prepared.workflow ? { workflow: prepared.workflow } : {}),
          ...(prepared.recordView ? { record_view: prepared.recordView } : {}),
        },
        children: () =>
          submitButton(prepared.task ? (active === "review" ? "Review outcome" : "Review plan") : "Review file"),
      }),
    ),
    { parents },
  );
}

/** Format only mutable plan/outcome presentation; edit forms and retained history keep their captured source. */
export function taskReviewPreparationPage(
  context: ViewContext,
  id: string,
  query: { view?: string; layout?: DifferenceLayout; workflow?: "1" },
): string | undefined {
  if (query.view && !["read", "changes"].includes(query.view)) return;
  const record = context.index.byId.get(id);
  if (
    record?.type !== "TSK" ||
    record.local ||
    record.collection ||
    record.archive ||
    context.index.snapshot.reviewPreparation.files.get(record.path)?.state !== PreparationState.Required
  )
    return;
  const plan = context.index.snapshot.tasks.plans.find((plan) => plan.reference === id),
    task = context.index.taskGraph.byReference.get(id),
    expected = plan?.digest ?? task?.reviewDigest ?? task?.digest;
  if (!expected) return;
  const navigation = plan !== undefined || query.workflow === "1" ? taskWorkflowNavigation(context, id) : undefined;
  return reviewPreparationPage(
    context,
    {
      heading: record.title,
      owner: record.path,
      layout: differenceLayout(query),
      task: { reference: id, expected },
      ...(query.workflow ? { workflow: query.workflow } : {}),
      ...(query.view === "read" || query.view === "changes" ? { recordView: query.view } : {}),
    },
    undefined,
    navigation?.active ?? (plan ? "plans" : "TSK"),
    navigation?.phase ? navigation.parents : [plan ? workflowParent(context, Route.Plans) : tasksParent(context)],
  );
}
export function reviewPage(
  context: ViewContext,
  parameters: RouteQuery<typeof Route.Review>,
  prepared = prepareReviewPage(context, parameters),
): string {
  if (!prepared)
    return shell(
      context,
      "Review complete",
      "review",
      <p>
        No pending changes. <a href={sourceURL(context, Route.Reviews)}>Reviews</a>
      </p>,
      { parents: [workflowParent(context, Route.Reviews)] },
    );
  const { primary, supporting, unchanged, heading, owner, navigation, layout } = prepared;
  const steps = {
    previous: navigation.previous ? { href: reviewLocation(context, navigation.previous, layout) } : undefined,
    next: navigation.next ? { href: reviewLocation(context, navigation.next, layout) } : undefined,
    label: "review",
  };
  return shell(
    context,
    heading,
    "review",
    <>
      {primary ? (
        fileReview(context, primary, { navigation: steps })
      ) : unchanged !== undefined ? (
        recordPane(
          panel(markdown(unchanged, { directory: context.root, path: owner }, context.index.references, heading)),
          steps,
        )
      ) : (
        <p class="notice">The current file is absent.</p>
      )}
      {supporting.length > 0 && (
        <section aria-label="Supporting file reviews">
          <h2>Supporting files</h2>
          {supporting.map((model) => (
            <details key={model.path}>
              <summary>
                {basename(model.path)}{" "}
                {badge(
                  model.change.approved ? "Reviewed" : "Needs review",
                  model.change.approved ? "approved" : "pending",
                )}
              </summary>
              {fileReview(context, model, { supporting: true })}
            </details>
          ))}
        </section>
      )}
    </>,
    { parents: [workflowParent(context, Route.Reviews)] },
  );
}

function fileReview(
  context: ViewContext,
  model: ReturnType<typeof reviewPageModel>,
  {
    supporting = false,
    navigation,
  }: {
    supporting?: boolean;
    navigation?: Parameters<typeof recordPane>[1];
  } = {},
): JSX.Element {
  const {
    path,
    change,
    layout,
    base,
    beforeMode,
    afterMode,
    document,
    before,
    after,
    record,
    presentation,
    heading,
    choices,
    view,
    split,
  } = model;
  const modeDescription = fileModeChange(beforeMode, afterMode);
  const modeChange = modeDescription && (
    <p class="file-path" data-file-mode="">
      {modeDescription}
    </p>
  );
  const tabs = viewTabs(
    choices.map((choice) => ({
      label: choice.label,
      href: withView(base, { view: choice.value, layout }),
      current: view === choice.value,
    })),
    "Reviewed file views",
  );
  let body: ComponentChildren;
  switch (presentation.kind) {
    case "binary":
      body = <p>Binary supporting file. Download and inspect it before confirming review.</p>;
      break;
    case "markdown":
      body = markdown(
        presentation.text,
        record,
        context.index.references,
        heading,
        supporting ? `supporting-${change.digest}-` : undefined,
      );
      break;
    case "text":
      body = <pre class="source">{presentation.text}</pre>;
      break;
    case "diff":
      body =
        document.reviewed.state === "unavailable" ? (
          <>
            {comparisonView(
              document.reviewed,
              { record, records: context.index.references, pageTitle: heading },
              split,
            )}
            {sourceDiffView(
              {
                patch: "",
                before: document.baselineContents ?? before?.toString("utf8") ?? "",
                after: after?.toString("utf8") ?? "",
              },
              { record, records: context.index.references, pageTitle: heading },
              split,
            )}
          </>
        ) : (
          comparisonView(document.reviewed, { record, records: context.index.references, pageTitle: heading }, split)
        );
      break;
  }
  const fileQuery = { path, digest: change.digest };
  const files = (presentation.kind === "binary" || presentation.kind === "text") && (before ?? after) && (
    <div class="actions">
      {before && <a href={routeURL(Route.ReviewFile, { ...fileQuery, side: "before" })}>Download committed file</a>}
      {before && after && " "}
      {after && <a href={routeURL(Route.ReviewFile, { ...fileQuery, side: "after" })}>Download current file</a>}
    </div>
  );
  const form = mutationForm({
    action: Route.Approve,
    csrf: context.csrf,
    context,
    class: "review-action",
    fields: {
      path,
      digest: change.digest,
      review_layout: layout,
      reviewed: "yes",
      human_written: change.charter ? "yes" : "no",
    },
    children: () => (
      <>
        <a
          href={withView(base, { layout })}
          class="button secondary"
          data-review-refresh=""
          hidden
          aria-label="Refresh displayed version"
        >
          Refresh
        </a>
        {submitButton(model.confirmation, {
          approve: true,
          ariaLabel: change.charter ? `${model.confirmation} to human-written charter` : model.confirmation,
        })}
      </>
    ),
  });
  const documentPanel = panel(
    <>
      {body}
      {files}
    </>,
    {
      tabs: supporting || presentation.kind === "diff" || choices.length < 2 ? null : tabs,
      tools: presentation.kind === "diff" ? diffLayout(withView(base, { view: "diff" }), split) : null,
    },
  );
  return (
    <section data-review-file={path} aria-label={path}>
      <p class="file-path">
        {path}{" "}
        {model.operation === "deletion"
          ? badge("Deleted file", "pending")
          : model.operation === "addition"
            ? badge("New file", "pending")
            : null}
        {change.approved && badge("Approved", "approved")}
      </p>
      {modeChange}
      {navigation ? recordPane(documentPanel, navigation) : documentPanel}
      {model.canApprove && form}
    </section>
  );
}
