import { readConfig, readLanguageRoots } from "./project-configuration.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nativeInstallationPlan } from "./native-tools.js";
import { toolRequirement, matchesToolRequirement } from "./tool-requirements.js";
import {
  registeredProjects,
  updateProjectRequirements,
  type ProjectRequirement,
  type RegisteredProject,
} from "./project-registry.js";

export interface SuccessfulGateEvidence {
  paths?: string[];
  profile?: string;
  browser?: boolean;
}

export function projectRequirements(root: string): ProjectRequirement[] {
  if (!existsSync(join(root, "workbench/projects.toml"))) throw new Error(`Registered project is unavailable: ${root}`);
  if (!readLanguageRoots(root).length) return [];
  const platform = `${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const profiles = (readConfig(root).toolchains?.profiles ?? []).filter(
    (profile) => !profile.platforms || profile.platforms.includes(platform),
  );
  return [
    ...nativeInstallationPlan(root, undefined, { toolchain: false }).map((entry) => ({ ...entry, profile: "" })),
    ...profiles.flatMap((profile) =>
      profile.paths.flatMap((path) =>
        nativeInstallationPlan(root, path, { toolchain: profile.name }).map((entry) => ({
          ...entry,
          profile: profile.name,
        })),
      ),
    ),
  ].map((entry) => ({
    ...toolRequirement(
      { name: entry.tool, version: entry.version },
      "directory" in entry ? entry.directory : undefined,
    ),
    root: entry.root,
    profile: entry.profile,
  }));
}
export function refreshProjectRequirements(
  root: string,
  successful?: SuccessfulGateEvidence,
  checkedRoot = root,
): void {
  try {
    const requirements = projectRequirements(root);
    const working = successful
      ? (checkedRoot === root ? requirements : projectRequirements(checkedRoot)).filter(
          (entry) =>
            entry.profile === (successful.profile ?? "") &&
            (entry.tool !== "chromium-headless-shell" || successful.browser === true) &&
            (!successful.paths || successful.paths.includes(entry.root)),
        )
      : undefined;
    updateProjectRequirements(root, requirements, "", working);
  } catch (error) {
    updateProjectRequirements(root, [], error instanceof Error ? error.message : String(error));
  }
}
/** Declared pins and last working selections protect replacements until their checks succeed. */
export function projectRequirementSnapshot(projects: RegisteredProject[] = registeredProjects()) {
  return projects.map((project) => {
    try {
      return {
        project,
        requirements: [...projectRequirements(project.path), ...(project.working ?? [])],
        unavailable: false,
      };
    } catch (error) {
      return {
        project,
        requirements: [],
        unavailable: true,
        problem: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
export function projectToolProtection(
  installation: {
    provider: string;
    directory: string;
    tool: string;
    version: string;
  },
  snapshot = projectRequirementSnapshot(),
): string[] {
  return projectToolRelations(installation, snapshot).map((relation) => relation.reason);
}
export function projectToolRelations(
  installation: { provider: string; directory: string; tool: string; version: string },
  snapshot = projectRequirementSnapshot(),
): { kind: "project" | "unavailable-project"; project: string; reason: string }[] {
  const reasons: { kind: "project" | "unavailable-project"; project: string; reason: string }[] = [];
  for (const { project, requirements, unavailable } of snapshot) {
    if (unavailable) {
      reasons.push({
        kind: "unavailable-project",
        project: project.path,
        reason: `requirements unavailable: ${project.path}`,
      });
      continue;
    }
    if (
      requirements.some(
        (requirement) =>
          matchesToolRequirement(requirement, installation) ||
          (!requirement.directory &&
            requirement.tool === installation.tool &&
            requirement.version === installation.version),
      )
    )
      reasons.push({ kind: "project", project: project.path, reason: `registered project: ${project.path}` });
  }
  return reasons;
}
