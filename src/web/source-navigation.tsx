import type { JSX } from "preact";
import type { Project } from "../project-model.js";
import { projectLineage, projectName, projectParent } from "../project-hierarchy.js";
import { recordTypes } from "../record-metadata.js";
import type { WorkspaceView } from "../workspace-service.js";
import { projectPath } from "./project-paths.js";
import { routeURL } from "./locations.js";
import { type SourceQuery, Route } from "./routes.js";

import type { PageKey } from "./view-context.js";

/** Links select one declared scope; the filesystem determines ancestry, never the displayed labels. */
export function sourceNavigation(context: WorkspaceView, active: PageKey): JSX.Element {
  const browsing = active !== "collections";
  const destination =
    active === "review"
      ? Route.Review
      : active === "records" || recordTypes.some((type) => type === active)
        ? Route.Records
        : Route.Overview;
  const href = (source: SourceQuery) => {
    const type = recordTypes.find((type) => type === active);
    if (destination === Route.Records)
      return routeURL(Route.Records, {
        ...source,
        ...(type && (!source.collection || type === "ADR" || type === "CHARTER") ? { type } : {}),
      });
    return destination === Route.Review ? routeURL(Route.Review, source) : routeURL(Route.Overview, source);
  };
  const link = (label: string, url: string, current: boolean, title?: string) => (
    <a class="source-link" href={url} aria-current={current ? "page" : undefined} title={title}>
      {label}
    </a>
  );
  const ancestors = new Set(
    context.selectedProject
      ? projectLineage(context.selectedProject, context.projects).map((project) => project.id)
      : [],
  );
  const children = new Map<string, Project[]>();
  for (const project of context.projects) {
    const parent = projectParent(project, context.projects);
    if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), project]);
  }
  const folderIcon = (
    <span class="source-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M3 6h6l2 2h10v11H3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      </svg>
    </span>
  );
  const branch = (project: Project): JSX.Element => {
    const descendants = children.get(project.id) ?? [];
    const id = "source-branch-" + project.id;
    const toggle = descendants.length ? (
      <button
        type="button"
        class="source-toggle"
        data-source-toggle={project.id}
        data-source-active={ancestors.has(project.id) && project.id !== context.scope ? "true" : "false"}
        data-source-default={project.path === "." ? "true" : "false"}
        aria-controls={id}
        aria-expanded="true"
        aria-label={"Toggle subprojects of " + projectName(project)}
        hidden
      >
        <span aria-hidden="true">›</span>
      </button>
    ) : (
      folderIcon
    );
    return (
      <li>
        <div class="source-row">
          {toggle}
          {link(
            projectName(project),
            href({ scope: project.id }),
            browsing && !context.selection && !context.all && context.scope === project.id,
            projectName(project) + " (" + project.id + ")",
          )}
        </div>
        {descendants.length > 0 && <ul id={id}>{descendants.map(branch)}</ul>}
      </li>
    );
  };
  const root = context.projects.find((project) => project.path === ".");
  const collections = (
    <li class="source-collection-group">
      <div class="source-row">
        <button
          type="button"
          class="source-toggle"
          data-source-toggle="collections:"
          data-source-active={context.selection ? "true" : "false"}
          data-source-default="true"
          aria-controls="source-collection-children"
          aria-expanded="true"
          aria-label="Toggle collections"
          hidden
        >
          <span aria-hidden="true">›</span>
        </button>
        <span class="source-group-label">Collections</span>
        <a
          class="source-manage"
          href={projectPath("/collections")}
          aria-label="Manage collections"
          title="Manage collections"
          aria-current={active === "collections" ? "page" : undefined}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m9 3-.5 3-2 .9-2.5-1.3-2 3.5 2.4 1.9v2L2 15l2 3.5 2.5-1.3 2 .9.5 3h4l.5-3 2-.9 2.5 1.3 2-3.5-2.4-2v-2L20 9l-2-3.5-2.5 1.3-2-.9L13 3z"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linejoin="round"
            />
            <circle cx="11" cy="12" r="3" stroke="currentColor" stroke-width="1.3" />
          </svg>
        </a>
      </div>
      <ul id="source-collection-children">
        {context.sources.length ? (
          context.sources.map((id) => (
            <li>
              <div class="source-row">
                {folderIcon}
                {link(id, href({ collection: id }), browsing && context.selection === id)}
              </div>
            </li>
          ))
        ) : (
          <li class="source-empty">None installed</li>
        )}
      </ul>
    </li>
  );
  const allSources = (
    <li>
      <div class="source-row">
        <span class="source-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <rect x="5" y="4" width="14" height="17" rx="2" stroke="currentColor" stroke-width="1.5" />
            <path
              d="M9 4V2H3v15h2M9 9h6M9 13h6M9 17h4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        {link("All sources", href({ all: "1" }), browsing && context.all, "Project, subprojects, and collections")}
      </div>
    </li>
  );
  return (
    <nav class="source-navigation" aria-label="Record sources" data-source-navigation="">
      <p class="nav-group-label">Sources</p>
      <ul class="source-tree">
        {allSources}
        {root && branch(root)}
        {collections}
      </ul>
    </nav>
  );
}
