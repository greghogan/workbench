import type { ComponentChildren, JSX } from "preact";
import { basename, extname } from "node:path";
import type { BrowserRecord } from "../record-service.js";
import { citationMetadata, recordPresentations, yamlMetadata } from "../record-metadata.js";
import { adaptationsPanel } from "./collection-summary.js";
import { badge, panel, submitButton } from "./components.js";
import { WebError } from "./errors.js";
import { recordSearch, viewLocation } from "./navigation-state.js";
import { projectPath } from "./project-paths.js";
import { recordBatch, RecordOrder } from "./record-listing.js";
import { diffLayout, linkButton, tabs as viewTabs } from "./render-links.js";
import { comparisonView, sourceDiffView, fileModeChange } from "./diff-view.js";
import { mutationForm } from "./action-forms.js";
import { Route, type RouteQuery } from "./routes.js";
import { markdown } from "./markdown-view.js";
import { metadataSections, recordList } from "./record-content.js";
import { recordURL, routeURL, withView } from "./locations.js";
import { recordPageModel, type RemovedDecisionModel } from "./record-page-model.js";
import { shell } from "./page-frame.js";
import { type ViewContext } from "./view-context.js";
import { sourceURL } from "./sources.js";
import { experimentControls } from "./experiment-pages.js";
import { taskControls, taskChildren, taskNavigation, tasksPage } from "./task-pages.js";
import { recordPane, recordNeighbors } from "./record-pane.js";

export function recordsPage(context: ViewContext, parameters: RouteQuery<typeof Route.Records>): string {
  const { type, scope, query } = recordSearch(parameters);
  const status = parameters.status;
  if (parameters.attention && type !== "TSK") throw new WebError(400, "Task attention requires the TSK record type");
  if (status && type !== "TSK") throw new WebError(400, "Task status requires the TSK record type");
  const found = context
    .searchRecords({ type, scope, query })
    .filter(
      (record) =>
        (!status || record.status === status) &&
        (parameters.attention !== "1" || context.index.snapshot.tasks.errors.has(record.id)),
    );
  if (type === "TSK" && !query && !status && parameters.attention !== "1") {
    return tasksPage(context, found, parameters);
  }
  if (parameters.after !== undefined && parameters.cursor_revision && parameters.cursor_revision !== context.revision)
    throw new WebError(409, "record list changed; refresh the list before loading more records");
  const { visible, more, previous, startAfter } = recordBatch(
    found,
    parameters.after ?? null,
    parameters.through ?? null,
    parameters.before ?? null,
    status ? RecordOrder.TaskDescending : RecordOrder.Identity,
  );
  const queryParameters = new URLSearchParams(Object.entries(parameters));
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
    status
      ? status + " tasks"
      : type
        ? (type === "CHARTER" ? "Charter" : type) + " records"
        : query
          ? "Search results"
          : "Records",
    type || "records",
    <>
      {status && taskNavigation(context, status)}
      <p class="muted">{String(found.length)} matching record(s).</p>
      <div id="record-previous">{previousLink}</div>
      <div id="record-list" data-list-revision={context.revision} data-window-after={startAfter}>
        {recordList(visible, context)}
      </div>
      <div id="record-loader">{loader}</div>
      <output id="record-loading-status" class="sr-only"></output>
      {type === "ADR" && adaptationsPanel(context)}
    </>,
    {
      search: { query, type },
      ...(status
        ? { taskStatus: status, parents: [{ label: "Tasks", href: sourceURL(context, "/records?type=TSK") }] }
        : {}),
    },
  );
}
function removedDecisionPage(
  context: ViewContext,
  parameters: RouteQuery<typeof Route.Record>,
  model: RemovedDecisionModel,
): string {
  const { decision, view, path, split, base } = model;
  const upstream = model.baseline === "upstream";
  const controls = (
    <div class="actions">
      {linkButton(
        "Compare with " + (upstream ? "reviewed record" : "pinned upstream"),
        viewLocation(context, base, parameters, { view: "changes", baseline: upstream ? "reviewed" : "upstream" }),
        true,
      )}
    </div>
  );
  const previous = context.index.snapshot.removedReviews.get(decision.id);
  const difference = upstream
    ? sourceDiffView(
        context.index.snapshot.upstreamDiffs.get(decision.id),
        { record: { directory: context.root, path }, records: context.index.references },
        split,
      )
    : comparisonView(
        previous ?? { state: "available", difference: null },
        { record: { directory: context.root, path }, records: context.index.references },
        split,
      );
  const body =
    view === "read" ? (
      markdown(decision.before, { directory: context.root, path }, context.index.references)
    ) : (
      <>
        <p class="muted">
          {upstream
            ? "Pinned upstream → project copy (working file). This includes committed adaptations."
            : "Reviewed record → current file."}
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
      <p class="record-location">
        <span class="file-path">{path}</span>
        {badge(decision.id)}
        {badge("Removed from collection", "pending")}
      </p>
      <p class="notice">This ADR exists in the pinned collection and has been removed from the project copy.</p>
      {recordPane(
        panel(body, {
          tabs: viewTabs(
            (["read", "changes"] as const).map((value) => ({
              label: value === "read" ? "Read" : "Changes",
              href: viewLocation(context, base, parameters, { view: value }),
              current: view === value,
            })),
            "Record views",
          ),
          tools:
            view === "changes"
              ? diffLayout(withView(base, { view: "changes", baseline: model.baseline }), split)
              : null,
        }),
        recordNeighbors(context, {
          id: decision.id,
          type: "ADR",
          scope: decision.id.split(":")[0] ?? context.selection,
        }),
      )}
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
      {citation.sources.map((source) => {
        const url = routeURL(Route.CitationDocument, { id, source: source.kind });
        return (
          <section class="citation-source">
            <h3>{source.kind === "arxiv" ? "arXiv" : source.kind}</h3>
            <p>
              {badge(
                source.format === "html"
                  ? source.present
                    ? "Reader present locally"
                    : "Reader missing locally"
                  : source.present
                    ? "File present locally"
                    : "File missing locally",
                source.present ? "approved" : "pending",
              )}
              {source.format === "html" &&
                badge(
                  source.originalPresent ? "Original present locally" : "Original missing locally",
                  source.originalPresent ? "approved" : "pending",
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
                  {linkButton("Read", url)}
                  {linkButton(
                    "Download",
                    routeURL(Route.CitationDocument, { id, source: source.kind, download: "1" }),
                    true,
                  )}
                </>
              )}
              {source.format === "html" &&
                source.originalPresent &&
                linkButton("Original", routeURL(Route.CitationOriginal, { id, source: source.kind }), true)}
              <a class="button secondary" href={source.landingUrl} rel="noreferrer noopener">
                Source
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
  parameters: RouteQuery<typeof Route.Record>,
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
          <p class="muted">Save changes to the current file, then review them.</p>
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
        <a href={projectPath("/review")}>Review files</a>
      </div>
    );
    body =
      baseline === "upstream" ? (
        context.comparison?.state === "compared" && compared ? (
          <>
            <p class="muted">Pinned upstream → project copy (working file). This includes committed adaptations.</p>
            <p class="file-path">Upstream revision: {context.comparison.revision}</p>
            {controls}
            {sourceDiffView(
              model.upstream && (model.upstream.before !== model.upstream.after || model.upstream.patch)
                ? model.upstream
                : null,
              { record, records: context.index.references, pageTitle: record.title },
              split,
            )}
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
          {controls}
          {document.modeChange && (
            <p class="notice">{fileModeChange(document.modeChange.before, document.modeChange.after)}</p>
          )}
          {comparisonView(
            model.reviewed,
            { record, records: context.index.references, pageTitle: record.title },
            split,
          )}
        </>
      );
  } else if (recordPresentations[record.type].format !== "markdown") {
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
  const supportingPath = record.path.slice(0, -extname(record.path).length);
  return shell(
    context,
    record.title,
    record.type,
    <>
      <p class="record-location">
        <span class="file-path">{record.path}</span>
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
      {record.type === "CHARTER" && record.collection && (
        <p class="notice">
          This collection charter describes its published purpose and boundaries. The consuming project’s charter
          governs adapted decisions.
        </p>
      )}
      {parameters.saved === "1" && (
        <output class="notice">
          Saved to the working file. Run workbench sync and review the intended changes before committing.
        </output>
      )}
      {taskChildren(context, record)}
      {experimentControls(context, record)}
      {recordPane(
        panel(body, {
          tools,
          tabs:
            views.length > 1
              ? viewTabs(
                  views.map(({ value: tab, label }) => ({
                    label,
                    href: viewLocation(context, recordURL(record.id), parameters, { view: tab }),
                    current: view === tab,
                  })),
                  "Record views",
                )
              : null,
        }),
        recordNeighbors(context, record),
      )}
      {record.type === "CIT" && citationDocumentsPanel(context, record.id)}
      {taskControls(context, record)}
      {attachments.length > 0 && (
        <section class="panel">
          <div class="panel-heading">
            <h2>
              <a href={routeURL(Route.File, { id: record.id, path: supportingPath })}>Supporting files</a>
            </h2>
          </div>
          {attachments.map((file) => (
            <a class="record-row" href={routeURL(Route.File, { id: record.id, path: file.path })}>
              {file.path.slice(supportingPath.length + 1)} <span class="muted">{String(file.size)} bytes</span>
            </a>
          ))}
        </section>
      )}
      {related.length > 0 && (
        <>
          <h2>Referenced records</h2>
          {recordList(related, context)}
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
function supportingBreadcrumbs(context: ViewContext, record: BrowserRecord, path: string) {
  const base = record.path.slice(0, -extname(record.path).length);
  const parents = [
    { label: recordPresentations[record.type].label, href: sourceURL(context, "/records?type=" + record.type) },
    { label: record.title, href: recordURL(record.id) },
  ];
  if (path !== base)
    parents.push({ label: "Supporting files", href: routeURL(Route.File, { id: record.id, path: base }) });
  let directory = base;
  for (const name of path
    .slice(base.length + 1)
    .split("/")
    .slice(0, -1)) {
    directory += "/" + name;
    parents.push({ label: name, href: routeURL(Route.File, { id: record.id, path: directory }) });
  }
  return parents;
}

export function supportingDirectoryPage(
  context: ViewContext,
  record: BrowserRecord,
  path: string,
  files: { path: string; size: number }[],
): string {
  const entries = new Map<string, { path: string; directory: boolean; size: number }>();
  for (const file of files) {
    if (!file.path.startsWith(path + "/")) continue;
    const name = file.path.slice(path.length + 1).split("/")[0];
    if (!name) continue;
    const target = path + "/" + name;
    entries.set(name, { path: target, directory: target !== file.path, size: file.size });
  }
  const ordered = [...entries].sort(
    ([a, left], [b, right]) =>
      Number(right.directory) - Number(left.directory) || a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  const base = record.path.slice(0, -extname(record.path).length);
  return shell(
    context,
    path === base ? "Supporting files" : basename(path),
    record.type,
    <section class="panel">
      {ordered.length ? (
        ordered.map(([name, entry]) => (
          <a class="record-row" href={routeURL(Route.File, { id: record.id, path: entry.path })}>
            {name}
            {entry.directory ? (
              "/"
            ) : (
              <>
                {" "}
                <span class="muted">{String(entry.size)} bytes</span>
              </>
            )}
          </a>
        ))
      ) : (
        <p class="panel-body">No supporting files.</p>
      )}
    </section>,
    { parents: supportingBreadcrumbs(context, record, path) },
  );
}

export function supportingFilePage(
  context: ViewContext,
  record: BrowserRecord,
  path: string,
  contents: string | undefined,
): string {
  const files = context.document(record.id).files;
  const index = files.findIndex((file) => file.path === path);
  const step = (file: (typeof files)[number] | undefined) =>
    file ? { href: routeURL(Route.File, { id: record.id, path: file.path }), title: basename(file.path) } : undefined;
  return shell(
    context,
    basename(path),
    record.type,
    <>
      <p class="file-path">{path}</p>
      <p>{linkButton("Download file", routeURL(Route.File, { id: record.id, path, download: "1" }), true)}</p>
      {recordPane(
        panel(
          contents === undefined ? (
            <p>This file requires download for inspection.</p>
          ) : [".md", ".markdown"].includes(extname(path).toLowerCase()) ? (
            markdown(contents, { directory: record.directory, path }, context.index.references)
          ) : (
            <pre class="source">{contents}</pre>
          ),
        ),
        {
          previous: index > 0 ? step(files[index - 1]) : undefined,
          next: index >= 0 ? step(files[index + 1]) : undefined,
          label: "supporting file",
        },
      )}
    </>,
    { parents: supportingBreadcrumbs(context, record, path) },
  );
}
