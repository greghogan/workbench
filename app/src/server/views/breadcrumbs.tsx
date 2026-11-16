import type { JSX } from "preact";
import { projectName } from "../../core/projects/project-hierarchy.js";
import type { WorkspaceView } from "../workspace/workspace-service.js";
import { routeURL } from "../routes/locations.js";
import { Route } from "../routes/routes.js";
import { projectPath } from "../routes/project-paths.js";
export interface Breadcrumb {
  label: string;
  href: string;
}
export interface PageTrail {
  parents?: Breadcrumb[];
  scope?: string;
  current?: string;
}
export function breadcrumbs(context: WorkspaceView, { parents = [], scope, current }: PageTrail = {}): JSX.Element {
  const selected = scope ? context.projects.find((project) => project.id === scope) : context.selectedProject;
  const projects = selected ? context.index.hierarchy.lineage(selected) : context.projects.slice(0, 1);
  const trail: Breadcrumb[] = projects.map((project) => ({
    label: projectName(project),
    href: routeURL(Route.Overview, { scope: project.id }),
  }));
  if (context.selection)
    trail.push({ label: context.selection, href: routeURL(Route.Overview, { collection: context.selection }) });
  trail.push(...parents);
  return (
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {trail.map((item) => (
          <li>
            <a href={projectPath(item.href)}>{item.label}</a>
          </li>
        ))}
        {current && (
          <li aria-current="page">
            <span>{current}</span>
          </li>
        )}
      </ol>
    </nav>
  );
}
