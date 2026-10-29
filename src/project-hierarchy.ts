import type { Project } from "./project-model.js";

export const projectName = (project: Project): string => project.name ?? project.id;

/** Only declared scopes form the hierarchy; intermediate directories add no nodes or labels. */
export function projectParent(project: Project, projects: readonly Project[]): Project | undefined {
  if (project.path === ".") return undefined;
  return projects
    .filter(
      (candidate) =>
        candidate.id !== project.id && (candidate.path === "." || project.path.startsWith(`${candidate.path}/`)),
    )
    .sort((left, right) => right.path.length - left.path.length)[0];
}
export function projectLineage(project: Project, projects: readonly Project[]): Project[] {
  const parent = projectParent(project, projects);
  return [...(parent ? projectLineage(parent, projects) : []), project];
}
export function projectBreadcrumb(project: Project, projects: readonly Project[]): string {
  return projectLineage(project, projects).map(projectName).join("/");
}
