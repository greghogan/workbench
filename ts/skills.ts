import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import { readLanguageRoots, readProjects, type LanguageRoot, type Project } from "./core.js";

type Check = { environment?: string };
type Config = { checks?: { environment?: string }; check?: Check[] };
type Link = { destination: string; source: string };

const environments = ["guix", "nix"] as const;
const safeName = /^[a-z][a-z0-9-]*$/;

function readToml<T>(path: string): T {
  return parse(readFileSync(path, "utf8")) as T;
}

function configured(root: string): {
  projects: Project[];
  languageRoots: LanguageRoot[];
  activeEnvironments: Set<string>;
} {
  const projects = readProjects(root);
  const languageRoots = readLanguageRoots(root);
  const config = readToml<Config>(join(root, "workbench/config.toml"));
  const activeEnvironments = new Set<string>();
  const configuredEnvironment = config.checks?.environment ?? "none";
  const values = [
    configuredEnvironment,
    ...(config.check ?? []).map((check) => check.environment ?? configuredEnvironment),
  ];
  for (const value of values) {
    if (value !== "none" && value !== "nix-docker" && !environments.includes(value as (typeof environments)[number])) {
      throw new Error(`workbench/config.toml: unknown check environment '${value}'`);
    }
  }
  for (const check of config.check ?? []) {
    const selected = check.environment ?? configuredEnvironment;
    if (selected !== "none") activeEnvironments.add(selected === "nix-docker" ? "nix" : selected);
  }
  return { projects, languageRoots, activeEnvironments };
}

function skillDirectories(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && safeName.test(entry.name) && existsSync(join(directory, entry.name, "SKILL.md")),
    )
    .map((entry) => join(directory, entry.name));
}

function desiredLinks(
  root: string,
  distribution: string,
): { links: Link[]; names: Set<string>; projectRoots: string[] } {
  const { projects, languageRoots, activeEnvironments } = configured(root);
  const links: Link[] = [];
  const names = new Set<string>();
  const projectRoots: string[] = [];
  const rootCodex = join(root, ".agents/skills");
  const rootClaude = join(root, ".claude/skills");
  const languageDirectory = join(distribution, "skills/languages");
  if (existsSync(languageDirectory)) {
    for (const entry of readdirSync(languageDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && safeName.test(entry.name)) {
        for (const source of skillDirectories(join(languageDirectory, entry.name))) names.add(basename(source));
      }
    }
  }
  for (const environment of environments) {
    const source = join(distribution, "skills", `${environment}-update`);
    if (!existsSync(join(source, "SKILL.md"))) continue;
    const name = basename(source);
    names.add(name);
    if (activeEnvironments.has(environment)) {
      links.push({ destination: join(rootCodex, name), source });
      links.push({ destination: join(rootClaude, name), source });
    }
  }
  for (const project of projects) {
    if (!safeName.test(project.id)) {
      throw new Error(`workbench/projects.toml: invalid project '${project.id}'`);
    }
    if (project.path !== "." && (isAbsolute(project.path) || project.path.split("/").some((part) => part === ".."))) {
      throw new Error(`workbench/projects.toml: unsafe project path '${project.path}'`);
    }
    const projectRoot = resolve(root, project.path);
    projectRoots.push(projectRoot);
  }
  for (const entry of languageRoots) {
    const language = entry.language;
    if (!safeName.test(language)) throw new Error(`workbench/projects.toml: invalid language '${language}'`);
    if (entry.path !== "." && (isAbsolute(entry.path) || entry.path.split("/").some((part) => part === "..")))
      throw new Error(`workbench/projects.toml: unsafe language root '${entry.path}'`);
    const languageRoot = resolve(root, entry.path);
    projectRoots.push(languageRoot);
    for (const source of skillDirectories(join(distribution, "skills/languages", language))) {
      const name = basename(source);
      names.add(name);
      links.push({ destination: join(rootCodex, name), source });
      links.push({ destination: join(languageRoot, ".claude/skills", name), source });
    }
  }
  const byDestination = new Map<string, string>();
  for (const link of links) {
    const previous = byDestination.get(link.destination);
    if (previous && previous !== link.source) throw new Error(`ambiguous skill '${basename(link.destination)}'`);
    byDestination.set(link.destination, link.source);
  }
  return { links: [...byDestination].map(([destination, source]) => ({ destination, source })), names, projectRoots };
}

function existingPath(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function ownedSymlink(path: string, distribution: string): boolean {
  if (!existingPath(path) || !lstatSync(path).isSymbolicLink()) return false;
  const target = resolve(dirname(path), readlinkSync(path));
  const skillRoot = join(distribution, "skills");
  return target.startsWith(skillRoot + sep);
}

/** Expose only configured skills; never replace a user-owned skill. */
export function syncSkills(rootInput: string, distributionInput: string, checkOnly = false): string[] {
  const root = resolve(rootInput);
  const distribution = resolve(distributionInput);
  const { links, names, projectRoots } = desiredLinks(root, distribution);
  const desired = new Map(links.map(({ destination, source }) => [destination, source]));
  const folders = [
    join(root, ".agents/skills"),
    ...projectRoots.map((projectRoot) => join(projectRoot, ".claude/skills")),
  ];
  const changed: string[] = [];
  for (const folder of new Set(folders)) {
    for (const name of names) {
      const path = join(folder, name);
      const target = desired.get(path);
      if (!existingPath(path)) {
        if (target) {
          if (checkOnly) throw new Error(`${path}: missing configured skill; run workbench sync`);
          mkdirSync(folder, { recursive: true });
          symlinkSync(relative(folder, target), path, "dir");
          changed.push(path);
        }
        continue;
      }
      if (!ownedSymlink(path, distribution)) {
        if (target) throw new Error(`${path}: existing user-owned skill blocks Workbench activation`);
        continue;
      }
      const actual = resolve(folder, readlinkSync(path));
      if (target && actual === target) continue;
      if (checkOnly) throw new Error(`${path}: stale skill link; run workbench sync`);
      unlinkSync(path);
      changed.push(path);
      if (target) symlinkSync(relative(folder, target), path, "dir");
    }
  }
  return changed;
}
