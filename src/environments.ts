import { currentExecutionEnvironment, withExecutionEnvironment } from "./execution-context.js";
import { InvalidInput } from "./input-errors.js";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readConfig } from "./project-configuration.js";
import { readToml, readText } from "./files.js";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { localUserFields, localUserOptionKeys, validateUserOption } from "./user-config.js";
import type { DevelopmentProfile, Workspace } from "./profile-schema.js";

export function developmentWorkspace(value: unknown): Workspace {
  if (value !== "host" && value !== "devcontainer") throw new InvalidInput("workspace must be host or devcontainer");
  return value;
}

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
export function localConfiguration(
  root: string,
  selectedRoot?: string,
): {
  environment?: DevelopmentEnvironment;
  profile?: string;
  workspace?: Workspace;
  storage?: { external?: boolean; root?: string };
  collections?: { directories?: string[] };
  execution?: { cpus_per_job?: number; max_jobs?: number };
  logs?: { max_age_days?: number; max_bytes?: number; compress?: boolean };
} {
  // Git's staged-tree gate reads the preference from its owning working checkout.
  const owner = selectedRoot ?? currentExecutionEnvironment().WORKBENCH_LOCAL_CONFIG_ROOT ?? root;
  const path = join(owner, "workbench/local.toml");
  if (!existsSync(path)) return {};
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error(`${path}: expected a regular local configuration file`);
  const config = readToml(path) as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    checks: ["environment"],
    development: ["profile", "workspace"],
    ...localUserFields,
  };
  for (const [key, value] of Object.entries(config)) {
    if (
      !Object.hasOwn(fields, key) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((field) => !fields[key]?.includes(field))
    )
      throw new Error(`${path}: unknown local configuration section or option`);
  }
  const environment = (config.checks as { environment?: unknown } | undefined)?.environment;
  const profile = (config.development as { profile?: unknown } | undefined)?.profile;
  const workspace = (config.development as { workspace?: unknown } | undefined)?.workspace;
  if (workspace !== undefined) developmentWorkspace(workspace);
  for (const key of localUserOptionKeys) {
    const [section = "", field = ""] = key.split(".");
    const value = (config[section] as Record<string, unknown> | undefined)?.[field];
    if (value !== undefined) validateUserOption(key, value);
  }
  if (profile !== undefined && (typeof profile !== "string" || !/^[a-z][a-z0-9_-]*$/.test(profile)))
    throw new Error(`${path}: development.profile must name a declared profile`);
  if (profile !== undefined && environment !== undefined)
    throw new Error(`${path}: select development.profile or checks.environment`);
  return {
    ...Object.fromEntries(
      Object.keys(localUserFields)
        .filter((section) => config[section] !== undefined)
        .map((section) => [section, config[section]]),
    ),
    ...(profile === undefined ? {} : { profile }),
    ...(workspace === undefined ? {} : { workspace: developmentWorkspace(workspace) }),
    ...(environment === undefined
      ? {}
      : { environment: developmentEnvironment(environment, `${path}: checks.environment`) }),
  };
}

export function localEnvironment(root: string): DevelopmentEnvironment | undefined {
  return localConfiguration(root).environment;
}

export function activeEnvironment(): { environment: DevelopmentEnvironment; directory: string } | undefined {
  const selected = currentExecutionEnvironment().WORKBENCH_SHELL_ENVIRONMENT;
  const directory = currentExecutionEnvironment().WORKBENCH_SHELL_ROOT;
  if (selected === undefined && directory === undefined) return undefined;
  if (!directory || !isAbsolute(directory))
    throw new Error("WORKBENCH_SHELL_ROOT must identify the active shell's root");
  return { environment: developmentEnvironment(selected, "WORKBENCH_SHELL_ENVIRONMENT"), directory };
}

export function selectedDevelopmentProfile(root: string, explicit?: string): DevelopmentProfile | undefined {
  const config = readConfig(root);
  const local = localConfiguration(root);
  const context = currentExecutionEnvironment().WORKBENCH_PROFILE_CONTEXT;
  const name =
    explicit ??
    (context !== undefined
      ? context || undefined
      : (currentExecutionEnvironment().WORKBENCH_DEVELOPMENT_PROFILE ??
        local.profile ??
        (local.environment ? undefined : config.development?.default)));
  if (!name) return undefined;
  const profile = config.development?.profiles?.find((entry) => entry.name === name);
  if (!profile) throw new Error(`unknown development profile '${name}'`);
  const workspace = currentExecutionEnvironment().WORKBENCH_WORKSPACE_CONTEXT ?? local.workspace ?? profile.workspace;
  const selected = { ...profile, workspace: developmentWorkspace(workspace) };
  if (selected.workspace === "devcontainer" && !selected.container_config)
    throw new InvalidInput(`development profile '${name}' has no container_config`);
  return selected;
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
  workspace?: string,
): T {
  const env = { ...currentExecutionEnvironment() };
  if (workspace !== undefined) env.WORKBENCH_WORKSPACE_CONTEXT = developmentWorkspace(workspace);
  return withExecutionEnvironment(env, () => {
    executionPreference(root, environment, name);
    if (workspace !== undefined && environment !== undefined)
      throw new InvalidInput(
        "select --profile with --workspace; --environment selects an execution environment directly",
      );
    const profile = environment === undefined ? selectedDevelopmentProfile(root, name) : undefined;
    if (workspace !== undefined && !profile)
      throw new InvalidInput("--workspace requires a configured development profile");
    env.WORKBENCH_PROFILE_CONTEXT = profile?.name ?? "";
    env.WORKBENCH_WORKSPACE_CONTEXT = profile?.workspace;
    if (profile?.toolchain) {
      env.WORKBENCH_TOOLCHAIN = profile.toolchain;
      env.WORKBENCH_TOOLCHAIN_ROOT = realpathSync(root);
    }
    return action();
  });
}

/** Guix/Nix shells supply one root's tools; containers select native pins within their workspace. */
export function inSelectedShell(directory: string, selected: CheckEnvironment): boolean {
  const active = activeEnvironment();
  if (!active || active.environment === "native") return false;
  if (active.environment === "devcontainer" && selected === "devcontainer") {
    const workspace = currentExecutionEnvironment().WORKBENCH_PROJECT_ROOT;
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
  const missing = [
    "/local.toml",
    "/.collections/",
    "/.local-collections/",
    "/.skill-links.json",
    "/.skill-links.json.lock/",
    "/.skill-catalog.json",
  ].filter((rule) => !original.split(/\r?\n/).includes(rule));
  if (!missing.length) return;
  writeAtomic(path, `${original}${original && !original.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}
