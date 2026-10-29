import { ProjectEdits } from "./project-edits.js";
import { registerConsumingProject } from "./project-registration.js";
import { editToml } from "./toml-edit.js";
import { parse } from "smol-toml";
import { projectNameField, type CommitStyle } from "./config-schema.js";
import { projectName, projectBreadcrumb } from "./project-hierarchy.js";
import { executingToolPin } from "./launcher.js";
import { plainOutput } from "./presentation.js";
import { required } from "./invariants.js";
import { citationLibrarySetting } from "./citations.js";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isAbsolute, join } from "node:path";
import { distributionRoot } from "./project-context.js";
import { readConfig, readProjects, workspaceSchemaVersion } from "./project-configuration.js";
import { readText } from "./files.js";
import { writeAtomic, writeNew } from "../scripts/file-publication.mjs";
import { ensureLocalIgnore } from "./environments.js";
import { ownedPath, registeredRootPath } from "./paths.js";
import { defaultId, projectIdPattern as validId } from "./project-identity.js";
import { detected, reportLanguages } from "./languages.js";

export async function prompt(label: string, suggested = ""): Promise<string> {
  if (!process.stdin.isTTY) {
    if (!suggested) throw new Error(`${label} requires an interactive terminal or explicit arguments`);
    return suggested;
  }
  const interface_ = createInterface({
    input: process.stdin,
    output: process.stdout,
    ...(plainOutput() ? { terminal: false } : {}),
  });
  try {
    return (await interface_.question(`${label}${suggested ? ` [${suggested}]` : ""}: `)).trim() || suggested;
  } finally {
    interface_.close();
  }
}

function ensureDirectory(path: string): void {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
    throw new Error(`${path}: expected a real directory`);
  }
}

function makeSafeDirectories(root: string, relative: string): void {
  let current = root;
  for (const part of relative.split("/")) {
    current = join(current, part);
    ensureDirectory(current);
    if (!existsSync(current)) mkdirSync(current);
  }
}

export function planProject(
  edits: ProjectEdits,
  id: string,
  options: { name?: string; commitStyle?: CommitStyle; detect?: boolean; recordsOnly?: boolean } = {},
): void {
  const root = edits.root;
  if (!validId.test(id)) throw new Error(`invalid root project ID: ${id}`);
  if (options.name !== undefined) projectNameField(options.name, "project.name");
  const projectsPath = "workbench/projects.toml";
  const registry = edits.read(projectsPath);
  if (registry !== undefined) {
    const existing = required(readProjects(root)[0], "root project").id;
    if (existing !== id) throw new Error(`root project is already registered as '${existing}'; --id cannot rename it`);
    if (options.name !== undefined) {
      const value = parse(registry);
      const entries = value.project as { name?: string }[];
      required(entries[0], "root project").name = options.name;
      edits.write(projectsPath, editToml(registry, value));
    }
  } else {
    const languages = options.detect ? detected(root, ".").map(([language]) => language) : [];
    edits.create(
      projectsPath,
      `[[project]]\nid = ${JSON.stringify(id)}\n${options.name === undefined ? "" : `name = ${JSON.stringify(options.name)}\n`}path = "."\n` +
        languages.map((language) => `\n[[language_root]]\nlanguage = "${language}"\npath = "."\n`).join(""),
    );
  }
  const configPath = "workbench/config.toml";
  const configText = edits.read(configPath);
  if (configText === undefined) {
    const tool = executingToolPin(distributionRoot(root));
    edits.create(
      configPath,
      `schema_version = ${String(workspaceSchemaVersion)}\n\n[markdown]\nwrap_width = 120\n\n[checks]\nenvironment = "native"\n` +
        (options.recordsOnly ? "allow_empty = true\n" : "") +
        'nix_docker_image = "nixos/nix@sha256:0d9c872db1ca2f3eaa4a095baa57ed9b72c09d53a0905a4428813f61f0ea98db"\n' +
        '\n[compatibility]\nrequired = false\ndata = "ask"\n\n[commit]\n' +
        `style = "${options.commitStyle ?? "unrestricted"}"\nsubject_width = 50\nbody_width = 72\n\n[citations]\nlibrary_dir = "library/citations"\n` +
        (tool
          ? `\n[tool]\nrepository = ${JSON.stringify(tool.repository)}\nrevision = ${JSON.stringify(tool.revision)}\n`
          : ""),
    );
  } else {
    const config = readConfig(root);
    const value = parse(configText);
    if (options.recordsOnly) {
      if ((config.check?.length ?? 0) + (config.check_suite?.length ?? 0))
        throw new Error("--records-only cannot replace configured application checks");
      const checks = (value.checks ?? {}) as Record<string, boolean | string>;
      checks.allow_empty = true;
      value.checks = checks;
    }
    if (options.commitStyle !== undefined) {
      const commit = (value.commit ?? {}) as Record<string, string>;
      commit.style = options.commitStyle;
      value.commit = commit;
    }
    edits.write(configPath, editToml(configText, value));
  }
  if (edits.read("Makefile") === undefined)
    edits.create("Makefile", readText(join(distributionRoot(root), "Makefile")));
}

export async function setupProject(root: string, idInput?: string): Promise<void> {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`${root}: project root is not a directory`);
  const existing = existsSync(join(root, "workbench/projects.toml"))
    ? required(readProjects(root)[0], "root project").id
    : undefined;
  const id = idInput ?? existing ?? (await prompt("Root project ID", defaultId(root)));
  const edits = new ProjectEdits(root);
  planProject(edits, id, { detect: true });
  edits.apply();
  console.log(
    `Configured ${projectName(required(readProjects(root)[0], "root project"))}. Existing project files and automation remain project-owned.`,
  );
  await registerConsumingProject(root);
  if (!existsSync(join(root, "workbench/CHARTER.md")))
    console.log(
      "A human must write workbench/CHARTER.md before validation can pass. Use 'workbench serve' to write it in the browser.",
    );
  ensureLocalIgnore(root);
  reportLanguages(root, id);
  if (!(readConfig(root).check ?? []).length && !(readConfig(root).check_suite ?? []).length) {
    console.log(
      "No application checks configured. Use 'workbench init --adopt --language LANGUAGE --check COMMAND' to connect existing checks.",
    );
    console.log(
      "For records alone, use 'workbench init --records-only'. Inspect the plan with 'workbench check --list'.",
    );
  }
}

export async function addProject(root: string, idInput?: string, pathInput?: string, name?: string): Promise<void> {
  if (name !== undefined) projectNameField(name, "project.name");
  if (!!idInput !== !!pathInput) throw new Error("project ID and path must be supplied together");
  const id = idInput ?? (await prompt("Subproject ID"));
  const path = pathInput ?? (await prompt("Subproject path", id));
  if (!validId.test(id) || path === ".") throw new Error(`invalid subproject ID or path: ${id}, ${path}`);
  registeredRootPath(path, `invalid subproject ID or path: ${id}`);
  const projects = readProjects(root);
  if (projects.some((project) => project.id === id || project.path === path)) {
    throw new Error(`project ID or path already registered: ${id}, ${path}`);
  }
  makeSafeDirectories(root, path);
  makeSafeDirectories(root, `${path}/workbench`);
  const languages = detected(root, path).map(([language]) => language);
  const registryPath = join(root, "workbench/projects.toml");
  const old = readText(registryPath);
  writeAtomic(
    registryPath,
    `${old.trimEnd()}\n\n[[project]]\nid = "${id}"\n${name === undefined ? "" : `name = ${JSON.stringify(name)}\n`}path = ${JSON.stringify(path)}\n` +
      languages
        .map((language) => `\n[[language_root]]\nlanguage = "${language}"\npath = ${JSON.stringify(path)}\n`)
        .join(""),
  );
  const registered = required(
    readProjects(root).find((project) => project.id === id),
    "registered subproject",
  );
  console.log(`Registered ${projectBreadcrumb(registered, readProjects(root))}${name ? ` (${id})` : ""} at ${path}.`);
  const charter = join(root, path, "workbench/CHARTER.md");
  if (!existsSync(charter)) console.log(`${charter} is absent; a human must write it before checks can pass.`);
  reportLanguages(root, id);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

export const gitHookNames = ["pre-commit", "pre-push", "commit-msg", "post-commit"] as const;

export function preflightGitHooks(root: string, distribution: string): void {
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0)
    throw new Error("initialize a Git repository first with 'git init', or use 'workbench init' to create one");
  if (realpathSync.native(top.stdout.trim()) !== realpathSync.native(root))
    throw new Error("setup must run for the project repository root");
  const configured = spawnSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { encoding: "utf8" });
  if (configured.status !== 0 && configured.status !== 1) throw new Error(configured.stderr.trim());
  const current = configured.stdout.trim();
  if (current && current !== ".githooks" && current !== join(distribution, ".githooks"))
    throw new Error(
      `core.hooksPath already points to '${current}'. Use 'workbench init' without --hooks to retain it. To compose gates, invoke the Workbench pre-commit/pre-push scripts from the existing hooks; see docs/adoption.md.`,
    );
  if (!current) {
    const hooks = git(root, ["rev-parse", "--git-path", "hooks"]);
    for (const name of gitHookNames) {
      const path = isAbsolute(hooks) ? join(hooks, name) : join(root, hooks, name);
      if (existsSync(path))
        throw new Error(
          `active Git hook ${path} already exists; omit --hooks and compose the Workbench gates explicitly`,
        );
    }
  }
  for (const name of gitHookNames) {
    const source = ownedPath(distribution, `.githooks/${name}`);
    if (!existsSync(source)) throw new Error(`missing Workbench ${name} hook`);
    const target = ownedPath(root, `.githooks/${name}`);
    if (existsSync(target) && readText(target) !== readText(source))
      throw new Error(
        `${target}: preserve the existing hook and integrate explicitly; use initialization without --hooks`,
      );
  }
}

export function configureGitHooks(
  root: string,
  distribution: string,
  report: (message: string) => void = console.log,
): void {
  preflightGitHooks(root, distribution);
  const repository = realpathSync.native(git(root, ["rev-parse", "--show-toplevel"]));
  if (repository !== realpathSync.native(root)) throw new Error("setup must run for the project repository root");
  const expected = ".githooks";
  const configured = spawnSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { encoding: "utf8" });
  if (configured.status !== 0 && configured.status !== 1) throw new Error(configured.stderr.trim());
  const current = configured.stdout.trim();
  if (current && current !== expected && current !== join(distribution, ".githooks")) {
    throw new Error(`core.hooksPath already points to '${current}'; integrate the Workbench hook without replacing it`);
  }
  for (const name of gitHookNames) {
    if (!existsSync(join(distribution, ".githooks", name))) throw new Error(`missing Workbench ${name} hook`);
  }
  if (distribution !== root) {
    for (const name of gitHookNames) {
      const output = join(root, ".githooks", name);
      const contents = readText(join(distribution, ".githooks", name));
      if (existsSync(output) && readText(output) !== contents)
        throw new Error(`${output}: preserve existing hook and integrate explicitly`);
      if (!existsSync(output)) writeNew(output, contents, 0o755);
    }
  }
  if (!current) git(root, ["config", "--local", "core.hooksPath", expected]);
  syncCitationStorage(root);
  report("Enabled Workbench Git change gates");
}

export function syncCitationStorage(root: string): void {
  const attributes = ownedPath(root, ".gitattributes");
  const rule = "**/workbench/citations/**/CIT-*/** -text";
  const contents = existsSync(attributes) ? readText(attributes) : "";
  if (!contents.split(/\r?\n/).includes(rule)) {
    const prefix = contents ? `${contents}${contents.endsWith("\n") ? "" : "\n"}\n` : "";
    writeAtomic(attributes, `${prefix}# Preserve citation supporting bytes and upstream digests.\n${rule}\n`);
  }
  if (readConfig(root).citations === undefined) return;
  const ignore = ownedPath(root, ".gitignore");
  const library = citationLibrarySetting(root);
  const original = existsSync(ignore) ? readText(ignore) : "";
  const lines = new Set(original.split(/\r?\n/));
  const escape = (value: string) => value.replace(/[\\*?[\]#! ]/g, "\\$&");
  const additions = readProjects(root)
    .map((project) => `/${escape([project.path === "." ? "" : project.path, library].filter(Boolean).join("/"))}/`)
    .filter((line) => !lines.has(line));
  if (additions.length) {
    const prefix = original ? `${original}${original.endsWith("\n") ? "" : "\n"}\n` : "";
    writeAtomic(
      ignore,
      `${prefix}# Local citation documents; bibliographic records remain tracked.\n${additions.join("\n")}\n`,
    );
  }
}
