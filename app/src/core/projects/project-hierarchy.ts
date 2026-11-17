import type { Project } from "./project-model.js";

export const projectName = (project: Project): string => project.name ?? project.id;

/** Declared scopes own the nodes; each caller chooses declaration order or sorted traversal. */
export class ProjectHierarchy {
  private readonly parents = new Map<string, Project>();
  private readonly descendants = new Map<string, Project[]>();
  private readonly lineages = new Map<string, readonly Project[]>();
  private readonly labels = new Map<string, string>();
  readonly roots: readonly Project[];
  private readonly paths: ReadonlyMap<string, Project>;
  constructor(readonly projects: readonly Project[]) {
    const paths = new Map(projects.map((project) => [project.path, project]));
    this.paths = paths;
    const roots: Project[] = [];
    for (const project of projects) {
      let path = project.path;
      let parent: Project | undefined;
      while (path !== ".") {
        const boundary = path.lastIndexOf("/");
        path = boundary < 0 ? "." : path.slice(0, boundary);
        parent = paths.get(path);
        if (parent) break;
      }
      if (parent) {
        this.parents.set(project.id, parent);
        const children = this.descendants.get(parent.id) ?? [];
        children.push(project);
        this.descendants.set(parent.id, children);
      } else roots.push(project);
    }
    this.roots = roots;
  }
  /** Only declared scopes own record roots; intermediate directories are not scopes. */
  recordOwner(path: string): Project | undefined {
    let directory = path;
    for (;;) {
      const boundary = directory.lastIndexOf("/");
      if (boundary < 0) return directory === "workbench" ? this.paths.get(".") : undefined;
      const name = directory.slice(boundary + 1);
      directory = directory.slice(0, boundary);
      if (name === "workbench") return this.paths.get(directory || ".");
      if (!directory) return undefined;
    }
  }
  parent(project: Project): Project | undefined {
    return this.parents.get(project.id);
  }
  children(project: Project): readonly Project[] {
    return this.descendants.get(project.id) ?? [];
  }
  lineage(project: Project): readonly Project[] {
    const saved = this.lineages.get(project.id);
    if (saved) return saved;
    const parent = this.parent(project);
    const lineage = [...(parent ? this.lineage(parent) : []), project];
    this.lineages.set(project.id, lineage);
    return lineage;
  }
  breadcrumb(project: Project): string {
    const saved = this.labels.get(project.id);
    if (saved !== undefined) return saved;
    const label = this.lineage(project).map(projectName).join("/");
    this.labels.set(project.id, label);
    return label;
  }
  ordered(
    compare: (a: Project, b: Project) => number = (a, b) =>
      projectName(a).localeCompare(projectName(b), undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id),
  ): Project[] {
    const result: Project[] = [];
    const visit = (nodes: readonly Project[]) => {
      for (const project of [...nodes].sort(compare)) {
        result.push(project);
        visit(this.children(project));
      }
    };
    visit(this.roots);
    return result;
  }
}
