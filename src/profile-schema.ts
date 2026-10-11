import { InvalidInput } from "./input-errors.js";
import { relativePath } from "./paths.js";

export type Builder = "native" | "nix" | "guix";
export interface DevelopmentProfile {
  name: string;
  builder: Builder;
  workspace: "host" | "devcontainer";
  container_config?: string;
}
export interface ReleaseProfile {
  name: string;
  path: string;
  builder: Builder;
  format: string;
  platform: string;
  prepare: string[];
  verify: string[];
}

const formats: Record<Builder, readonly string[]> = {
  native: ["directory", "tarball", "docker", "apptainer"],
  nix: ["closure", "portable", "docker", "apptainer"],
  guix: ["tarball", "relocatable", "portable", "docker", "squashfs", "apptainer"],
};

function profiles(value: unknown, context: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new InvalidInput(`${context}: expected an array of profile tables`);
  const names = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new InvalidInput(`${context}: expected a profile table`);
    const profile = entry as Record<string, unknown>;
    if (typeof profile.name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(profile.name) || names.has(profile.name))
      throw new InvalidInput(`${context}: profiles need unique lowercase names`);
    names.add(profile.name);
    if (profile.builder !== "native" && profile.builder !== "nix" && profile.builder !== "guix")
      throw new InvalidInput(`${context}: ${profile.name}: builder must be native, nix, or guix`);
    return profile;
  });
}

function fields(profile: Record<string, unknown>, allowed: string[], context: string): void {
  for (const key of Object.keys(profile))
    if (!allowed.includes(key)) throw new InvalidInput(`${context}: unknown profile field '${key}'`);
}

export function validateDevelopmentProfiles(value: unknown, context: string): void {
  for (const profile of profiles(value, context)) {
    fields(profile, ["name", "builder", "workspace", "container_config"], context);
    if (profile.workspace !== "host" && profile.workspace !== "devcontainer")
      throw new InvalidInput(`${context}: ${String(profile.name)}: workspace must be host or devcontainer`);
    if (profile.workspace === "devcontainer") {
      if (typeof profile.container_config !== "string")
        throw new InvalidInput(`${context}: container_config is required for a Dev Container workspace`);
      relativePath(profile.container_config, context);
      if (!profile.container_config.endsWith(".json"))
        throw new InvalidInput(`${context}: container_config must be JSON`);
    } else if (profile.container_config !== undefined)
      throw new InvalidInput(`${context}: container_config requires workspace = 'devcontainer'`);
  }
}

export function validateReleaseProfiles(value: unknown, context: string): void {
  for (const profile of profiles(value, context)) {
    fields(profile, ["name", "path", "builder", "format", "platform", "prepare", "verify"], context);
    if (typeof profile.path !== "string") throw new InvalidInput(`${context}: path is required`);
    relativePath(profile.path, context, true);
    const builder = profile.builder as Builder;
    if (typeof profile.format !== "string" || !formats[builder].includes(profile.format))
      throw new InvalidInput(`${context}: unsupported ${builder} format '${String(profile.format)}'`);
    if (!["linux-x64", "linux-arm64", "macos-arm64", "windows-x64"].includes(String(profile.platform)))
      throw new InvalidInput(`${context}: platform must name a supported OS and architecture`);
    if (builder !== "native" && !String(profile.platform).startsWith("linux-") && builder === "guix")
      throw new InvalidInput(`${context}: Guix releases require Linux`);
    if (
      ["docker", "squashfs", "apptainer", "relocatable", "portable"].includes(profile.format) &&
      !String(profile.platform).startsWith("linux-")
    )
      throw new InvalidInput(`${context}: ${profile.format} releases require Linux`);
    for (const key of ["prepare", "verify"])
      if (
        !Array.isArray(profile[key]) ||
        !(profile[key] as unknown[]).length ||
        (profile[key] as unknown[]).some((part) => typeof part !== "string" || !part || part.includes("\0"))
      )
        throw new InvalidInput(`${context}: ${key} needs a nonempty command array`);
  }
}

export function validateProfileDefaults(config: {
  development?: { default?: string; profiles?: DevelopmentProfile[] };
}): void {
  const development = config.development;
  if (development?.default && !development.profiles?.some((profile) => profile.name === development.default))
    throw new InvalidInput(`development.default: unknown profile '${development.default}'`);
}
