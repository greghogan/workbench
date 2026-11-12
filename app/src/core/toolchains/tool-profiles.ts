import { projectPaths } from "../projects/project-paths.js";
import { currentExecutionEnvironment } from "../execution/environments/execution-context.js";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readConfig, readLanguageRoots } from "../projects/project-configuration.js";
import type { ToolProfile } from "../artifacts/profile-schema.js";

export function toolProfiles(root: string): ToolProfile[] {
  const profiles = existsSync(join(root, projectPaths.config)) ? (readConfig(root).toolchains?.profiles ?? []) : [];
  const paths = new Set(readLanguageRoots(root).map((entry) => entry.path));
  for (const profile of profiles)
    if (profile.paths.some((path) => !paths.has(path)))
      throw new Error(`tool profile '${profile.name}' selects an unknown language root`);
  return profiles;
}

export function toolProfile(root: string, explicit?: string | false): ToolProfile | undefined {
  if (explicit === false) return undefined;
  const name =
    explicit ??
    (currentExecutionEnvironment().WORKBENCH_TOOLCHAIN_ROOT === realpathSync(root)
      ? currentExecutionEnvironment().WORKBENCH_TOOLCHAIN
      : undefined);
  if (!name) return undefined;
  const profile = toolProfiles(root).find((profile) => profile.name === name);
  if (!profile) throw new Error(`unknown tool profile '${name}'`);
  return profile;
}

export function selectedToolProfile(directory: string, explicit?: string | false): ToolProfile | undefined {
  directory = realpathSync(directory);
  let root = directory;
  while (!existsSync(join(root, projectPaths.projects))) {
    const parent = dirname(root);
    if (parent === root) {
      if (explicit) throw new Error("tool profiles require a registered project");
      return undefined;
    }
    root = parent;
  }
  const profile = toolProfile(root, explicit);
  if (!profile) return undefined;
  const name = profile.name;
  const path = relative(root, directory).replaceAll("\\", "/") || ".";
  if (!profile.paths.includes(path)) throw new Error(`tool profile '${name}' does not select '${path}'`);
  const platform = `${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  if (profile.platforms && !profile.platforms.includes(platform))
    throw new Error(`tool profile '${name}' is not configured for ${platform}`);
  return profile;
}

/** Bind recursive commands to this checkout without leaking selections into test fixtures or other projects. */
export function toolProfileEnvironment(directory: string, explicit?: string | false): Record<string, string> {
  const profile = selectedToolProfile(directory, explicit);
  if (!profile) return {};
  let root = realpathSync(directory);
  while (!existsSync(join(root, projectPaths.projects))) root = dirname(root);
  return { WORKBENCH_TOOLCHAIN: profile.name, WORKBENCH_TOOLCHAIN_ROOT: root };
}
