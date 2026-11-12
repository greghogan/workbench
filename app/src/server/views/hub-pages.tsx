import { cell } from "./cache-quantity.js";
import { ProjectCacheRow } from "./project-cache-row.js";
import type { ProjectDirectoryView } from "../projects/project-directory.js";
import type { RecoveryLink } from "../projects/recovery.js";
import { formatBytes } from "../../core/runtime/byte-size.js";
import type { ComponentChildren, JSX } from "preact";
import { renderToString } from "preact-render-to-string";

import { projectPathComparison, type RegisteredProject } from "../../core/projects/project-registry.js";
import { cacheQuantity as quantity } from "../cache/cache-quantity.js";
import { cacheRowKey as key, cacheMeasurement, projectCacheViews, InventoryIndex } from "../cache/cache-view-model.js";
import { badge, submitButton, workbenchBrand } from "./components.js";
import type { InventoryPatch, InventorySection } from "../cache/inventory-protocol.js";
import { mutationForm } from "./action-forms.js";
import { Route } from "../routes/routes.js";
import { routeURL } from "../routes/locations.js";
import type { InventoryView } from "../cache/inventory-service.js";
import { pageDocument } from "./page-document.js";
import type { ProjectReviewCount } from "../projects/project-reviews.js";
import { cacheOperations } from "../../core/storage/cache-operation-contract.js";

export const hubLayout = (
  title: string,
  body: ComponentChildren,
  options: { active?: "projects" | "caches"; interactive?: boolean } = {},
): string =>
  pageDocument({
    title,
    interactive: options.interactive ?? true,
    attributes: {
      "data-project-hub": "",
      "data-events-url": routeURL(Route.Events, {}),
    },
    contents: (
      <>
        <header class="hub-header">
          {workbenchBrand()}
          <nav aria-label="Workbench">
            <a href="/projects" aria-current={options.active === "projects" ? "page" : undefined}>
              Projects
            </a>
            <a href="/caches" aria-current={options.active === "caches" ? "page" : undefined}>
              Caches
            </a>
          </nav>
        </header>
        <main id="main" tabIndex={-1}>
          <h1>{title}</h1>
          <output id="inventory-status" class="notice" hidden>
            <span></span> <a href={options.active === "caches" ? Route.Caches : Route.Projects}>Refresh</a>
          </output>
          {body}
        </main>
      </>
    ),
  });
const lines = (values: string[]): ComponentChildren =>
  values.map((value, index) => (
    <>
      {index > 0 && <br />}
      {value}
    </>
  ));
export interface InventoryPresentation {
  location: string;
  rows: Partial<Record<InventorySection, JSX.Element[]>>;
  problems: string[];
  refreshing: boolean;
  sizes: InventoryPatch["sizes"];
  page: "projects" | "caches";
  owner: string | null | undefined;
  csrf: string;
}
export function inventoryPresentation(
  data: InventoryView,
  projects: RegisteredProject[],
  csrf: string,
  page: "projects" | "caches",
  owner?: string | null,
  reviews: ReadonlyMap<string, ProjectReviewCount> = new Map(),
  metadata?: ProjectDirectoryView,
): InventoryPresentation {
  const sizes = new Map(data.sizes.map((entry) => [entry.directory, entry]));
  const index = new InventoryIndex(data);
  const entries = data.inventory.entries.filter((entry) => !owner || entry.identity.checkout === owner);
  const accountingUnknown = data.issues.some((issue) => ["builds", "builders", "registry"].includes(issue.component));
  const rows: InventoryPresentation["rows"] = {};
  const models = projectCacheViews(index, projects, page, owner, metadata);
  const measured = new Set(
    models.flatMap((model) => [
      ...model.owned.map((entry) => entry.directory),
      ...model.tools.map((entry) => entry.directory),
    ]),
  );
  rows.projects = models.map((model) => (
    <ProjectCacheRow
      model={model}
      sizes={sizes}
      accountingUnknown={accountingUnknown}
      reviews={reviews}
      csrf={csrf}
      page={page}
    />
  ));
  if (page === "caches") {
    rows.operations = cacheOperations(data.inventory).map((entry) => {
      const id = key("operation-", entry.directory);
      return (
        <tr data-cache-row={id}>
          <td class="file-path" data-cache-cell={id + "-path"}>
            {entry.directory}
          </td>
          <td data-cache-cell={id + "-kind"}>{entry.action}</td>
          {entry.measurement ? (
            cell(id + "-size", quantity(data.complete, sizes, [entry.measurement.directory]))
          ) : (
            <td>{formatBytes(entry.bytes)}</td>
          )}
          <td data-cache-cell={id + "-status"}>{entry.problem ?? entry.state}</td>
          <td data-cache-cell={id + "-actions"}>
            {entry.state !== "active" &&
              mutationForm({
                action: Route.CacheRecover,
                csrf,
                fields: { directory: entry.directory },
                children: () => (
                  <>
                    {submitButton(entry.state === "uncertain" ? "Review deletion" : "Finish cleanup", {
                      secondary: true,
                    })}
                  </>
                ),
              })}
          </td>
        </tr>
      );
    });
    rows.roots = entries.map((entry) => {
      const id = key("root-", entry.directory);
      return (
        <tr data-cache-row={id}>
          <td class="file-path">{entry.identity.root}</td>
          <td>{entry.kind}</td>
          <td>{entry.identity.environment}</td>
          {cell(id + "-size", quantity(data.complete, sizes, [entry.directory]))}
          <td data-cache-cell={id + "-status"}>{entry.blockedBy?.length ? entry.blockedBy : "Removable"}</td>
          <td data-cache-cell={id + "-actions"}>
            {mutationForm({
              action: Route.CachePrepare,
              csrf,
              fields: { unlisted: entry.identity.checkout, root: entry.identity.root },
              children: () => <>{submitButton("Clear root", { secondary: true })}</>,
            })}
            {mutationForm({
              action: Route.CacheKeep,
              csrf,
              class: "inline",
              fields: { identity: entry.directory, keep: data.kept.includes(entry.directory) ? "no" : "yes" },
              children: () => (
                <>
                  {submitButton(data.kept.includes(entry.directory) ? "Release keep" : "Keep generation", {
                    secondary: true,
                  })}
                </>
              ),
            })}
          </td>
        </tr>
      );
    });
    rows.tools = (data.inventory.tools?.entries ?? []).map((tool) => {
      const id = key("tool-", tool.id),
        consumers = data.consumers[tool.id] ?? [];
      const state = tool.protections.some((reason) => reason.kind === "active")
        ? "Active"
        : tool.protections.some((reason) => reason.kind === "lock")
          ? "Locked; inspect owner"
          : tool.protections.length
            ? "Retained"
            : "Unused";
      const older = index.isOlder(tool);
      return (
        <tr data-cache-row={id}>
          <td>
            {tool.tool} {tool.version}
            {older && badge("Older")}
          </td>
          {cell(id + "-size", quantity(data.complete, sizes, [tool.directory]))}
          <td data-cache-cell={id + "-state"}>
            {state}
            {data.prunable.includes(tool.id) ? " · removable" : ""}
          </td>
          <td data-cache-cell={id + "-consumers"}>{consumers.length ? lines(consumers) : "No known consumers"}</td>
          <td data-cache-cell={id + "-protection"}>{lines(tool.protections.map((entry) => entry.reason))}</td>
          <td data-cache-cell={id + "-actions"}>
            {mutationForm({
              action: Route.CacheKeep,
              csrf,
              fields: { identity: tool.directory, keep: data.kept.includes(tool.directory) ? "no" : "yes" },
              children: () => (
                <>{submitButton(data.kept.includes(tool.directory) ? "Release keep" : "Keep", { secondary: true })}</>
              ),
            })}
          </td>
        </tr>
      );
    });
    rows.builders = (data.inventory.builders?.entries ?? [])
      .filter((entry) => !owner || entry.checkout === owner)
      .map((entry) => {
        const id = key("builder-", entry.key);
        return (
          <tr data-cache-row={id}>
            <td data-cache-cell={id + "-name"}>{entry.key}</td>
            <td data-cache-cell={id + "-size"}>{formatBytes(entry.bytes)}</td>
            <td data-cache-cell={id + "-status"}>{entry.blockedBy ?? "Eligible"}</td>
          </tr>
        );
      });
    rows.images = (data.inventory.images?.entries ?? [])
      .filter((entry) => !owner || entry.checkout === owner)
      .map((entry) => {
        const id = key("image-", entry.key);
        return (
          <tr data-cache-row={id}>
            <td data-cache-cell={id + "-name"}>{entry.reference}</td>
            <td data-cache-cell={id + "-size"}>{formatBytes(entry.bytes)}</td>
            <td data-cache-cell={id + "-status"}>{entry.blockedBy ?? "Tag removable"}</td>
            <td>Reclaimed layer bytes unknown</td>
          </tr>
        );
      });
  }
  const problems = [
    ...new Set([
      ...data.issues.map(
        (issue) => issue.component + " · " + issue.phase + ": " + (issue.path ? issue.path + ": " : "") + issue.message,
      ),
      ...(data.problem ? [data.problem] : []),
    ]),
  ];
  const registered = projects.find(
    (project) => owner && projectPathComparison(project.path) === projectPathComparison(owner),
  );
  const location = routeURL(Route.Inventory, {
    view: page,
    ...(registered ? { project: registered.id } : owner ? { owner } : {}),
  });
  return {
    rows,
    problems,
    refreshing: data.refreshing,
    sizes: data.sizes.filter((size) => page !== "projects" || measured.has(size.directory)).map(cacheMeasurement),
    page,
    owner,
    csrf,
    location,
  };
}
/** Initial pages and live updates share the same row nodes, with explicit serialization boundaries. */
export function inventoryPatch(view: InventoryPresentation): InventoryPatch {
  return {
    sections: Object.fromEntries(Object.entries(view.rows).map(([name, rows]) => [name, renderToString(<>{rows}</>)])),
    problems: view.problems,
    refreshing: view.refreshing,
    sizes: view.sizes,
  };
}
export function inventoryContent(view: InventoryPresentation): JSX.Element {
  const { rows, page, owner, problems } = view;
  const projectTable = (
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            {page === "projects" ? (
              <>
                <th>Reviews</th>
                <th>Cache</th>
              </>
            ) : (
              <>
                <th>Owned</th>
                <th>Eligible</th>
                <th>Retained</th>
                <th>Tools</th>
                <th>Shared</th>
                <th>Images</th>
              </>
            )}
            <th>Actions</th>
          </tr>
        </thead>
        <tbody data-cache-rows="projects">{rows.projects}</tbody>
      </table>
    </div>
  );
  const tables = page === "caches" && (
    <>
      <section data-cache-section="operations" hidden={!rows.operations?.length}>
        <h2>Incomplete cache operations</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Path</th>
                <th>Operation</th>
                <th>Size</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody data-cache-rows="operations">{rows.operations}</tbody>
          </table>
        </div>
      </section>
      <p>
        <a href={routeURL(Route.Caches, { refresh: "1", "refresh-sizes": "1", ...(owner ? { owner } : {}) })}>
          Recalculate sizes
        </a>
      </p>
      <h2>Build roots</h2>
      <p>Roots can serve multiple subprojects. Shared workspace builds are cleared together. Sizes are estimates.</p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Root</th>
              <th>Kind</th>
              <th>Environment</th>
              <th>Size</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody data-cache-rows="roots">{rows.roots}</tbody>
        </table>
      </div>
      <h2>Shared tool installations</h2>
      <p>
        Referenced footprints overlap between projects. Unavailable requirements protect tools without claiming every
        installation as a consumer.
      </p>
      {mutationForm({
        action: Route.CacheUnused,
        csrf: view.csrf,
        fields: {},
        children: () => <>{submitButton("Prune unused assets", { secondary: true })}</>,
      })}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              <th>Size</th>
              <th>Status</th>
              <th>Known consumers</th>
              <th>Protection</th>
              <th>Retention</th>
            </tr>
          </thead>
          <tbody data-cache-rows="tools">{rows.tools}</tbody>
        </table>
      </div>
      <h2>Builder stores</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Builder</th>
              <th>Estimate</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody data-cache-rows="builders">{rows.builders}</tbody>
        </table>
      </div>
      <h2>Prepared images</h2>
      <p>
        Logical sizes include shared layers. Removing an image tag may reclaim less space; reclaimable layer bytes are
        unknown.
      </p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Image</th>
              <th>Logical footprint</th>
              <th>Status</th>
              <th>Reclaimable space</th>
            </tr>
          </thead>
          <tbody data-cache-rows="images">{rows.images}</tbody>
        </table>
      </div>
    </>
  );
  return (
    <section
      data-cache-content=""
      data-inventory-url={view.location}
      data-cache-sizes={JSON.stringify(view.sizes)}
      data-cache-refreshing={String(view.refreshing)}
    >
      <div data-cache-problems="">
        {problems.map((problem) => (
          <p class="notice">{problem}</p>
        ))}
      </div>
      {projectTable}
      {tables}
    </section>
  );
}
export function projectDashboard(
  data: InventoryView,
  projects: RegisteredProject[],
  csrf: string,
  reviews: ReadonlyMap<string, ProjectReviewCount> = new Map(),
  metadata?: ProjectDirectoryView,
): string {
  return hubLayout(
    "Projects",
    <>
      {inventoryContent(inventoryPresentation(data, projects, csrf, "projects", undefined, reviews, metadata))}
      <section class="panel panel-body">
        <h2>Add a project</h2>
        {mutationForm({
          action: Route.ProjectAdd,
          csrf,
          fields: {},
          class: "form-grid",
          children: (controls) => (
            <>
              {controls.text("path", {
                id: "project-directory",
                label: "Project directory on the server",
                required: true,
              })}
              {submitButton("Add project")}
            </>
          ),
        })}
      </section>
      <section class="panel panel-body">
        <h2>Demonstration</h2>
        <p>Explore every record type using disposable example data.</p>
        {mutationForm({
          action: Route.Demonstration,
          csrf,
          fields: {},
          children: () => <>{submitButton("Open demonstration", { secondary: true })}</>,
        })}
      </section>
    </>,
    { active: "projects" },
  );
}
export function cleanupPage(
  proposal: { title: string; bytes: number | undefined; items: string[] },
  csrf: string,
  token: string,
): string {
  return hubLayout(
    proposal.title,
    <>
      <p>
        {formatBytes(proposal.bytes)} estimated filesystem cleanup. Shared image layers may remain. Project files are
        preserved.
      </p>
      <ul>
        {proposal.items.length ? (
          proposal.items.map((item) => <li class="file-path">{item}</li>)
        ) : (
          <li>No removable caches.</li>
        )}
      </ul>
      {mutationForm({
        action: Route.CleanupApply,
        csrf,
        fields: { token },
        children: (controls) => (
          <>
            {controls.confirmation(
              "reviewed",
              "I have reviewed the cache deletion and project removal, when selected.",
            )}
            {submitButton("Apply reviewed cleanup")}
          </>
        ),
      })}
    </>,
    { interactive: false },
  );
}
export function hubErrorPage(message: string, recovery?: RecoveryLink): string {
  return hubLayout(
    "Operation unavailable",
    <>
      <p>{message}</p>
      <p>
        <a href={recovery?.href ?? "/projects"}>{recovery?.label ?? "Return to projects"}</a>
      </p>
    </>,
    { interactive: false },
  );
}
