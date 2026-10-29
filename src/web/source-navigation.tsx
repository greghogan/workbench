import type { JSX } from "preact";
import type { Project } from "../project-model.js";
import { projectLineage, projectName, projectParent } from "../project-hierarchy.js";
import { recordTypes } from "../record-metadata.js";
import type { WorkspaceView } from "../workspace-service.js";
import { projectPath } from "./project-paths.js";
import { routeURL } from "./locations.js";
import { type SourceQuery, Route } from "./routes.js";
import type { TaskStatus } from "../record-document.js";

import type { PageKey } from "./view-context.js";

/** Links select one declared scope; the filesystem determines ancestry, never the displayed labels. */
export function sourceNavigation(context: WorkspaceView, active: PageKey, taskStatus?: TaskStatus): JSX.Element {
  const browsing = active !== "collections" && active !== "queue" && active !== "review";
  const destination =
    active === "review" || active === "records" || recordTypes.some((type) => type === active)
      ? Route.Records
      : Route.Overview;
  const href = (source: SourceQuery) => {
    const type = recordTypes.find((type) => type === active);
    if (destination === Route.Records)
      return routeURL(Route.Records, {
        ...source,
        ...(type && (!source.collection || type === "ADR" || type === "CHARTER") ? { type } : {}),
        ...(type === "TSK" && taskStatus && !source.collection ? { status: taskStatus } : {}),
      });
    return routeURL(Route.Overview, source);
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
        id={"source-toggle-project-" + project.id}
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
            browsing && !context.selection && (context.all ? project.path === "." : context.scope === project.id),
            projectName(project) + " (" + project.id + ")",
          )}
        </div>
        {descendants.length > 0 && <ul id={id}>{descendants.map(branch)}</ul>}
      </li>
    );
  };
  const root = context.projects.find((project) => project.path === ".");
  const localIds = new Set(
    context.collections.filter((collection) => collection.local).map((collection) => collection.pin.id),
  );
  const collections = (
    <li class="source-collection-group">
      <div class="source-row">
        {context.sources.length > 0 ? (
          <button
            type="button"
            class="source-toggle"
            id="source-toggle-collections"
            data-source-toggle="collections:"
            data-source-active={context.sources.includes(context.selection) ? "true" : "false"}
            data-source-default="true"
            aria-controls="source-collection-children"
            aria-expanded="true"
            aria-label="Toggle collections"
            hidden
          >
            <span aria-hidden="true">›</span>
          </button>
        ) : (
          folderIcon
        )}
        <a
          class="source-link source-group-label"
          href={projectPath("/collections")}
          aria-current={active === "collections" ? "page" : undefined}
        >
          Collections
        </a>
      </div>
      {context.sources.length > 0 && (
        <ul id="source-collection-children">
          {context.sources.map((id) => (
            <li>
              <div class="source-row">
                {localIds.has(id) ? (
                  <span class="source-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none">
                      <rect x="3" y="3" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.5" />
                      <path d="M12 16v5M7 21h10" stroke="currentColor" stroke-width="1.5" />
                    </svg>
                  </span>
                ) : (
                  folderIcon
                )}
                {link(
                  id,
                  href({ collection: id }),
                  browsing && context.selection === id,
                  localIds.has(id) ? "Local collection · read only" : "Project collection",
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
  return (
    <nav class="source-navigation" aria-label="Record sources" data-source-navigation="">
      <p class="nav-group-label">Sources</p>
      <ul class="source-tree">
        {root && branch(root)}
        {collections}
      </ul>
    </nav>
  );
}
