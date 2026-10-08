import { required } from "./invariants.js";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { readConfig, readLanguageRoots, type LanguageRoot } from "./core.js";
import { ciCoverage } from "./ci.js";
import { checkEnvironment } from "./environments.js";

interface Link {
  destination: string;
  source: string;
}

const environments = ["guix", "nix"] as const;
const safeName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function configured(root: string): {
  languageRoots: LanguageRoot[];
  activeEnvironments: Set<string>;
} {
  const languageRoots = readLanguageRoots(root);
  const config = readConfig(root);
  const activeEnvironments = new Set<string>();
  const configuredEnvironment = config.checks?.environment ?? "native";
  const values = [
    configuredEnvironment,
    ...(config.check ?? []).map((check) => check.environment ?? configuredEnvironment),
  ];
  for (const value of values) checkEnvironment(value, "workbench/config.toml: check environment");
  for (const check of config.check ?? []) {
    const selected = check.environment ?? configuredEnvironment;
    if (selected !== "native") activeEnvironments.add(selected === "nix-docker" ? "nix" : selected);
  }
  for (const entry of ciCoverage(root, config)?.roots ?? []) {
    for (const selected of entry.environments) activeEnvironments.add(selected === "nix-docker" ? "nix" : selected);
  }
  return { languageRoots, activeEnvironments };
}

function validateSkill(source: string): void {
  const path = join(source, "SKILL.md");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(path, "utf8"));
  if (!frontmatter) throw new Error(`${path}: skill needs YAML frontmatter`);
  const data = parseYaml(required(frontmatter[1], "expected frontmatter[1]")) as Record<string, unknown> | null;
  const name = basename(source);
  if (!safeName.test(name) || name.length > 64 || data?.name !== name)
    throw new Error(`${path}: skill name must match its directory and use lowercase letters, digits, and hyphens`);
  if (typeof data.description !== "string" || !data.description.trim() || data.description.length > 1024)
    throw new Error(`${path}: skill needs a description of at most 1024 characters`);
  const explicit = data["disable-model-invocation"];
  if (explicit !== undefined && typeof explicit !== "boolean")
    throw new Error(`${path}: disable-model-invocation must be Boolean`);
  const codexPath = join(source, "agents/openai.yaml");
  const codex = existsSync(codexPath)
    ? (parseYaml(readFileSync(codexPath, "utf8")) as { policy?: { allow_implicit_invocation?: unknown } } | null)
    : null;
  if (existsSync(codexPath) && (!codex || typeof codex !== "object" || Array.isArray(codex)))
    throw new Error(`${codexPath}: expected a metadata mapping`);
  const selection = codex?.policy?.allow_implicit_invocation;
  const implicit = selection === undefined ? true : selection;
  if (typeof implicit !== "boolean" || implicit === (explicit ?? false))
    throw new Error(`${source}: Codex and Claude invocation policies must agree`);
}

function skillDirectories(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, "SKILL.md")))
    .map((entry) => {
      const source = join(directory, entry.name);
      validateSkill(source);
      return source;
    });
}

function desiredLinks(root: string, distribution: string): Link[] {
  const { languageRoots, activeEnvironments } = configured(root);
  const links: Link[] = [];
  const sources = skillDirectories(join(distribution, "skills/workflows"));
  const languageDirectory = join(distribution, "skills/languages");
  const languageSkills = new Map<string, string[]>();
  if (existsSync(languageDirectory)) {
    for (const entry of readdirSync(languageDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && safeName.test(entry.name)) {
        languageSkills.set(entry.name, skillDirectories(join(languageDirectory, entry.name)));
      }
    }
  }
  for (const environment of environments) {
    const source = join(distribution, "skills", `${environment}-update`);
    if (!existsSync(join(source, "SKILL.md"))) continue;
    validateSkill(source);
    if (activeEnvironments.has(environment)) sources.push(source);
  }
  for (const entry of languageRoots) {
    const language = entry.language;
    if (!safeName.test(language)) throw new Error(`workbench/projects.toml: invalid language '${language}'`);
    if (entry.path !== "." && (isAbsolute(entry.path) || entry.path.split("/").some((part) => part === "..")))
      throw new Error(`workbench/projects.toml: unsafe language root '${entry.path}'`);
    sources.push(...(languageSkills.get(language) ?? []));
  }
  for (const source of sources) {
    for (const folder of [".agents/skills", ".claude/skills"])
      links.push({ destination: join(root, folder, basename(source)), source });
  }
  const byDestination = new Map<string, string>();
  for (const link of links) {
    const previous = byDestination.get(link.destination);
    if (previous && previous !== link.source) throw new Error(`ambiguous skill '${basename(link.destination)}'`);
    byDestination.set(link.destination, link.source);
  }
  return [...byDestination].map(([destination, source]) => ({ destination, source }));
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
  const embedded = join(root, ".workbench");
  // Staged snapshots may mount the verified dependency through a symlink. Keep links checkout-relative.
  const distribution =
    existsSync(embedded) && realpathSync(embedded) === realpathSync(distributionInput)
      ? embedded
      : resolve(distributionInput);
  const links = desiredLinks(root, distribution);
  const desired = new Map(links.map(({ destination, source }) => [destination, source]));
  const folders = [join(root, ".agents/skills"), join(root, ".claude/skills")];
  const changed: string[] = [];
  // Reject redirected discovery directories before writing or removing any links.
  for (const folder of folders) {
    for (const path of [dirname(folder), folder]) {
      if (existingPath(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()))
        throw new Error(`${path}: skill discovery directory must be a real directory`);
    }
  }
  for (const { destination } of links) {
    if (existingPath(destination) && !ownedSymlink(destination, distribution))
      throw new Error(`${destination}: existing user-owned skill blocks Workbench activation`);
  }
  for (const folder of folders) {
    const names = new Set([
      ...links.filter((link) => dirname(link.destination) === folder).map((link) => basename(link.destination)),
      ...(existsSync(folder) ? readdirSync(folder) : []),
    ]);
    for (const name of [...names].sort()) {
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
