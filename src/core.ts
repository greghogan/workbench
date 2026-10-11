import { InvalidInput } from "./input-errors.js";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import { validateConfig, validateRegistry, automationKeys } from "./config-schema.js";
import { ownedPath } from "./paths.js";
import type { DevelopmentProfile, ReleaseProfile } from "./profile-schema.js";
import type { CollectionPin } from "./collection-schema.js";
import { readDistributionPin } from "./distribution-manifest.js";
import { resolvePinnedDistribution } from "./installation-project.js";

export interface Project {
  id: string;
  path: string;
}
export interface LanguageRoot {
  language: string;
  path: string;
  ci_environments?: string[];
  ci_versions?: string[];
  ci_platforms?: string[];
  ci_compatibility?: boolean;
  standard?: string;
  compiler?: "clang" | "gcc";
  lto?: "off" | "thin" | "full";
  compilers?: Partial<Record<"clang" | "gcc", { minimum: string; ci_versions: string[]; ci_architectures?: string[] }>>;
}
export type Kind = "ADR" | "TSK" | "EXP" | "ENV" | "CIT" | "REL";
export interface RecordFile {
  number: string;
  path: string;
}
export interface CheckDefinition {
  name: string;
  role: string;
  project?: string;
  path?: string;
  command: string[];
  stages?: string[];
  heavy?: boolean;
  environment?: string;
  warn_seconds?: number;
  coverage?: {
    command: string[];
    stages?: string[];
    operating_systems?: string[];
    environments?: string[];
  };
}
export type Config = Record<string, unknown> & {
  collections?: { sources?: CollectionPin[] };
  execution?: { cpus_per_job?: number; max_jobs?: number };
  development?: { default?: string; profiles?: DevelopmentProfile[] };
  release?: { profiles?: ReleaseProfile[] };
  update?: { remote?: string; revision?: string };
  bundle?: { compression?: "brotli" | "zlib" | "zstd" };
  markdown?: { wrap_width?: number };
  checks?: { environment?: string; nix_docker_image?: string; allow_empty?: boolean };
  ci?: {
    operating_systems?: string[];
    architectures?: Partial<Record<"linux" | "macos" | "windows", string[]>>;
    environments?: string[];
    dependencies?: { paths: string[]; roots: string[] }[];
  };
  compatibility?: { required?: boolean };
  check?: CheckDefinition[];
  check_suite?: { language: string; path: string }[];
};

export const workspaceSchemaVersion = 1;

const kindDetails: Record<Kind, { directory: string; map: string; extension: string; title: string }> = {
  ADR: { directory: "decisions", map: "decision-map.md", extension: "md", title: "Decision" },
  TSK: { directory: "tasks", map: "task-map.md", extension: "md", title: "Task" },
  EXP: { directory: "experiments", map: "experiment-map.md", extension: "md", title: "Experiment" },
  ENV: { directory: "environments", map: "environment-map.md", extension: "md", title: "Environment" },
  CIT: { directory: "citations", map: "citation-map.md", extension: "yaml", title: "Citation" },
  REL: { directory: "releases", map: "release-map.md", extension: "yaml", title: "Release" },
};
export const kinds = Object.keys(kindDetails) as Kind[];
export function detail(kind: Kind) {
  return kindDetails[kind];
}

export function projectRoot(): string {
  if (process.env.WORKBENCH_PROJECT_ROOT) {
    const root = resolve(process.env.WORKBENCH_PROJECT_ROOT);
    return existsSync(root) ? realpathSync(root) : root;
  }
  let current = process.cwd();
  for (;;) {
    if (existsSync(join(current, "workbench/projects.toml"))) return current;
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

export function distributionRoot(root: string): string {
  const pin = readDistributionPin(root);
  if (pin) return realpathSync(resolvePinnedDistribution(root, root));
  for (const candidate of [process.env.WORKBENCH_DISTRIBUTION_ROOT, root, join(root, ".workbench")]) {
    if (candidate && existsSync(join(candidate, "languages/index.toml"))) return realpathSync(candidate);
  }
  throw new InvalidInput("could not locate Workbench distribution");
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}
export function readToml(path: string): unknown {
  return parse(readText(path));
}
export function readConfig(root: string): Config {
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
  return config;
}

const validName = /^[a-z][a-z0-9_-]*$/;
export function readProjects(root: string): Project[] {
  const path = ownedPath(root, "workbench/projects.toml");
  const registry = readToml(path) as { project?: Project[] };
  validateRegistry(registry, path);
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
    if (
      project.path !== "." &&
      (isAbsolute(project.path) ||
        project.path.includes("\\") ||
        project.path
          .split(/[\\/]/)
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              [".git", ".workbench", "workbench", "target", "libexec"].includes(part),
          ))
    ) {
      throw new Error(`${path}: unsafe project path '${project.path}'`);
    }
    if (ids.has(project.id) || paths.has(project.path)) throw new Error(`${path}: duplicate project ID or path`);
    ids.add(project.id);
    paths.add(project.path);
    ownedPath(root, project.path);
    if (index > 0) {
      let directory = root;
      for (const component of project.path.split("/")) {
        directory = join(directory, component);
        if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
          throw new Error(`${directory}: symlinked project directories are not supported`);
        }
      }
    }
  }
  return projects;
}

export function readLanguageRoots(root: string): LanguageRoot[] {
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
    if (
      !validName.test(entry.language) ||
      typeof entry.path !== "string" ||
      (entry.path !== "." &&
        (isAbsolute(entry.path) ||
          entry.path.includes("\\") ||
          entry.path
            .split(/[\\/]/)
            .some(
              (part) =>
                !part ||
                part === "." ||
                part === ".." ||
                [".git", ".workbench", "workbench", "target", "libexec"].includes(part),
            )))
    )
      throw new InvalidInput(`${path}: invalid language root`);
    const key = `${entry.language}:${entry.path}`;
    if (seen.has(key)) throw new InvalidInput(`${path}: duplicate language root '${key}'`);
    seen.add(key);
    return entry;
  });
}

export function rootOf(root: string, project: Project): string {
  return project.path === "." ? root : join(root, project.path);
}
export function selectProject(root: string, id?: string): Project {
  const projects = readProjects(root);
  const project = id ? projects.find((entry) => entry.id.toLowerCase() === id.toLowerCase()) : projects[0];
  if (!project) throw new Error(`unknown project: ${String(id)}`);
  return project;
}

export function normalizedNumber(value: string): string {
  const digits = value.replaceAll("_", "").toUpperCase();
  if (!/^[0-9A-Z]+$/.test(digits)) throw new Error(`invalid base-36 number: ${value}`);
  return digits.replace(/^0+(?=.)/, "");
}

export function nextNumber(value: string): string {
  const digits = value.split("");
  for (let index = digits.length - 1; index >= 0; index--) {
    const digit = digits[index];
    if (!digit) continue;
    if (digit === "Z") {
      digits[index] = "0";
      continue;
    }
    if (digit === "9") digits[index] = "A";
    else digits[index] = String.fromCharCode(digit.charCodeAt(0) + 1);
    return digits.join("");
  }
  return `1${digits.join("")}`;
}

export function relativeRecordPath(kind: Kind, number: string): string {
  const normalized = normalizedNumber(number);
  const padded = normalized.length % 2 ? `0${normalized}` : normalized;
  const pairs = padded.match(/.{2}/g) ?? [];
  return join(detail(kind).directory, ...pairs.slice(0, -1), `${kind}-${padded}.${detail(kind).extension}`);
}

export function scan(projectDirectory: string, kind: Kind): RecordFile[] {
  const base = ownedPath(projectDirectory, "workbench");
  const directory = join(base, detail(kind).directory);
  if (!existsSync(directory)) return [];
  const found: RecordFile[] = [];
  function walk(current: string): void {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${current}: record directory must be real`);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`${path}: unsupported record entry`);
      const match = new RegExp(`^${kind}-([0-9A-Za-z_]+)\\.${detail(kind).extension}$`).exec(entry.name);
      if (!match?.[1]) throw new Error(`${path}: unexpected file in record directory`);
      const number = normalizedNumber(match[1]);
      const expected = join(base, relativeRecordPath(kind, number));
      if (path !== expected) throw new Error(`${path}: expected canonical path ${expected}`);
      if (found.some((record) => record.number === number)) throw new Error(`${path}: duplicate normalized identity`);
      found.push({ number, path });
    }
  }
  walk(directory);
  return found.sort((a, b) => a.number.length - b.number.length || a.number.localeCompare(b.number));
}

export function parseReference(
  root: string,
  reference: string,
): { project: Project; kind: Kind; number: string; path: string } {
  const match = /^([^:]+):([A-Za-z]+)-([0-9A-Za-z_]+)$/.exec(reference);
  if (!match?.[1] || !match[2] || !match[3]) throw new Error(`invalid record reference: ${reference}`);
  const project = selectProject(root, match[1]);
  const kind = match[2].toUpperCase() as Kind;
  if (!kinds.includes(kind)) throw new Error(`unknown record type: ${match[2]}`);
  const number = normalizedNumber(match[3]);
  return {
    project,
    kind,
    number,
    path: ownedPath(
      rootOf(root, project),
      ["workbench", relativeRecordPath(kind, number).split(sep).join("/")].join("/"),
    ),
  };
}

export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, contents, { flag: "wx" });
  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

export function writeNew(path: string, contents: string | Uint8Array, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
}

export function safeRelative(base: string, path: string): string {
  const value = relative(base, path);
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error(`${path}: outside ${base}`);
  return value;
}
