import type { ComponentChildren, JSX } from "preact";
import { basename } from "node:path";
import type { BrowserRecord } from "../record-service.js";
import { citationMetadata, recordPresentations, yamlMetadata } from "../record-metadata.js";
import { adaptationsPanel } from "./collection-summary.js";
import { badge, panel, submitButton } from "./components.js";
import { WebError } from "./errors.js";
import { recordSearch, viewLocation } from "./navigation-state.js";
import { projectPath } from "./project-paths.js";
import { recordBatch } from "./record-listing.js";
import { diffLayout, linkButton, tabs as viewTabs } from "./render-links.js";
import { comparisonView, sourceDiffView } from "./diff-view.js";
import { mutationForm } from "./action-forms.js";
import { Route } from "./routes.js";
import { markdown } from "./markdown-view.js";
import { metadataSections, recordList } from "./record-content.js";
import { recordURL, routeURL, withView } from "./locations.js";
import { recordPageModel, type RemovedDecisionModel } from "./record-page-model.js";
import { shell } from "./page-frame.js";
import { type ViewContext } from "./view-context.js";
import { sourceURL } from "./sources.js";

export function recordsPage(context: ViewContext, parameters: URLSearchParams): string {
  const { type, scope, query } = recordSearch(parameters);
  const found = context.searchRecords({ type, scope, query });
  if (
    parameters.has("after") &&
    parameters.get("cursor_revision") &&
    parameters.get("cursor_revision") !== context.revision
  )
    throw new WebError(409, "record list changed; refresh the list before loading more records");
  const { visible, more, previous, startAfter } = recordBatch(
    found,
    parameters.get("after"),
    parameters.get("through"),
    parameters.get("before"),
  );
  const queryParameters = new URLSearchParams(parameters);
  queryParameters.delete("through");
  queryParameters.delete("before");
  queryParameters.delete("page");
  const last = visible.at(-1);
  if (last) queryParameters.set("after", last.id);
  queryParameters.set("cursor_revision", context.revision);
  if (context.selection) queryParameters.set("collection", context.selection);
  else if (!context.all) queryParameters.set("scope", context.scope);
  const previousParameters = new URLSearchParams(queryParameters);
  previousParameters.delete("after");
  previousParameters.delete("cursor_revision");
  if (visible[0]) previousParameters.set("before", visible[0].id);
  const previousLink = previous
    ? linkButton("Load previous records", "/records?" + previousParameters.toString(), true)
    : null;
  const loader = more ? (
    <a class="button secondary" data-load-more="" href={projectPath("/records") + "?" + queryParameters.toString()}>
      Load more
    </a>
  ) : (
    <p class="muted">All matching records loaded.</p>
  );
  return shell(
    context,
    type ? (type === "CHARTER" ? "Charter" : type) + " records" : query ? "Search results" : "Records",
    type || "records",
    <>
      <p class="muted">{String(found.length)} matching record(s).</p>
      <div id="record-previous">{previousLink}</div>
      <div id="record-list" data-list-revision={context.revision} data-window-after={startAfter}>
        {recordList(visible)}
      </div>
      <div id="record-loader">{loader}</div>
      <output id="record-loading-status" class="sr-only"></output>
      <p class="muted">
        Up to 300 records stay loaded. Load previous records to return to earlier entries. Browser Find searches this
        window; Search checks all selected records.
      </p>
      {type === "ADR" && adaptationsPanel(context)}
    </>,
    { search: { query, type } },
  );
}
function removedDecisionPage(context: ViewContext, parameters: URLSearchParams, model: RemovedDecisionModel): string {
  const { decision, view, path, split, base } = model;
  const upstream = model.baseline === "upstream";
  const controls = (
    <div class="actions">
      {linkButton(
        "Compare with " + (upstream ? "committed HEAD" : "pinned upstream"),
        viewLocation(context, base, parameters, { view: "changes", baseline: upstream ? "head" : "upstream" }),
        true,
      )}
    </div>
  );
  const previous = context.index.snapshot.removedHeadDiffs.get(decision.id);
  const difference = upstream ? (
    sourceDiffView(context.index.snapshot.upstreamDiffs.get(decision.id), split)
  ) : previous?.error ? (
    <p class="notice">{previous.error}</p>
  ) : (
    sourceDiffView(previous?.diff, split)
  );
  const body =
    view === "read" ? (
      markdown(decision.before, { directory: context.root, path }, context.index.references)
    ) : view === "source" ? (
      <pre class="source">{decision.before}</pre>
    ) : (
      <>
        <p class="muted">
          {upstream
            ? "Pinned upstream → project copy (working file). This includes committed adaptations."
            : "Committed HEAD → working file. This can include changes that have not been staged."}
        </p>
        {controls}
        {difference}
      </>
    );
  return shell(
    context,
    /^#\s+(.+)$/m.exec(decision.before)?.[1] ?? decision.id,
    "ADR",
    <>
      <p>
        {badge(decision.id)}
        {badge("Removed from collection", "pending")}
      </p>
      <p class="file-path">{path}</p>
      <p class="notice">This ADR exists in the pinned collection and has been removed from the project copy.</p>
      {panel(body, {
        tabs: viewTabs(
          (["read", "source", "changes"] as const).map((value) => ({
            label: value === "read" ? "Read" : value === "source" ? "Raw" : "Changes",
            href: viewLocation(context, base, parameters, { view: value }),
            current: view === value,
          })),
          "Record views",
        ),
        tools:
          view === "changes" ? diffLayout(withView(base, { view: "changes", baseline: model.baseline }), split) : null,
      })}
    </>,
    { parents: [{ label: "Decisions", href: sourceURL(context, "/records?type=ADR") }] },
  );
}
function citationDocumentsPanel(context: ViewContext, id: string): JSX.Element {
  const citation = context.document(id).citation;
  if (!citation || citation.error)
    return panel(
      <p class="notice">Document status unavailable: {citation?.error ?? "acquisition metadata is unavailable"}</p>,
      { heading: "Source documents" },
    );
  return panel(
    <>
      <p class="muted">
        Local file presence and recorded acquisition state are independent. Opening a PDF checks its recorded digest
        when available.
      </p>
      {citation.sources.map((source) => {
        const url = routeURL(Route.CitationDocument, { id, source: source.kind });
        return (
          <section class="citation-source">
            <h3>{source.kind === "arxiv" ? "arXiv" : source.kind}</h3>
            <p>
              {badge(
                source.present ? "File present locally" : "File missing locally",
                source.present ? "approved" : "pending",
              )}
              {badge("Acquisition: " + source.state)}
            </p>
            {source.reason && <p>{source.reason}</p>}
            {!source.present && source.state === "acquired" && (
              <p class="muted">Acquisition is recorded, but this checkout has no local copy.</p>
            )}
            <div class="actions">
              {source.present && (
                <>
                  {linkButton("View PDF", url)}
                  {linkButton(
                    "Download PDF",
                    routeURL(Route.CitationDocument, { id, source: source.kind, download: "1" }),
                    true,
                  )}
                </>
              )}
              <a href={source.landingUrl} rel="noreferrer noopener">
                Source page
              </a>
            </div>
          </section>
        );
      })}
    </>,
    { heading: "Source documents" },
  );
}
export function recordPage(
  context: ViewContext,
  parameters: URLSearchParams,
  draft?: { contents: string; expected: string; error: string },
): string {
  const model = recordPageModel(context, parameters);
  if (model.kind === "removed") return removedDecisionPage(context, parameters, model);
  const { record, document, compared, views, related, split, state } = model;
  const contents = document.contents;
  const view = state.view;
  let body: ComponentChildren,
    tools: ComponentChildren = null;
  if (view === "edit") {
    body = mutationForm({
      action: Route.Save,
      csrf: context.csrf,
      context,
      class: "form-grid",
      fields: { id: record.id, expected: draft?.expected ?? context.document(record.id).digest },
      children: (controls) => (
        <>
          {draft && (
            <p class="notice error" role="alert">
              {draft.error} Your draft is preserved below.
            </p>
          )}
          <p class="muted">Save changes to the working file. Saving does not stage, approve, or commit them.</p>
          {record.type === "CHARTER" && (
            <p class="notice">Charters express human-written intent. Enter your own charter text here.</p>
          )}
          {controls.area("contents", {
            id: "record-editor",
            label: record.type === "CHARTER" ? "Charter text" : "ADR source",
            value: draft?.contents ?? contents,
          })}
          <div class="actions">
            {submitButton("Save draft")}
            {linkButton("Cancel", recordURL(record.id), true)}
          </div>
        </>
      ),
    });
  } else if (state.view === "changes") {
    const { baseline, baselines } = state;
    const base = recordURL(record.id, { collection: context.selection, view: "changes" });
    tools = diffLayout(withView(base, { baseline }), split);
    const controls = (
      <div class="actions">
        {baselines
          .filter(({ value }) => value !== baseline)
          .map(({ value, label }) =>
            linkButton(label, viewLocation(context, base, parameters, { baseline: value }), true),
          )}
        <a href={sourceURL(context, "/review")}>Review files</a>
      </div>
    );
    body =
      baseline === "upstream" ? (
        context.comparison?.state === "compared" && compared ? (
          <>
            <p class="muted">Pinned upstream → project copy (working file). This includes committed adaptations.</p>
            <p class="file-path">Upstream revision: {context.comparison.revision}</p>
            {controls}
            {sourceDiffView(context.index.snapshot.upstreamDiffs.get(record.id), split)}
          </>
        ) : (
          <>
            <p class="notice">
              {context.comparison && context.comparison.state !== "compared"
                ? context.comparison.message
                : "Upstream comparison unavailable."}
            </p>
            {controls}
          </>
        )
      ) : (
        <>
          <p class="muted">
            {baseline === "reviewed" && document.reviewedAt
              ? "Last reviewed " + document.reviewedAt
              : "Committed HEAD (empty for a new record)"}{" "}
            → working file.
          </p>
          {controls}
          {comparisonView(baseline === "reviewed" ? document.reviewed : document.head, split)}
        </>
      );
  } else if (view === "source") body = <pre class="source">{contents}</pre>;
  else if (recordPresentations[record.type].format !== "markdown") {
    try {
      body = metadataSections(
        record.type === "CIT" ? citationMetadata(contents).fields : yamlMetadata(contents),
        context.index.references,
      );
    } catch (error) {
      body = (
        <>
          <p class="notice">{String(error)}</p>
          <pre class="source">{contents}</pre>
        </>
      );
    }
  } else body = markdown(contents, record, context.index.references, record.title);
  const attachments = document.files;
  return shell(
    context,
    record.title,
    record.type,
    <>
      <p>
        {badge(record.id)}
        {compared &&
          compared.status !== "unchanged" &&
          badge(
            compared.status === "modified"
              ? "Adapted"
              : compared.status === "removed"
                ? "Removed from collection"
                : "Added to collection",
            "pending",
          )}
        {record.status && badge(record.status)}
        {record.local && badge("Local collection · read only")}
      </p>
      <p class="file-path">{record.path}</p>
      {record.type === "CHARTER" && record.collection && (
        <p class="notice">
          This collection charter describes its published purpose and boundaries. The consuming project’s charter
          governs adapted decisions.
        </p>
      )}
      {parameters.get("saved") === "1" && (
        <output class="notice">
          Saved to the working file. Run workbench sync and review the intended changes before committing.
        </output>
      )}
      {panel(body, {
        tools,
        tabs: viewTabs(
          views.map(({ value: tab, label }) => ({
            label,
            href: viewLocation(context, recordURL(record.id), parameters, { view: tab }),
            current: view === tab,
          })),
          "Record views",
        ),
      })}
      {record.type === "CIT" && citationDocumentsPanel(context, record.id)}
      {attachments.length > 0 && (
        <section class="panel">
          <div class="panel-heading">
            <h2>Supporting files</h2>
          </div>
          {attachments.map((file) => (
            <a class="record-row" href={routeURL(Route.File, { id: record.id, path: file.path })}>
              {basename(file.path)} <span class="muted">{String(file.size)} bytes</span>
            </a>
          ))}
        </section>
      )}
      {related.length > 0 && (
        <>
          <h2>Referenced records</h2>
          {recordList(related)}
        </>
      )}
    </>,
    {
      parents: [
        { label: recordPresentations[record.type].label, href: sourceURL(context, "/records?type=" + record.type) },
      ],
    },
  );
}
export function supportingFilePage(
  context: ViewContext,
  record: BrowserRecord,
  path: string,
  contents: string | undefined,
): string {
  return shell(
    context,
    basename(path),
    record.type,
    <>
      <p class="file-path">{path}</p>
      <p>{linkButton("Download file", routeURL(Route.File, { id: record.id, path, download: "1" }), true)}</p>
      {panel(
        contents === undefined ? (
          <p>This file requires download for inspection.</p>
        ) : (
          <pre class="source">{contents}</pre>
        ),
      )}
    </>,
    { parents: [{ label: record.title, href: recordURL(record.id) }] },
  );
}
