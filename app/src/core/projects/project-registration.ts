import { existsSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readBoundedFile } from "../runtime/file-reads.js";
import { preserveRelocatedTaskImplementations } from "../tasks/task-implementations.js";
import { preserveRelocatedTaskDecisions } from "../tasks/task-decisions.js";
import { readProjects } from "./project-configuration.js";
import { projectName } from "./project-hierarchy.js";
import {
  canonicalProject,
  projectPathComparison,
  registerProject,
  relocateProject,
  withProjectRegistryWrite,
  type RegisteredProject,
} from "./project-registry.js";
import { refreshProjectRequirements } from "./project-requirements.js";

export function registrationRoot(root: string): string {
  return canonicalProject(
    process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1" && process.env.WORKBENCH_LOCAL_CONFIG_ROOT
      ? process.env.WORKBENCH_LOCAL_CONFIG_ROOT
      : root,
  );
}
export async function registerConsumingProject(root: string, signal?: AbortSignal): Promise<void> {
  await withProjectRegistryWrite(() => {
    root = canonicalProject(root);
    const project = readProjects(root)[0];
    registerProject(root, project ? projectName(project) : basename(root));
    refreshProjectRequirements(root);
  }, signal);
}
export async function relocateConsumingProject(previous: string, root: string, signal?: AbortSignal): Promise<void> {
  await withProjectRegistryWrite(() => {
    root = canonicalProject(root);
    const project = readProjects(root)[0];
    relocateProject(previous, root, project ? projectName(project) : basename(root));
    preserveRelocatedTaskImplementations(previous, root);
    preserveRelocatedTaskDecisions(previous, root);
    refreshProjectRequirements(root);
  }, signal);
}

/** Presentation follows the checkout when available; missing checkouts retain their last registered label. */
export function registeredProjectName(project: Pick<RegisteredProject, "path" | "name">): string {
  try {
    const root = readProjects(project.path)[0];
    return root ? projectName(root) : project.name;
  } catch {
    return project.name;
  }
}

/** Checkout-local Git pointers establish repository membership without running Git. */
function checkoutRepository(
  root: string,
  observe: (path: string) => void,
): { identity: string; common: string; linked: boolean } | undefined {
  try {
    let directory = join(root, ".git");
    observe(directory);
    if (!lstatSync(directory).isDirectory()) {
      const pointer = /^gitdir: ([^\0\r\n]+)\r?\n?$/.exec(readBoundedFile(directory, 8192, "Git pointer").toString());
      if (!pointer?.[1]) return;
      directory = resolve(root, pointer[1]);
    }
    directory = realpathSync.native(directory);
    observe(directory);
    let common = directory;
    const path = join(directory, "commondir");
    observe(path);
    if (existsSync(path)) {
      const pointer = readBoundedFile(path, 8192, "Git common directory")
        .toString()
        .replace(/\r?\n$/, "");
      if (!pointer || /[\0\r\n]/.test(pointer)) return;
      common = realpathSync.native(resolve(directory, pointer));
    }
    const normalize = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
    return { identity: normalize(common), common, linked: normalize(directory) !== normalize(common) };
  } catch {
    return undefined;
  }
}

/** Group navigation only: registration, task queues, and cache ownership remain checkout-specific. */
export function registeredProjectGroups<Project extends { path: string; name: string }>(
  projects: readonly Project[],
  observe: (path: string) => void = () => undefined,
) {
  const repositories = new Map(projects.map((project) => [project, checkoutRepository(project.path, observe)]));
  const missing = new Map<string, NonNullable<ReturnType<typeof checkoutRepository>>>();
  for (const common of new Set([...repositories.values()].flatMap((repo) => (repo ? [repo.common] : [])))) {
    const metadata = join(common, "worktrees");
    observe(metadata);
    try {
      for (const entry of readdirSync(metadata, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pointer = join(metadata, entry.name, "gitdir");
        observe(pointer);
        try {
          const path = readBoundedFile(pointer, 8192, "Git worktree pointer")
            .toString()
            .replace(/\r?\n$/, "");
          if (!path || /[\0\r\n]/.test(path)) continue;
          const checkout = dirname(resolve(metadata, entry.name, path));
          if (!existsSync(checkout))
            missing.set(projectPathComparison(checkout), {
              identity: projectPathComparison(common),
              common,
              linked: true,
            });
        } catch {
          /* Inaccessible metadata cannot establish membership. */
        }
      }
    } catch {
      /* A repository need not have linked worktrees. */
    }
  }
  const groups = new Map<string, { project: Project; worktrees: Project[] }>();
  for (const project of projects) {
    const repository = repositories.get(project) ?? missing.get(projectPathComparison(project.path)),
      identity = repository ? "git:" + repository.identity : "path:" + project.path,
      group = groups.get(identity);
    if (!group) groups.set(identity, { project, worktrees: [] });
    else if (repository && !repository.linked) {
      group.worktrees.push(group.project);
      group.project = project;
    } else group.worktrees.push(project);
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.project.name.localeCompare(b.project.name, undefined, { sensitivity: "accent" }) ||
      a.project.path.localeCompare(b.project.path),
  );
}
