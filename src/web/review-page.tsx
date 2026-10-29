import { compatibilityReviewItem } from "./compatibility-review.js";
import type { ComponentChildren, JSX } from "preact";
import { basename } from "node:path";
import { badge, panel, submitButton } from "./components.js";
import { diffLayout, tabs as viewTabs } from "./render-links.js";
import { comparisonView, sourceDiffView, fileModeChange } from "./diff-view.js";
import { mutationForm } from "./action-forms.js";
import { routeURL, withView } from "./locations.js";
import { Route, type RouteQuery } from "./routes.js";
import { markdown } from "./markdown-view.js";
import { shell } from "./page-frame.js";
import { type ViewContext } from "./view-context.js";
import { reviewHeading, reviewPageModel } from "./review-model.js";
import { reviewLocation, reviewNavigation } from "./review-navigation.js";
import { projectPath } from "./project-paths.js";
import { WebError } from "./errors.js";
import { differenceLayout } from "./navigation-state.js";
import { recordPane } from "./record-pane.js";
export function prepareReviewPage(context: ViewContext, parameters: RouteQuery<typeof Route.Review>) {
  if (parameters.id && parameters.path) throw new WebError(400, "select a record or a file, not both");
  const path = parameters.id ? context.index.reviewGroupById.get(parameters.id)?.path : parameters.path;
  if (parameters.id && !path) throw new WebError(404, "protected record not found; refresh the queue");
  if (!path) return null;
  const owner = context.index.reviewOwnerPath(path);
  const group = context.reviewGroups.find((group) => group.path === owner);
  if (!group) throw new WebError(404, "protected record not found; refresh the queue");
  if (group.pending === 0) return null;
  const selected = context.index.reviewChange(owner);
  const primaryParameters = { ...parameters, path: owner };
  const primary = selected && !selected.approved ? reviewPageModel(context, primaryParameters) : undefined;
  const representative = selected ?? group.changes[0];
  if (!representative) throw new WebError(404, "protected record not found; refresh the queue");
  const navigation = reviewNavigation(context, representative.digest);
  const layout = differenceLayout(parameters);
  const supporting = group.changes
    .filter((change) => change.path !== owner && !change.approved)
    .map((change) => reviewPageModel(context, { path: change.path, layout }));
  const unchanged = group.record ? context.document(group.record.id).contents : undefined;
  const heading = primary?.heading ?? (unchanged !== undefined ? reviewHeading(unchanged, owner) : basename(owner));
  return {
    primary,
    supporting,
    unchanged,
    heading,
    owner,
    navigation,
    layout,
    presentations: [...(primary ? [primary] : []), ...supporting].filter((model) => model.canApprove),
  };
}
export function reviewPage(
  context: ViewContext,
  parameters: RouteQuery<typeof Route.Review>,
  prepared = prepareReviewPage(context, parameters),
): string {
  if (!prepared)
    return shell(
      context,
      "Review queue",
      "review",
      <>
        {context.collectionApplication && (
          <section class="notice" aria-label="Collection application result">
            <p>
              {context.collectionApplication.issues.length || context.collectionApplication.omitted
                ? `Collection ${context.collectionApplication.id} applied; preparation needs attention.`
                : `Collection ${context.collectionApplication.id} applied. Project context synchronized and validation passed.`}
            </p>
            {context.collectionApplication.issues.length > 0 && (
              <ul>
                {context.collectionApplication.issues.map((issue) => (
                  <li>{issue}</li>
                ))}
              </ul>
            )}
            {context.collectionApplication.omitted > 0 && (
              <p>
                {String(context.collectionApplication.omitted)} additional issues. Run <code>workbench validate</code>{" "}
                for the complete report.
              </p>
            )}
          </section>
        )}
        {context.pendingReviews ? (
          <section class="panel">
            {context.reviewQueue.map((group) => (
              <article class="record-row" data-card="" data-record-id={group.record?.id}>
                {group.record && badge(group.record.id)}
                <h2>
                  <a data-card-link="" href={reviewLocation(context, group)}>
                    {group.record?.title ?? basename(group.path)}
                  </a>
                </h2>
                <p class="file-path">{group.path}</p>
                {group.record?.summary && <p class="muted">{group.record.summary}</p>}
              </article>
            ))}
            {compatibilityReviewItem(context)}
          </section>
        ) : (
          <p class="empty">No protected changes.</p>
        )}
      </>,
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
          {supporting.map((model) => fileReview(context, model, { supporting: true }))}
        </section>
      )}
    </>,
    { parents: [{ label: "Review queue", href: projectPath("/review") }] },
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
      {supporting && <h3>{basename(path)}</h3>}
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
