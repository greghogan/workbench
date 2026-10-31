import { projectBreadcrumb } from "./project-hierarchy.js";
import { required } from "./invariants.js";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type TomlTable } from "smol-toml";
import { editToml } from "./toml-edit.js";
import { ProjectEdits } from "./project-edits.js";
import { readLanguageRoots, readProjects } from "./project-configuration.js";
import { readText } from "./files.js";
import { ownedPath, registeredRootPath } from "./paths.js";
import { defaultId } from "./project-identity.js";
import { quote } from "./toolchains.js";
import { catalog } from "./language-config.js";
export { catalog } from "./language-config.js";
export type { Language } from "./language-config.js";

export function detected(root: string, path: string): [string, string][] {
  const directory = path === "." ? root : join(root, path);
  return catalog(root).flatMap((language) => {
    const manifest = language.manifests.find((name) => existsSync(join(directory, name)));
    if (manifest && ["c", "cpp"].includes(language.id)) {
      const cmake = readText(join(directory, manifest));
      const cleaned = cmake.replace(/#\[(=*)\[[\s\S]*?\]\1\]/g, "").replace(/#[^\n]*/g, "");
      const project = /\bproject\s*\(([^)]*)\)/i.exec(cleaned)?.[1];
      const tokens = project?.match(/"[^"]*"|[^\s]+/g) ?? [];
      const languages = tokens.findIndex((token) => token.toUpperCase() === "LANGUAGES");
      const implicit =
        tokens.length === 1 ||
        ["VERSION", "COMPAT_VERSION", "DESCRIPTION", "HOMEPAGE_URL", "SPDX_LICENSE"].includes(
          tokens[1]?.toUpperCase() ?? "",
        );
      const declarations =
        languages >= 0
          ? tokens.slice(languages + 1)
          : implicit
            ? ["C", "CXX"]
            : tokens.slice(1).flatMap((token) => token.replace(/^"|"$/g, "").split(";"));
      // Dynamic CMake is not evaluated during discovery; explicit registration remains available.
      if (!declarations.includes(language.id === "c" ? "C" : "CXX")) return [];
    }
    return manifest ? [[language.id, `${manifest} is present`]] : [];
  });
}

export function reportLanguages(root: string, selected?: string): void {
  const languages = catalog(root);
  const allProjects = readProjects(root);
  const projects = allProjects.filter((project) => !selected || project.id.toLowerCase() === selected.toLowerCase());
  if (!projects.length) throw new Error(`unknown project: ${String(selected)}`);
  const roots = readLanguageRoots(root);
  for (const project of projects) {
    const configured = roots.filter(
      (entry) => project.path === "." || entry.path === project.path || entry.path.startsWith(`${project.path}/`),
    );
    const evidence = detected(root, project.path);
    console.log(
      `${projectBreadcrumb(project, allProjects)}${project.name ? ` (${project.id})` : ""}: ${configured.map((entry) => `${entry.language}@${entry.path}`).join(", ") || "none"}`,
    );
    console.log(
      `  detected manifests: ${evidence.map(([language, description]) => `${language} (${description})`).join(", ") || "none"}`,
    );
    if (
      existsSync(join(root, project.path, "CMakeLists.txt")) &&
      !evidence.some(([language]) => ["c", "cpp"].includes(language))
    )
      console.log(
        "  CMake language selection is not statically identified. CMake is not executed during discovery; use 'workbench init --adopt --language c' or 'cpp' for explicit registration.",
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

export function planLanguage(
  edits: ProjectEdits,
  languageId: string,
  path = ".",
  options: { adopt?: boolean; id?: string; check?: string[] } = {},
): void {
  const root = edits.root;
  const language = catalog(root).find((entry) => entry.id === languageId);
  if (!language)
    throw new Error(`unsupported language: ${languageId}; run 'workbench language' to inspect supported definitions`);
  if (!language.starter && !options.adopt)
    throw new Error(`no starter for ${languageId}; use --adopt with project-owned checks`);
  const normalized = path.replace(/\/$/, "") || ".";
  registeredRootPath(normalized, "unsafe language root");
  const directory = ownedPath(root, normalized);
  if (existsSync(directory) && !lstatSync(directory).isDirectory())
    throw new Error(`${normalized}: language root must be a real directory`);
  if (options.adopt && !existsSync(directory)) throw new Error(`${normalized}: existing language root is missing`);
  const registryPath = "workbench/projects.toml";
  const registryText = required(edits.read(registryPath), "initialize the project before selecting a language");
  const registry = parse(registryText);
  const roots = (registry.language_root ?? []) as TomlTable[];
  const registered = roots.find((entry) => entry.language === languageId && entry.path === normalized);
  if (registered && !options.adopt)
    throw new Error(
      `language root already registered: ${languageId}@${normalized}; use --adopt to configure existing checks`,
    );
  if (!registered)
    roots.push({
      language: languageId,
      path: normalized,
      ...(!options.adopt ? language.starter_root : {}),
    });
  registry.language_root = roots;
  edits.write(registryPath, editToml(registryText, registry));
  const configText = required(edits.read("workbench/config.toml"), "project configuration");
  const configPath = parse(configText).check !== undefined ? "workbench/config.toml" : "workbench/automation.toml";
  const automationText = edits.read(configPath) ?? "";
  const automation = parse(automationText);
  if (options.check?.length) {
    const checks = (automation.check ?? []) as TomlTable[];
    for (const [index, command] of options.check.entries()) {
      if (!command.trim()) throw new Error("--check requires a nonempty shell command");
      const name = `${languageId}@${normalized}: project check ${String(index + 1)}`;
      if (checks.some((check) => check.name === name)) throw new Error(`${name} is already configured`);
      checks.push({ name, role: "test", path: normalized, command: ["sh", "-c", command] });
    }
    automation.check = checks;
  } else if (!options.adopt) {
    const suites = (automation.check_suite ?? []) as TomlTable[];
    if (!suites.some((suite) => suite.language === languageId && suite.path === normalized))
      suites.push({ language: languageId, path: normalized });
    automation.check_suite = suites;
  }
  if (Object.keys(automation).length) edits.write(configPath, editToml(automationText, automation));
  if (options.adopt) return;
  const reference = join(language.referenceRoot, language.reference);
  const prefix = normalized === "." ? "" : `${normalized}/`;
  for (const file of language.starter ?? []) {
    if (file === "README.md" && edits.read(`${prefix}${file}`) !== undefined) continue;
    const destination =
      file === "LICENSE" && edits.read(`${prefix}LICENSE`) !== undefined ? "LICENSE.workbench-example" : file;
    const asset = language.starter_assets?.find((asset) => asset.path === file);
    const source = asset ? ownedPath(language.directory, asset.source) : ownedPath(reference, file);
    const metadata = lstatSync(source);
    if (!metadata.isFile()) throw new Error(`${source}: starter must be a regular file`);
    let body: string | Buffer = readFileSync(source);
    if (file === "package.json") {
      const package_ = JSON.parse(body.toString()) as Record<string, unknown>;
      package_.name =
        normalized === "." ? (options.id ?? required(readProjects(root)[0], "root project").id) : defaultId(normalized);
      body = `${JSON.stringify(package_, null, 2)}\n`;
    }
    if (file === "README.md") {
      const examples = body.toString().match(/```console\n[\s\S]*?\n```/g) ?? [];
      body =
        `# ${options.id ?? language.name}\n\nProject-owned ${language.name} starter. Adapt the source, manifests, and checks to your application.\n\n` +
        `Install declared tools with \`workbench tools install --path ${quote(normalized)}\`, then run \`workbench check --path ${quote(normalized)}\`.\n\n` +
        (examples.length ? `## Executable examples\n\n${examples.join("\n\n")}\n` : "");
    }
    const target = `${prefix}${destination}`;
    if (file === ".gitignore" && edits.read(target) !== undefined) {
      const original = required(edits.read(target), "ignore file");
      const present = new Set(original.split(/\r?\n/));
      const added = body
        .toString("utf8")
        .split(/\r?\n/)
        .filter((line) => line && !present.has(line));
      if (added.length)
        edits.write(target, `${original.trimEnd()}\n\n# ${language.name} starter outputs\n${added.join("\n")}\n`);
    } else edits.create(target, body, metadata.mode & 0o777);
  }
}

export function initLanguage(root: string, languageId: string, path = "."): void {
  const edits = new ProjectEdits(root);
  planLanguage(edits, languageId, path);
  edits.apply();
  console.log(`Initialized ${languageId} at ${path}. Copied files and checks are project-owned.`);
  console.log(`Next: workbench tools install --path ${quote(path)}\nThen: workbench check --path ${quote(path)}`);
}

export function listLanguages(root: string): void {
  for (const language of catalog(root)) {
    console.log(`${language.id} (${language.name}): ${language.summary}`);
    console.log(
      `  initializer: ${language.starter ? "available" : "adopt existing code"}; native tool installation follows exact project pins; managed environments require project-owned definitions`,
    );
    console.log(`  definition: ${language.source} (${language.directory})`);
    console.log(`  reference: ${join(language.referenceRoot, language.reference)}`);
    for (const check of language.command) {
      console.log(`  role ${check.role}: ${check.command.join(" ")}`);
    }
  }
}
