import { projectName } from "./project-hierarchy.js";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { readProjects } from "./project-configuration.js";
import { canonicalProject, registerProject, type RegisteredProject } from "./project-registry.js";
import { approveProjectRegistration } from "./project-admission.js";
import { refreshProjectRequirements } from "./project-requirements.js";

export function registrationRoot(root: string): string {
  return canonicalProject(
    process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1" && process.env.WORKBENCH_LOCAL_CONFIG_ROOT
      ? process.env.WORKBENCH_LOCAL_CONFIG_ROOT
      : root,
  );
}
export function registerConsumingProject(root: string): void {
  root = canonicalProject(root);
  const project = readProjects(root)[0];
  const name = project ? projectName(project) : basename(root);
  registerProject(root, name);
  refreshProjectRequirements(root);
}
export async function requireProjectRegistration(root: string): Promise<void> {
  root = registrationRoot(root);
  if (!existsSync(join(root, "workbench/projects.toml"))) return;
  await approveProjectRegistration(root);
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
