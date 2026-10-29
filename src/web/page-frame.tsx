import type { ComponentChildren } from "preact";
import { mutationForm } from "./action-forms.js";
import { Route } from "./routes.js";
import { basename } from "node:path";
import { recordPresentations, recordTypes } from "../record-metadata.js";
import { breadcrumbs, type PageTrail } from "./breadcrumbs.js";
import { headerSearch, workbenchBrand } from "./components.js";
import { pageDocument } from "./page-document.js";
import { projectPath } from "./project-paths.js";
import { sourceNavigation } from "./source-navigation.js";
import { sourceURL } from "./sources.js";
import { workspaceProblemText } from "./workspace-problem.js";
import type { ViewContext, PageKey, SearchType } from "./view-context.js";
import { type TaskStatus } from "../record-document.js";
interface PageOptions extends PageTrail {
  search?: { query: string; type: SearchType };
  taskStatus?: TaskStatus;
}
export function shell(
  context: ViewContext,
  title: string,
  active: PageKey,
  body: ComponentChildren,
  options: PageOptions = {},
): string {
  const records = context.selectedRecords;
  const pending = context.pendingReviews;
  const navigation = (path: string, label: string, type: PageKey, count?: number) => (
    <a
      class="nav-item"
      href={path === Route.Review || path === Route.TaskQueue ? projectPath(path) : sourceURL(context, path)}
      aria-current={active === type ? "page" : undefined}
    >
      <span>{label}</span>
      {count !== undefined && <span class="nav-count">{String(count)}</span>}
    </a>
  );
  const recordNavigation = recordTypes
    .filter((type) => !context.selection || type === "CHARTER" || type === "ADR")
    .map((type) =>
      navigation(
        "/records?type=" + type,
        recordPresentations[type].label,
        type,
        records.filter((record) => record.type === type).length,
      ),
    );
  const nav = (
    <nav aria-label="Main navigation">
      <div class="nav-group">
        <p class="nav-group-label">Workflow</p>
        {navigation(Route.Review, "Review queue", "review", pending)}
        {navigation(Route.TaskQueue, "Task queue", "queue")}
      </div>
      <div class="nav-group">
        <p class="nav-group-label">Records</p>
        {navigation("/", "Overview", "")}
        {recordNavigation}
      </div>
    </nav>
  );
  const projectName = context.rootName.length
    ? context.rootName
    : context.projectName?.length
      ? context.projectName
      : basename(context.root);
  const projectControl =
    context.basePath || context.demonstration ? (
      <a class="project-switch" href="/projects" title={context.root}>
        <span class="project-switch-name">{projectName}</span>
        {context.demonstration && <span class="badge">Demonstration</span>}
        <span class="project-switch-action">
          Switch project <span aria-hidden="true">↗</span>
        </span>
      </a>
    ) : (
      <div class="project-context">
        <strong>{projectName}</strong>
      </div>
    );
  return pageDocument({
    title: title + (context.demonstration ? " · Demonstration" : ""),
    attributes: {
      "data-project-base": context.basePath ?? "",
      "data-revision": context.revision,
      "data-workspace-problem": context.problem,
    },
    contents: (
      <>
        <aside class="sidebar">
          {workbenchBrand()}
          {sourceNavigation(context, active, options.taskStatus)}
          {nav}
          <div class="sidebar-foot">
            <span class="file-path" title="Project directory">
              {context.root}
            </span>
          </div>
        </aside>
        <div class="workspace">
          <header class="topbar">
            {projectControl}
            {headerSearch(options.search, context.selection)}
          </header>
          <aside id="live-status" aria-live="polite" tabIndex={-1} hidden={!context.problem}>
            <span>{context.problem ? workspaceProblemText(context.problem) : ""}</span>
            <a href={projectPath(context.requestLocation ?? Route.Overview)}>Refresh</a>
            {mutationForm({
              action: Route.WorkspaceRetry,
              fields: {},
              csrf: context.csrf,
              context,
              children: () => <button type="submit">Retry refresh</button>,
            })}
          </aside>
          <main id="main" tabIndex={-1}>
            <div class="page-heading">
              {breadcrumbs(context, options)}
              <h1>{title}</h1>
            </div>

            {body}
          </main>
        </div>
      </>
    ),
  });
}
export function requestUnavailablePage(message: string): string {
  return pageDocument({
    title: "Request unavailable",
    interactive: false,
    contents: (
      <main id="main" tabIndex={-1}>
        <h1>Request unavailable</h1>
        <p>{message}</p>
        <p>
          <a href={projectPath("/")}>Return to the workspace</a>
        </p>
      </main>
    ),
  });
}
