import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { InvalidInput } from "./input-errors.js";
import { ownedPath, registeredRootPath } from "./paths.js";
import { configurationValue, readConfigurationToml as readToml } from "./configuration-snapshot.js";
import { validateConfig, validateRegistry, automationKeys } from "./config-schema.js";
import type { Project, LanguageRoot, Config } from "./project-model.js";
import { projectIdPattern as validName } from "./project-identity.js";
export const workspaceSchemaVersion = 1;

export function readConfig(root: string): Config {
  return configurationValue(`project-config:${root}`, () => loadConfig(root));
}

function loadConfig(root: string): Config {
  const path = ownedPath(root, "workbench/config.toml");
  const automationPath = ownedPath(root, "workbench/automation.toml");
  return configFromData(readToml(path), existsSync(automationPath) ? readToml(automationPath) : undefined, path);
}

/** Parse declarations identically for live checkouts and read-only Git snapshots. */
export function configFromData(value: unknown, automation: unknown, path: string): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidInput(`${path}: expected a table`);
  const config = { ...value } as Config;
  const automationPath = path.replace(/config\.toml$/, "automation.toml");
  if (automation !== undefined) {
    if (!automation || typeof automation !== "object" || Array.isArray(automation))
      throw new InvalidInput(`${automationPath}: expected a table`);
    for (const [key, value] of Object.entries(automation)) {
      if (!automationKeys.has(key)) throw new InvalidInput(`${automationPath}: '${key}' belongs in config.toml`);
      if (key in config) throw new InvalidInput(`${automationPath}: '${key}' is already defined in config.toml`);
      config[key] = value;
    }
  }
  validateConfig(config, path);
  if (config.schema_version !== workspaceSchemaVersion)
    throw new InvalidInput(
      `${path}: workspace schema ${String(config.schema_version)} is unsupported; expected ${String(workspaceSchemaVersion)}. Use a matching Workbench revision.`,
    );
  if (!Number.isSafeInteger(config.markdown?.wrap_width) || (config.markdown?.wrap_width ?? 0) <= 0) {
    throw new InvalidInput(`${path}: 'markdown.wrap_width' must be positive`);
  }
  if (typeof config.compatibility?.required !== "boolean") {
    throw new InvalidInput(`${path}: 'compatibility.required' must be Boolean`);
  }
  config.compatibility = { ...config.compatibility, data: config.compatibility.data ?? "ask" };
  return config;
}

export function readProjects(root: string): Project[] {
  return configurationValue(`projects:${root}`, () => loadProjects(root));
}

function loadProjects(root: string): Project[] {
  const path = ownedPath(root, "workbench/projects.toml");
  const projects = projectsFromData(readToml(path), path);
  for (const project of projects) {
    ownedPath(root, project.path);
    if (project.path !== ".") {
      let directory = root;
      for (const component of project.path.split("/")) {
        directory = join(directory, component);
        if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
          throw new Error(`${directory}: symlinked project directories are not supported`);
      }
    }
  }
  return projects;
}

/** Validate registry contents independently of a checkout or its filesystem. */
export function projectsFromData(value: unknown, path: string): Project[] {
  validateRegistry(value, path);
  const registry = value as { project?: Project[] };
  if (!Array.isArray(registry.project) || registry.project.length === 0) {
    throw new Error(`${path}: expected at least one [[project]]`);
  }
  const projects = registry.project;
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [index, project] of projects.entries()) {
    if ("languages" in project) throw new Error(`${path}: use [[language_root]] instead of project.languages`);
    if (!validName.test(project.id) || typeof project.path !== "string") throw new Error(`${path}: invalid project`);
    if ((index === 0) !== (project.path === ".")) throw new Error(`${path}: first project must be the sole root`);
    registeredRootPath(project.path, `${path}: project path`);
    if (ids.has(project.id) || paths.has(project.path)) throw new Error(`${path}: duplicate project ID or path`);
    ids.add(project.id);
    paths.add(project.path);
  }
  return projects;
}

export function readLanguageRoots(root: string): LanguageRoot[] {
  return configurationValue(`language-roots:${root}`, () => loadLanguageRoots(root));
}

function loadLanguageRoots(root: string): LanguageRoot[] {
  const path = ownedPath(root, "workbench/projects.toml");
  const roots = languageRootsFromData(readToml(path), path);
  for (const entry of roots) {
    ownedPath(root, entry.path);
    let directory = root;
    for (const component of entry.path === "." ? [] : entry.path.split("/")) {
      directory = join(directory, component);
      if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
        throw new Error(`${path}: language root '${entry.path}' must be a real directory`);
    }
  }
  return roots;
}

export function languageRootsFromData(value: unknown, path: string): LanguageRoot[] {
  validateRegistry(value, path);
  const registry = value as { language_root?: LanguageRoot[] };
  if (registry.language_root !== undefined && !Array.isArray(registry.language_root))
    throw new InvalidInput(`${path}: 'language_root' must be an array of tables`);
  const seen = new Set<string>();
  return (registry.language_root ?? []).map((entry) => {
    if (!validName.test(entry.language) || typeof entry.path !== "string")
      throw new InvalidInput(`${path}: invalid language root`);
    registeredRootPath(entry.path, `${path}: language root`);
    const key = `${entry.language}:${entry.path}`;
    if (seen.has(key)) throw new InvalidInput(`${path}: duplicate language root '${key}'`);
    seen.add(key);
    return entry;
  });
}

export function selectProject(root: string, id?: string): Project {
  const projects = readProjects(root);
  const project = id ? projects.find((entry) => entry.id.toLowerCase() === id.toLowerCase()) : projects[0];
  if (!project) throw new Error(`unknown project: ${String(id)}`);
  return project;
}
