import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readConfig, readLanguageRoots } from "./core.js";
import type { ToolProfile } from "./profile-schema.js";
import { terminalTable } from "./terminal-table.js";

export function toolProfiles(root: string): ToolProfile[] {
  const profiles = existsSync(join(root, "workbench/config.toml")) ? (readConfig(root).toolchains?.profiles ?? []) : [];
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
    (process.env.WORKBENCH_TOOLCHAIN_ROOT === realpathSync(root) ? process.env.WORKBENCH_TOOLCHAIN : undefined);
  if (!name) return undefined;
  const profile = toolProfiles(root).find((profile) => profile.name === name);
  if (!profile) throw new Error(`unknown tool profile '${name}'`);
  return profile;
}

export function selectedToolProfile(directory: string, explicit?: string | false): ToolProfile | undefined {
  directory = realpathSync(directory);
  let root = directory;
  while (!existsSync(join(root, "workbench/projects.toml"))) {
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

export function listToolProfiles(root: string, json = false): void {
  const profiles = toolProfiles(root);
  if (json) console.log(JSON.stringify(profiles, null, 2));
  else
    console.log(
      terminalTable(
        ["PROFILE", "ROOTS", "COMPILER", "TOOLS", "PLATFORMS"],
        profiles.map((profile) => [
          profile.name,
          profile.paths.join(", "),
          profile.compiler ?? "pins",
          Object.entries(profile.tools ?? {})
            .map(([name, version]) => `${name} ${version}`)
            .join(", ") || "pins",
          profile.platforms?.join(", ") ?? "configured platforms",
        ]),
      ),
    );
}

/** Bind recursive commands to this checkout without leaking selections into test fixtures or other projects. */
export function toolProfileEnvironment(directory: string, explicit?: string | false): Record<string, string> {
  const profile = selectedToolProfile(directory, explicit);
  if (!profile) return {};
  let root = realpathSync(directory);
  while (!existsSync(join(root, "workbench/projects.toml"))) root = dirname(root);
  return { WORKBENCH_TOOLCHAIN: profile.name, WORKBENCH_TOOLCHAIN_ROOT: root };
}
