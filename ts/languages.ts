import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  distributionRoot,
  readConfig,
  readLanguageRoots,
  readProjects,
  readText,
  readToml,
  writeAtomic,
  writeNew,
} from "./core.js";
import { runCommand } from "./checks.js";

export type Language = {
  id: string;
  name: string;
  summary: string;
  reference: string;
  manifests: string[];
  check: Array<{ role: string; command: string[]; heavy?: boolean }>;
};

export function catalog(root: string): Language[] {
  const path = join(distributionRoot(root), "examples/languages/index.toml");
  const parsed = readToml<{ schema_version: number; language: Language[] }>(path);
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.language)) throw new Error(`${path}: invalid catalog`);
  const seen = new Set<string>();
  for (const language of parsed.language) {
    if (
      !language.id ||
      seen.has(language.id) ||
      !language.name ||
      !language.summary ||
      !language.reference ||
      !Array.isArray(language.manifests) ||
      !Array.isArray(language.check)
    ) {
      throw new Error(`${path}: incomplete language metadata`);
    }
    seen.add(language.id);
  }
  return parsed.language;
}

export function detected(root: string, path: string): Array<[string, string]> {
  const directory = path === "." ? root : join(root, path);
  return catalog(root).flatMap((language) => {
    const manifest = language.manifests.find((name) => existsSync(join(directory, name)));
    return manifest ? [[language.id, `${manifest} is present`]] : [];
  });
}

export function reportLanguages(root: string, selected?: string): void {
  const languages = catalog(root);
  const projects = readProjects(root).filter(
    (project) => !selected || project.id.toLowerCase() === selected.toLowerCase(),
  );
  if (!projects.length) throw new Error(`unknown project: ${selected}`);
  const roots = readLanguageRoots(root);
  for (const project of projects) {
    const configured = roots.filter(
      (entry) => project.path === "." || entry.path === project.path || entry.path.startsWith(`${project.path}/`),
    );
    const evidence = detected(root, project.path);
    console.log(`${project.id}: ${configured.map((entry) => `${entry.language}@${entry.path}`).join(", ") || "none"}`);
    console.log(
      `  detected manifests: ${evidence.map(([language, description]) => `${language} (${description})`).join(", ") || "none"}`,
    );
    const reported = new Set<string>();
    for (const languageId of [
      ...configured.map((entry) => entry.language),
      ...evidence.map(([language]) => language),
    ]) {
      if (reported.has(languageId)) continue;
      reported.add(languageId);
      const language = languages.find((candidate) => candidate.id === languageId);
      console.log(
        language
          ? `  ${language.name} reference: ${language.reference} (${language.summary})`
          : `  ${languageId}: no built-in reference project; configured checks remain authoritative`,
      );
    }
  }
}

export function initLanguage(root: string, languageId: string, path = "."): void {
  const language = catalog(root).find((entry) => entry.id === languageId);
  if (!language) throw new Error(`unsupported language: ${languageId}`);
  if (languageId !== "typescript") throw new Error(`starter initialization is not yet available for ${languageId}`);
  const normalized = path.replace(/\/$/, "") || ".";
  const registry = join(root, "workbench/projects.toml");
  const configPath = join(root, "workbench/config.toml");
  readConfig(root);
  const originalConfig = readText(configPath);
  const candidate = `${readText(registry).trimEnd()}\n\n[[language_root]]\nlanguage = "${languageId}"\npath = "${normalized}"\n`;
  if (
    normalized !== "." &&
    (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(normalized) ||
      normalized
        .split(/[\\/]/)
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            [".git", ".workbench", "workbench", "target", "libexec"].includes(part),
        ))
  )
    throw new Error(`unsafe language root: ${path}`);
  if (readLanguageRoots(root).some((entry) => entry.language === languageId && entry.path === normalized))
    throw new Error(`language root already registered: ${languageId}@${normalized}`);
  const directory = normalized === "." ? root : join(root, normalized);
  if (!existsSync(directory)) throw new Error(`${directory}: language root must exist`);
  let current = root;
  for (const component of normalized === "." ? [] : normalized.split("/")) {
    current = join(current, component);
    if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())
      throw new Error(`${directory}: language root must be a real directory`);
  }
  const reference = join(distributionRoot(root), language.reference);
  const files = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "eslint.config.mjs",
    ".prettierrc.json",
    "vitest.config.mjs",
    "src/arithmetic.ts",
    "test/arithmetic.test.ts",
  ];
  for (const file of files)
    if (existsSync(join(directory, file)))
      throw new Error(
        `${join(directory, file)} already exists; select an empty language root or configure it manually`,
      );
  const copies = files.map((file) => {
    let body = readFileSync(join(reference, file), "utf8");
    if (file === "package.json") {
      const package_ = JSON.parse(body) as Record<string, unknown>;
      package_.name = normalized === "." ? readProjects(root)[0]!.id : normalized.split("/").at(-1)!;
      body = `${JSON.stringify(package_, null, 2)}\n`;
    }
    return [file, body] as const;
  });
  for (const [file, body] of copies) {
    writeNew(join(directory, file), body);
  }
  writeAtomic(registry, candidate);
  const command = (subcommand: string[]) =>
    JSON.stringify(["npm", "exec", "--yes", "--package=pnpm@12.6.0", "--", "pnpm", ...subcommand]);
  const roles = [
    ["setup", ["install", "--frozen-lockfile"], true],
    ["format", ["run", "format:check"], false],
    ["lint", ["run", "lint"], false],
    ["type", ["run", "typecheck"], true],
    ["test", ["run", "test"], true],
  ] as const;
  const additions = roles
    .map(
      ([role, args, heavy]) =>
        `\n[[check]]\nname = "${languageId}@${normalized} ${role}"\nrole = "${role}"\npath = "${normalized}"\ncommand = ${command([...args])}\nheavy = ${heavy}\n`,
    )
    .join("");
  writeAtomic(configPath, `${originalConfig.trimEnd()}\n${additions}`);
  console.log(
    `Initialized ${languageId} at ${normalized}; install dependencies, then adapt the starter and its configured checks.`,
  );
}

export function listLanguages(root: string): void {
  for (const language of catalog(root)) {
    console.log(`${language.id} (${language.name}): ${language.summary}`);
    console.log(`  reference: ${language.reference}`);
    for (const check of language.check) {
      console.log(`  role ${check.role}${check.heavy ? ", heavy" : ""}: ${check.command.join(" ")}`);
    }
  }
}

export function checkLanguages(root: string, selected?: string, all = false): void {
  if (!selected && !all) throw new Error("supply a language or use 'workbench language check --all'");
  const languages = catalog(root).filter(
    (language) => !selected || language.id.toLowerCase() === selected.toLowerCase(),
  );
  if (!languages.length) throw new Error(`unsupported language: ${selected}`);
  const distribution = distributionRoot(root);
  for (const language of languages) {
    const directory = join(distribution, language.reference);
    if (!existsSync(directory)) throw new Error(`${language.name} reference project is missing: ${directory}`);
    for (const check of language.check) {
      console.log(`Running ${language.name} reference ${check.role} check...`);
      runCommand(directory, `${language.name} reference ${check.role} check`, check.command, !!check.heavy);
    }
  }
}
