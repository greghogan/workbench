import { InvalidInput } from "./input-errors.js";
import { relativePath } from "./paths.js";

export type Builder = "native" | "nix" | "guix";
export interface ToolProfile {
  name: string;
  paths: string[];
  tools?: Partial<Record<"node" | "python" | "go" | "rust" | "java" | "ruby" | "php" | "clang" | "gcc", string>>;
  compiler?: "clang" | "gcc";
  platforms?: string[];
}
export interface DevelopmentProfile {
  name: string;
  builder: Builder;
  workspace: "host" | "devcontainer";
  container_config?: string;
  toolchain?: string;
  offline?: { paths?: string[]; inputs: string[]; verify: string[]; registry?: string };
}

export function validateToolProfiles(value: unknown, context: string): void {
  if (!Array.isArray(value)) throw new InvalidInput(`${context}: expected an array of tool profiles`);
  const names = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new InvalidInput(`${context}: expected a profile table`);
    const profile = raw as Record<string, unknown>;
    fields(profile, ["name", "paths", "tools", "compiler", "platforms"], context);
    if (typeof profile.name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(profile.name) || names.has(profile.name))
      throw new InvalidInput(`${context}: tool profiles need unique lowercase names`);
    names.add(profile.name);
    if (!Array.isArray(profile.paths) || !profile.paths.length || new Set(profile.paths).size !== profile.paths.length)
      throw new InvalidInput(`${context}: paths must select distinct registered roots`);
    for (const path of profile.paths) {
      if (typeof path !== "string") throw new InvalidInput(`${context}: paths must contain strings`);
      relativePath(path, context, true);
    }
    if (profile.compiler !== undefined && profile.compiler !== "clang" && profile.compiler !== "gcc")
      throw new InvalidInput(`${context}: compiler must be clang or gcc`);
    if (profile.tools !== undefined) {
      if (!profile.tools || typeof profile.tools !== "object" || Array.isArray(profile.tools))
        throw new InvalidInput(`${context}: tools must be a table of exact versions`);
      for (const [tool, version] of Object.entries(profile.tools)) {
        if (
          !["node", "python", "go", "rust", "java", "ruby", "php", "clang", "gcc"].includes(tool) ||
          typeof version !== "string" ||
          !(tool === "java" ? /^\d+(?:\.\d+)*\+\d+$/ : /^\d+\.\d+\.\d+$/).test(version)
        )
          throw new InvalidInput(`${context}: invalid exact tool version for '${tool}'`);
        if (["clang", "gcc"].includes(tool) && profile.compiler !== tool)
          throw new InvalidInput(`${context}: ${tool} version requires compiler = '${tool}'`);
      }
    }
    if (!profile.compiler && !Object.keys(profile.tools ?? {}).length)
      throw new InvalidInput(`${context}: select tools or a compiler`);
    if (
      profile.platforms !== undefined &&
      (!Array.isArray(profile.platforms) ||
        !profile.platforms.length ||
        profile.platforms.some(
          (platform) => !["linux-x64", "linux-arm64", "macos-arm64", "windows-x64"].includes(String(platform)),
        ))
    )
      throw new InvalidInput(`${context}: platforms must select supported native platforms`);
  }
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
    fields(profile, ["name", "builder", "workspace", "container_config", "offline", "toolchain"], context);
    if (profile.toolchain !== undefined && (profile.builder !== "native" || typeof profile.toolchain !== "string"))
      throw new InvalidInput(`${context}: toolchain selects a named profile under the native builder`);
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
    if (profile.offline !== undefined) {
      if (profile.workspace !== "devcontainer")
        throw new InvalidInput(`${context}: offline requires a Dev Container workspace`);
      if (!profile.offline || typeof profile.offline !== "object" || Array.isArray(profile.offline))
        throw new InvalidInput(`${context}: offline must be a table`);
      const offline = profile.offline as Record<string, unknown>;
      fields(offline, ["paths", "inputs", "verify", "registry"], context);
      if (offline.paths !== undefined) {
        if (
          !Array.isArray(offline.paths) ||
          !offline.paths.length ||
          new Set(offline.paths).size !== offline.paths.length
        )
          throw new InvalidInput(`${context}: offline.paths must select distinct roots`);
        for (const path of offline.paths) {
          if (typeof path !== "string") throw new InvalidInput(`${context}: offline.paths must contain strings`);
          relativePath(path, context, true);
        }
      }
      if (
        offline.registry !== undefined &&
        (typeof offline.registry !== "string" ||
          !/^ghcr\.io\/[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)+$/.test(offline.registry))
      )
        throw new InvalidInput(`${context}: offline.registry must name a GHCR repository without a tag`);
      for (const key of ["inputs", "verify"])
        if (
          !Array.isArray(offline[key]) ||
          !(offline[key] as unknown[]).length ||
          (offline[key] as unknown[]).some((part) => typeof part !== "string" || !part.trim() || part.includes("\0"))
        )
          throw new InvalidInput(`${context}: offline.${key} needs a nonempty string array`);
      for (const path of offline.inputs as string[]) relativePath(path, context);
    }
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
  toolchains?: { profiles?: ToolProfile[] };
}): void {
  const development = config.development;
  if (development?.default && !development.profiles?.some((profile) => profile.name === development.default))
    throw new InvalidInput(`development.default: unknown profile '${development.default}'`);
  for (const profile of development?.profiles ?? [])
    if (profile.toolchain && !config.toolchains?.profiles?.some((tools) => tools.name === profile.toolchain))
      throw new InvalidInput(`development profile '${profile.name}': unknown tool profile '${profile.toolchain}'`);
}
