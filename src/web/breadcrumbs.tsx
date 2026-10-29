import type { JSX } from "preact";
import { projectLineage, projectName } from "../project-hierarchy.js";
import type { WorkspaceView } from "../workspace-service.js";
import { routeURL } from "./locations.js";
import { Route } from "./routes.js";
import { projectPath } from "./project-paths.js";
export interface Breadcrumb {
  label: string;
  href: string;
}
export interface PageTrail {
  parents?: Breadcrumb[];
  scope?: string;
}
export function breadcrumbs(context: WorkspaceView, { parents = [], scope }: PageTrail = {}): JSX.Element {
  const selected = scope ? context.projects.find((project) => project.id === scope) : context.selectedProject;
  const projects = selected ? projectLineage(selected, context.projects) : context.projects.slice(0, 1);
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
      </ol>
    </nav>
  );
}
