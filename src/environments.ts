import { InvalidInput } from "./input-errors.js";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readConfig, readToml, readText, writeAtomic } from "./core.js";
import { validateUserOption } from "./user-config.js";
import type { DevelopmentProfile } from "./profile-schema.js";

export type CheckEnvironment = "native" | "guix" | "nix" | "nix-docker" | "devcontainer";
export type DevelopmentEnvironment = Exclude<CheckEnvironment, "nix-docker">;

export function checkEnvironment(value: unknown, context: string): CheckEnvironment {
  if (value !== "native" && value !== "guix" && value !== "nix" && value !== "nix-docker" && value !== "devcontainer")
    throw new InvalidInput(`${context} must be 'native', 'guix', 'nix', 'nix-docker', or 'devcontainer'`);
  return value;
}

export function developmentEnvironment(value: unknown, context: string): DevelopmentEnvironment {
  const selected = checkEnvironment(value, context);
  if (selected === "nix-docker")
    throw new Error(`${context}: local development uses native, guix, nix, or devcontainer`);
  return selected;
}

/** Local machine choices never redefine shared commands, policy, or CI coverage. */
export function localConfiguration(root: string): {
  environment?: DevelopmentEnvironment;
  profile?: string;
  storage?: { external?: boolean; root?: string };
  collections?: { directories?: string[] };
} {
  // Git's staged-tree gate reads the preference from its owning working checkout.
  const owner = process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root;
  const path = join(owner, "workbench/local.toml");
  if (!existsSync(path)) return {};
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error(`${path}: expected a regular local configuration file`);
  const config = readToml(path) as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    checks: ["environment"],
    development: ["profile"],
    storage: ["external", "root"],
    collections: ["directories"],
  };
  for (const [key, value] of Object.entries(config)) {
    if (
      !Object.hasOwn(fields, key) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((field) => !fields[key]?.includes(field))
    )
      throw new Error(
        `${path}: only checks.environment, development.profile, storage preferences, and collections.directories are allowed in local configuration`,
      );
  }
  const environment = (config.checks as { environment?: unknown } | undefined)?.environment;
  const storage = config.storage as { external?: boolean; root?: string } | undefined;
  const profile = (config.development as { profile?: unknown } | undefined)?.profile;
  const collections = config.collections as { directories?: string[] } | undefined;
  if (collections?.directories !== undefined) validateUserOption("collections.directories", collections.directories);
  if (profile !== undefined && (typeof profile !== "string" || !/^[a-z][a-z0-9_-]*$/.test(profile)))
    throw new Error(`${path}: development.profile must name a declared profile`);
  if (profile !== undefined && environment !== undefined)
    throw new Error(`${path}: select development.profile or checks.environment`);
  for (const [key, value] of Object.entries(storage ?? {})) validateUserOption(`storage.${key}`, value);
  return {
    ...(collections === undefined ? {} : { collections }),
    ...(profile === undefined ? {} : { profile }),
    ...(storage === undefined ? {} : { storage }),
    ...(environment === undefined
      ? {}
      : { environment: developmentEnvironment(environment, `${path}: checks.environment`) }),
  };
}

export function localEnvironment(root: string): DevelopmentEnvironment | undefined {
  return localConfiguration(root).environment;
}

export function activeEnvironment(): { environment: DevelopmentEnvironment; directory: string } | undefined {
  const selected = process.env.WORKBENCH_SHELL_ENVIRONMENT;
  const directory = process.env.WORKBENCH_SHELL_ROOT;
  if (selected === undefined && directory === undefined) return undefined;
  if (!directory || !isAbsolute(directory))
    throw new Error("WORKBENCH_SHELL_ROOT must identify the active shell's root");
  return { environment: developmentEnvironment(selected, "WORKBENCH_SHELL_ENVIRONMENT"), directory };
}

export function selectedDevelopmentProfile(root: string, explicit?: string): DevelopmentProfile | undefined {
  const config = readConfig(root);
  const local = localConfiguration(root);
  const context = process.env.WORKBENCH_PROFILE_CONTEXT;
  const name =
    explicit ??
    (context !== undefined
      ? context || undefined
      : (process.env.WORKBENCH_DEVELOPMENT_PROFILE ??
        local.profile ??
        (local.environment ? undefined : config.development?.default)));
  if (!name) return undefined;
  const profile = config.development?.profiles?.find((entry) => entry.name === name);
  if (!profile) throw new Error(`unknown development profile '${name}'`);
  return profile;
}

export function profileEnvironment(profile: DevelopmentProfile): DevelopmentEnvironment {
  return profile.workspace === "devcontainer" ? "devcontainer" : profile.builder;
}

export function executionPreference(
  root: string,
  explicit?: string,
  profileName?: string,
): CheckEnvironment | undefined {
  if (explicit !== undefined && profileName !== undefined) throw new Error("select --profile or --environment");
  if (profileName !== undefined) {
    const profile = selectedDevelopmentProfile(root, profileName);
    if (!profile) throw new Error("a development profile name is required");
    return profileEnvironment(profile);
  }
  if (explicit !== undefined) return checkEnvironment(explicit, "--environment");
  const active = activeEnvironment();
  if (active) return active.environment;
  const profile = selectedDevelopmentProfile(root);
  return profile ? profileEnvironment(profile) : localEnvironment(root);
}

/** Bind a command's workspace choice without letting machine preferences override explicit environments. */
export function withDevelopmentSelection<T>(
  root: string,
  environment: string | undefined,
  name: string | undefined,
  action: () => T,
): T {
  executionPreference(root, environment, name);
  const previous = process.env.WORKBENCH_PROFILE_CONTEXT;
  const profile = environment === undefined ? selectedDevelopmentProfile(root, name) : undefined;
  process.env.WORKBENCH_PROFILE_CONTEXT = profile?.name ?? "";
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_PROFILE_CONTEXT;
    else process.env.WORKBENCH_PROFILE_CONTEXT = previous;
  }
}

/** Guix/Nix shells supply one root's tools; containers select native pins within their workspace. */
export function inSelectedShell(directory: string, selected: CheckEnvironment): boolean {
  const active = activeEnvironment();
  if (!active || active.environment === "native") return false;
  if (active.environment === "devcontainer" && selected === "devcontainer") {
    const workspace = process.env.WORKBENCH_PROJECT_ROOT;
    if (!workspace) throw new Error("active Dev Container shell must identify its workspace");
    const within = relative(realpathSync(workspace), realpathSync(resolve(directory)));
    if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
      throw new Error("check root is outside the active Dev Container workspace");
    return true;
  }
  if (selected !== active.environment || realpathSync(resolve(directory)) !== realpathSync(active.directory))
    throw new Error(
      `active ${active.environment} shell belongs to ${active.directory}; exit it before selecting another environment or root`,
    );
  return true;
}

/** The ignore rule travels with Workbench configuration, including through managed updates. */
export function ensureLocalIgnore(root: string): void {
  const path = join(root, "workbench/.gitignore");
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw new Error(`${path}: expected a regular ignore file`);
  const original = existsSync(path) ? readText(path) : "";
  const missing = ["/local.toml", "/.collections/", "/.local-collections/"].filter(
    (rule) => !original.split(/\r?\n/).includes(rule),
  );
  if (!missing.length) return;
  writeAtomic(path, `${original}${original && !original.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}
