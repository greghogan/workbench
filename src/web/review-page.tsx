import type { ComponentChildren } from "preact";
import { ReviewSource } from "../review-service.js";
import { badge, panel, submitButton } from "./components.js";
import { projectPath } from "./project-paths.js";
import { diffLayout, linkButton, tabs as viewTabs } from "./render-links.js";
import { comparisonView } from "./diff-view.js";
import { mutationForm } from "./action-forms.js";
import { routeURL, withView } from "./locations.js";
import { Route, type RouteQuery } from "./routes.js";
import { markdown } from "./markdown-view.js";
import { shell } from "./page-frame.js";
import { type ViewContext } from "./view-context.js";
import { reviewPageModel } from "./review-model.js";
import { reviewLocation } from "./review-navigation.js";
import { sourceURL } from "./sources.js";
export function reviewPage(context: ViewContext, parameters: RouteQuery<typeof Route.Review>): string {
  const path = parameters.path;
  if (!path)
    return shell(
      context,
      "Review queue",
      "review",
      context.selectedReviews.length ? (
        <section class="panel">
          {context.selectedReviews.map((change) => (
            <a
              class="record-row"
              href={sourceURL(context, routeURL(Route.Review, { path: change.path, review_source: change.source }))}
            >
              {badge(change.source === ReviewSource.Working ? "Working file" : "Staged file")}
              {badge(change.approved ? "Approved" : "Needs review", change.approved ? "approved" : "pending")}
              <h2 class="file-path">{change.path}</h2>
            </a>
          ))}
        </section>
      ) : (
        <p class="empty">No protected changes.</p>
      ),
    );
  const {
    change,
    version,
    navigation,
    layout,
    base,
    beforeMode,
    afterMode,
    alternative,
    document,
    before,
    after,
    contents,
    record,
    isADR,
    binary,
    readable,
    raw,
    heading,
    choices,
    view,
    split,
  } = reviewPageModel(context, parameters);
  const neighbors = (
    <nav class="review-navigation" aria-label="Review queue navigation">
      {navigation.previous ? (
        <a rel="prev" href={projectPath(reviewLocation(context, navigation.previous, layout))}>
          ← Previous
        </a>
      ) : (
        <span class="muted">← Previous</span>
      )}
      <span>
        {String(navigation.position)} of {String(navigation.total)}
      </span>
      {navigation.next ? (
        <a rel="next" href={projectPath(reviewLocation(context, navigation.next, layout))}>
          Next →
        </a>
      ) : (
        <span class="muted">Next →</span>
      )}
    </nav>
  );
  const modeChange = beforeMode !== afterMode && (
    <p class="file-path" data-file-mode="">
      File mode: {beforeMode === "000000" ? "absent" : beforeMode} → {afterMode === "000000" ? "absent" : afterMode}
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
  let body: ComponentChildren = binary ? (
    <p>Binary supporting file. Download and inspect it before confirming review.</p>
  ) : path.endsWith(".md") && view === "read" ? (
    markdown(raw, record, context.index.references, heading)
  ) : (
    <pre class="source">{contents.toString("utf8")}</pre>
  );
  if (view === "changes" && isADR) body = comparisonView(document.reviewed, split);
  const fileQuery = { path, digest: change.digest, review_source: change.source };
  const files = !readable && (before ?? after) && (
    <div class="actions">
      {before && <a href={routeURL(Route.ReviewFile, { ...fileQuery, side: "before" })}>Download committed file</a>}
      {before && after && " "}
      {after && <a href={routeURL(Route.ReviewFile, { ...fileQuery, side: "after" })}>Download {version} file</a>}
    </div>
  );
  const form = mutationForm({
    action: Route.Approve,
    csrf: context.csrf,
    context,
    class: "form-grid",
    fields: { path, digest: change.digest, review_source: change.source, review_layout: layout },
    children: (controls) => (
      <>
        {controls.confirmation(
          "reviewed",
          "I have reviewed this exact " + version + " " + (after ? "file" : "deletion") + ".",
        )}
        {change.charter && controls.confirmation("human_written", "The changed charter text was written by a human.")}
        {submitButton(change.approved ? "Confirm review again" : "Confirm review", { approve: true })}
      </>
    ),
  });
  return shell(
    context,
    heading,
    "review",
    <>
      {neighbors}
      <p class="file-path">{path}</p>
      {modeChange}
      <p>
        {badge(version === "staged" ? "Staged file" : "Working file")}
        {badge(change.approved ? "Approved" : "Needs review", change.approved ? "approved" : "pending")}
        {!after ? badge("Deleted file", "pending") : !before ? badge("Added file") : null}
      </p>
      {!after && <p class="notice">Review confirms removing the previous file shown below.</p>}
      {alternative && alternative.digest !== change.digest && (
        <p>
          {linkButton(
            "View the differing " + alternative.source + " version",
            sourceURL(context, routeURL(Route.Review, { path, review_source: alternative.source })),
            true,
          )}
        </p>
      )}
      {panel(
        <>
          {body}
          {files}
        </>,
        { tabs, tools: view === "changes" && isADR ? diffLayout(withView(base, { view: "changes" }), split) : null },
      )}
      {panel(form)}
    </>,
    { parents: [{ label: "Review queue", href: sourceURL(context, "/review") }] },
  );
}
