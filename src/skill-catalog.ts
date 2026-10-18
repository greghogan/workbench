import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { readConfig, readLanguageRoots } from "./core.js";
import { hasCollectionProject } from "./collections.js";
import { ciCoverage } from "./ci.js";
import { readChecks } from "./checks.js";

export interface SkillIdentity {
  name: string;
  digest: string;
}

export interface Skill extends SkillIdentity {
  description: string;
  source: string;
  language?: string;
  environment?: string;
}

function fingerprint(directory: string): string {
  const hash = createHash("sha256");
  function visit(prefix: string): void {
    for (const name of readdirSync(join(directory, prefix)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = join(directory, relative);
      const info = lstatSync(path);
      if (info.isDirectory()) visit(relative);
      else {
        if (!info.isFile() || info.size > 1024 * 1024)
          throw new Error(`${path}: skill sources must be bounded regular files`);
        hash.update(JSON.stringify([relative, createHash("sha256").update(readFileSync(path)).digest("hex")]));
      }
    }
  }
  visit("");
  return hash.digest("hex");
}

function readSkill(source: string): Skill {
  const path = join(source, "SKILL.md");
  const text = readFileSync(path, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!frontmatter) throw new Error(`${path}: skill needs YAML frontmatter`);
  const data = parse(frontmatter) as Record<string, unknown> | null;
  const name = basename(source);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || data?.name !== name)
    throw new Error(`${path}: skill name must match its directory and use lowercase letters, digits, and hyphens`);
  if (typeof data.description !== "string" || !data.description.trim() || data.description.length > 1024)
    throw new Error(`${path}: skill needs a description of at most 1024 characters`);
  const explicit = data["disable-model-invocation"];
  if (explicit !== undefined && typeof explicit !== "boolean")
    throw new Error(`${path}: disable-model-invocation must be Boolean`);
  const codexPath = join(source, "agents/openai.yaml");
  const codex = existsSync(codexPath)
    ? (parse(readFileSync(codexPath, "utf8")) as { policy?: { allow_implicit_invocation?: unknown } } | null)
    : null;
  if (existsSync(codexPath) && (!codex || typeof codex !== "object" || Array.isArray(codex)))
    throw new Error(`${codexPath}: expected a metadata mapping`);
  const selection = codex?.policy?.allow_implicit_invocation;
  const implicit = selection === undefined ? true : selection;
  if (typeof implicit !== "boolean" || implicit === (explicit ?? false))
    throw new Error(`${source}: Codex and Claude invocation policies must agree`);
  return { name, description: data.description, source, digest: fingerprint(source) };
}

export function skillCatalog(distribution: string): Skill[] {
  const sources: Skill[] = [];
  function scoped(source: string, scope: Partial<Pick<Skill, "language" | "environment">>): Skill {
    const skill = readSkill(source);
    return {
      ...skill,
      ...scope,
      digest: createHash("sha256")
        .update(JSON.stringify([skill.digest, scope.language ?? null, scope.environment ?? null]))
        .digest("hex"),
    };
  }
  function collect(directory: string, scope: Partial<Pick<Skill, "language" | "environment">> = {}): void {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory() && existsSync(join(directory, entry.name, "SKILL.md")))
        sources.push(scoped(join(directory, entry.name), scope));
  }
  collect(join(distribution, "skills/workflows"));
  const languages = join(distribution, "skills/languages");
  if (existsSync(languages))
    for (const entry of readdirSync(languages, { withFileTypes: true }))
      if (entry.isDirectory()) collect(join(languages, entry.name), { language: entry.name });
  for (const environment of ["nix", "guix"])
    if (existsSync(join(distribution, `skills/${environment}-update/SKILL.md`)))
      sources.push(scoped(join(distribution, `skills/${environment}-update`), { environment }));
  if (new Set(sources.map((skill) => skill.name)).size !== sources.length)
    throw new Error("ambiguous skill name in distribution");
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillApplicability(root: string, catalog: Skill[]): Map<string, string | undefined> {
  const project = hasCollectionProject(root);
  const languages = new Set(project ? readLanguageRoots(root).map((entry) => entry.language) : []);
  const config = project ? readConfig(root) : undefined;
  const environments = new Set(
    [
      ...(project ? readChecks(root).map((check) => check.environment) : []),
      ...(config ? (ciCoverage(root, config)?.roots.flatMap((entry) => entry.environments) ?? []) : []),
    ].map((environment) => (environment === "nix-docker" ? "nix" : environment)),
  );
  return new Map(
    catalog.map((skill) => [
      skill.name,
      !project
        ? "requires a configured project"
        : skill.language && !languages.has(skill.language)
          ? `requires a registered ${skill.language} root`
          : skill.environment && !environments.has(skill.environment)
            ? `requires ${skill.environment} checks`
            : undefined,
    ]),
  );
}

/** Validate the compact update handoff before applying any project changes. */
export function parseSkillIdentities(value: unknown, context: string): SkillIdentity[] {
  if (!Array.isArray(value)) throw new Error(`${context}: expected a skill identity array`);
  const names = new Set<string>();
  for (const candidate of value as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error(`${context}: invalid skill identity mapping`);
    const entry = candidate as Record<string, unknown>;
    if (
      Object.keys(entry).some((key) => !["name", "digest"].includes(key)) ||
      typeof entry.name !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) ||
      entry.name.length > 64 ||
      typeof entry.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.digest) ||
      names.has(entry.name)
    )
      throw new Error(`${context}: invalid or duplicate skill identity`);
    names.add(entry.name);
  }
  return value as SkillIdentity[];
}

export function skillIdentities(skills: SkillIdentity[]): SkillIdentity[] {
  return skills.map(({ name, digest }) => ({ name, digest }));
}

export function skillChanges(before: SkillIdentity[], after: SkillIdentity[]) {
  const prior = new Map(before.map((skill) => [skill.name, skill.digest]));
  const next = new Map(after.map((skill) => [skill.name, skill.digest]));
  return {
    added: after.filter((skill) => !prior.has(skill.name)).map((skill) => skill.name),
    removed: before.filter((skill) => !next.has(skill.name)).map((skill) => skill.name),
    changed: after
      .filter((skill) => prior.has(skill.name) && prior.get(skill.name) !== skill.digest)
      .map((skill) => skill.name),
  };
}
