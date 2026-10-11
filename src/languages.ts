import { required } from "./invariants.js";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { readConfig, readLanguageRoots, readProjects, readText, readToml, writeAtomic, writeNew } from "./core.js";
import { runChecks, type CheckEnvironment } from "./checks.js";
import { checkEnvironment, executionPreference } from "./environments.js";
import { ownedPath } from "./paths.js";

import { catalog } from "./language-config.js";
export { catalog } from "./language-config.js";
export type { Language } from "./language-config.js";

export function detected(root: string, path: string): [string, string][] {
  const directory = path === "." ? root : join(root, path);
  return catalog(root).flatMap((language) => {
    const manifest = language.manifests.find((name) => existsSync(join(directory, name)));
    if (manifest && ["c", "cpp"].includes(language.id)) {
      const cmake = readText(join(directory, manifest));
      const declarations = /\bLANGUAGES\s+([^)]*)/i.exec(cmake)?.[1]?.split(/\s+/) ?? [];
      if (!declarations.includes(language.id === "c" ? "C" : "CXX")) return [];
    }
    return manifest ? [[language.id, `${manifest} is present`]] : [];
  });
}

export function reportLanguages(root: string, selected?: string): void {
  const languages = catalog(root);
  const projects = readProjects(root).filter(
    (project) => !selected || project.id.toLowerCase() === selected.toLowerCase(),
  );
  if (!projects.length) throw new Error(`unknown project: ${String(selected)}`);
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
          ? `  ${language.name} definition: ${language.source} (${language.directory}); reference: ${language.reference} (${language.summary})`
          : `  ${languageId}: no built-in reference project; configured checks remain authoritative`,
      );
    }
  }
}

export function initLanguage(root: string, languageId: string, path = "."): void {
  const language = catalog(root).find((entry) => entry.id === languageId);
  if (!language) throw new Error(`unsupported language: ${languageId}`);
  if (!language.starter) throw new Error(`starter initialization is not yet available for ${languageId}`);
  const normalized = path.replace(/\/$/, "") || ".";
  const registry = join(root, "workbench/projects.toml");
  const sharedPath = join(root, "workbench/config.toml");
  const inline = (readToml(sharedPath) as { check?: unknown }).check !== undefined;
  const configPath = inline ? sharedPath : join(root, "workbench/automation.toml");
  const originalConfig = existsSync(configPath) ? readText(configPath) : "";
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
  const reference = join(language.referenceRoot, language.reference);
  const files = language.starter.filter((file) => file !== "README.md" || !existsSync(join(directory, file)));
  for (const file of files)
    if (existsSync(ownedPath(directory, file)))
      throw new Error(
        `${join(directory, file)} already exists; select an empty language root or configure it manually`,
      );
  const copies = files.map((file) => {
    const source = join(reference, file);
    const metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${source}: starter must be a regular file`);
    let body = readFileSync(source);
    if (file === "package.json") {
      const package_ = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      package_.name =
        normalized === "."
          ? required(readProjects(root)[0], "expected readProjects(root)[0]").id
          : required(normalized.split("/").at(-1), 'expected normalized.split("/").at(-1)');
      body = Buffer.from(`${JSON.stringify(package_, null, 2)}\n`);
    }
    return { file, body, mode: metadata.mode & 0o777 };
  });
  for (const { file, body, mode } of copies) {
    writeNew(join(directory, file), body, mode);
  }
  writeAtomic(registry, candidate);
  const additions = stringify({ check_suite: [{ language: languageId, path: normalized }] });
  writeAtomic(configPath, `${originalConfig.trimEnd()}\n\n${additions}`);
  console.log(
    `Initialized ${languageId} at ${normalized}; install dependencies, then adapt the starter and its configured checks.`,
  );
}

export function listLanguages(root: string): void {
  for (const language of catalog(root)) {
    console.log(`${language.id} (${language.name}): ${language.summary}`);
    console.log(`  definition: ${language.source} (${language.directory})`);
    console.log(`  reference: ${join(language.referenceRoot, language.reference)}`);
    for (const check of language.command) {
      console.log(`  role ${check.role}${check.heavy ? ", heavy" : ""}: ${check.command.join(" ")}`);
    }
  }
}

export function checkLanguages(root: string, selected?: string, all = false, environment?: CheckEnvironment): void {
  if (selected && all) throw new Error("supply one language or --all, not both");
  if (!selected && !all) throw new Error("supply a language or use 'workbench language check --all'");
  const languages = catalog(root).filter(
    (language) => !selected || language.id.toLowerCase() === selected.toLowerCase(),
  );
  if (!languages.length) throw new Error(`unsupported language: ${String(selected)}`);
  environment =
    executionPreference(root, environment) ??
    checkEnvironment(readConfig(root).checks?.environment ?? "native", "checks.environment");
  for (const language of languages) {
    const directory = join(language.referenceRoot, language.reference);
    if (!existsSync(directory)) throw new Error(`${language.name} reference project is missing: ${directory}`);
    runChecks(language.referenceRoot, { path: language.reference, environment });
  }
}
