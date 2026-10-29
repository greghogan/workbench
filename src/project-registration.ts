import { preserveRelocatedTaskImplementations } from "./task-implementations.js";
import { projectName } from "./project-hierarchy.js";
import { basename, join, resolve } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { readBoundedFile } from "./file-reads.js";
import { readProjects } from "./project-configuration.js";
import {
  canonicalProject,
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

/** Read only checkout-local Git pointers; unavailable metadata leaves the project independently visible. */
function checkoutRepository(root: string): { identity: string; linked: boolean } | undefined {
  try {
    let directory = join(root, ".git");
    if (!lstatSync(directory).isDirectory()) {
      const pointer = /^gitdir: ([^\0\r\n]+)\r?\n?$/.exec(readBoundedFile(directory, 8192, "Git pointer").toString());
      if (!pointer?.[1]) return;
      directory = resolve(root, pointer[1]);
    }
    directory = realpathSync.native(directory);
    let common = directory;
    const path = join(directory, "commondir");
    if (existsSync(path)) {
      const pointer = readBoundedFile(path, 8192, "Git common directory")
        .toString()
        .replace(/\r?\n$/, "");
      if (!pointer || /[\0\r\n]/.test(pointer)) return;
      common = realpathSync.native(resolve(directory, pointer));
    }
    const normalize = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
    return { identity: normalize(common), linked: normalize(directory) !== normalize(common) };
  } catch {
    return undefined;
  }
}

/** Group navigation only: registration, task queues, and cache ownership remain checkout-specific. */
export function registeredProjectGroups<Project extends { path: string; name: string }>(projects: readonly Project[]) {
  const groups = new Map<string, { project: Project; worktrees: Project[] }>();
  for (const project of projects) {
    const repository = checkoutRepository(project.path),
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
