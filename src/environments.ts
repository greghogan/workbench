import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readToml, readText, writeAtomic } from "./core.js";
import { validateUserOption } from "./user-config.js";

export type CheckEnvironment = "native" | "guix" | "nix" | "nix-docker" | "devcontainer";
export type DevelopmentEnvironment = Exclude<CheckEnvironment, "nix-docker">;

export function checkEnvironment(value: unknown, context: string): CheckEnvironment {
  if (value !== "native" && value !== "guix" && value !== "nix" && value !== "nix-docker" && value !== "devcontainer")
    throw new Error(`${context} must be 'native', 'guix', 'nix', 'nix-docker', or 'devcontainer'`);
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
  storage?: { external?: boolean; root?: string };
} {
  // Git's staged-tree gate reads the preference from its owning working checkout.
  const owner = process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root;
  const path = join(owner, "workbench/local.toml");
  if (!existsSync(path)) return {};
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error(`${path}: expected a regular local configuration file`);
  const config = readToml(path) as Record<string, unknown>;
  const fields: Record<string, string[]> = { checks: ["environment"], storage: ["external", "root"] };
  for (const [key, value] of Object.entries(config)) {
    if (
      !Object.hasOwn(fields, key) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((field) => !fields[key]?.includes(field))
    )
      throw new Error(`${path}: only [checks].environment and storage preferences are allowed in local configuration`);
  }
  const environment = (config.checks as { environment?: unknown } | undefined)?.environment;
  const storage = config.storage as { external?: boolean; root?: string } | undefined;
  for (const [key, value] of Object.entries(storage ?? {})) validateUserOption(`storage.${key}`, value);
  return {
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

export function executionPreference(root: string, explicit?: string): CheckEnvironment | undefined {
  if (explicit !== undefined) return checkEnvironment(explicit, "--environment");
  return activeEnvironment()?.environment ?? localEnvironment(root);
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
  if (original.split(/\r?\n/).includes("/local.toml")) return;
  writeAtomic(path, `${original}${original && !original.endsWith("\n") ? "\n" : ""}/local.toml\n`);
}
