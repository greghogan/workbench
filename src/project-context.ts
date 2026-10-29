import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { InvalidInput } from "./input-errors.js";
import type { Project } from "./project-model.js";
export function projectRoot(): string {
  if (process.env.WORKBENCH_PROJECT_ROOT) {
    const root = resolve(process.env.WORKBENCH_PROJECT_ROOT);
    return existsSync(root) ? realpathSync(root) : root;
  }
  let current = process.cwd();
  for (;;) {
    if (existsSync(join(current, "workbench/projects.toml"))) return current;
    if (existsSync(join(current, ".git"))) return process.cwd();
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

export function distributionRoot(root: string): string {
  for (const candidate of [process.env.WORKBENCH_DISTRIBUTION_ROOT, root]) {
    if (candidate && existsSync(join(candidate, "languages/index.toml"))) return realpathSync(candidate);
  }
  throw new InvalidInput("could not locate Workbench distribution");
}

export function rootOf(root: string, project: Project): string {
  return project.path === "." ? root : join(root, project.path);
}
