import { required } from "./invariants.js";
import { citationLibrarySetting } from "./citations.js";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, appendFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  distributionRoot,
  readConfig,
  readProjects,
  readText,
  writeAtomic,
  writeNew,
  workspaceSchemaVersion,
} from "./core.js";
import { ensureLocalIgnore } from "./environments.js";
import { detected, reportLanguages } from "./languages.js";

const validId = /^[a-z][a-z0-9_-]*$/;
const reserved = new Set([".git", ".workbench", "workbench", "target", "libexec"]);

async function prompt(label: string, suggested = ""): Promise<string> {
  if (!process.stdin.isTTY) {
    if (!suggested) throw new Error(`${label} requires an interactive terminal or explicit arguments`);
    return suggested;
  }
  const interface_ = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await interface_.question(`${label}${suggested ? ` [${suggested}]` : ""}: `)).trim() || suggested;
  } finally {
    interface_.close();
  }
}

function safeProjectPath(value: string): boolean {
  if (
    value === "." ||
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("").some((character) => character.charCodeAt(0) < 32)
  )
    return false;
  const parts = value.split("/");
  return parts.every((part) => !!part && part !== "." && part !== ".." && !reserved.has(part));
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

function defaultId(root: string): string {
  const candidate = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (validId.test(candidate)) return candidate;
  return candidate ? `project-${candidate}` : "project";
}

export async function setupProject(root: string, idInput?: string): Promise<void> {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`${root}: project root is not a directory`);
  const records = join(root, "workbench");
  const projectsPath = join(records, "projects.toml");
  const existing = existsSync(projectsPath)
    ? required(readProjects(root)[0], "expected readProjects(root)[0]").id
    : undefined;
  const id = idInput ?? existing ?? (await prompt("Root project ID", defaultId(root)));
  if (!validId.test(id)) throw new Error(`invalid root project ID: ${id}`);
  if (existing && existing !== id)
    throw new Error(`root project is already registered as '${existing}'; --id cannot rename it`);
  ensureDirectory(records);
  mkdirSync(records, { recursive: true });
  const configPath = join(records, "config.toml");
  if (!existsSync(configPath)) {
    writeNew(
      configPath,
      `schema_version = ${String(workspaceSchemaVersion)}\n\n[markdown]\nwrap_width = 120\n\n[checks]\nenvironment = "native"\n` +
        'nix_docker_image = "nixos/nix@sha256:0d9c872db1ca2f3eaa4a095baa57ed9b72c09d53a0905a4428813f61f0ea98db"\n\n' +
        '[compatibility]\nrequired = false\n\n[commit]\nstyle = "conventional"\nsubject_width = 50\n' +
        'body_width = 72\n\n[citations]\nlibrary_dir = "library/citations"\n',
    );
    console.log(`Configured ${configPath}.`);
  } else readConfig(root);
  if (!existsSync(projectsPath)) {
    const languages = detected(root, ".").map(([language]) => language);
    writeNew(
      projectsPath,
      `[[project]]\nid = "${id}"\npath = "."\n` +
        languages.map((language) => `\n[[language_root]]\nlanguage = "${language}"\npath = "."\n`).join(""),
    );
    console.log(`Registered root project in ${projectsPath}.`);
  } else readProjects(root);
  const charter = join(records, "CHARTER.md");
  if (!existsSync(charter)) console.log(`${charter} is absent; a human must write it before checks can pass.`);
  ensureLocalIgnore(root);
  if (!existsSync(join(root, "Makefile"))) {
    writeNew(join(root, "Makefile"), readText(join(distributionRoot(root), "Makefile")));
    console.log("Added static Workbench Makefile.");
  }
  reportLanguages(root, required(readProjects(root)[0], "expected readProjects(root)[0]").id);
  if (!(readConfig(root).check ?? []).length && !(readConfig(root).check_suite ?? []).length) {
    console.log(
      "No check commands are configured; inspect 'workbench checks' and add project-owned [[check]] commands.",
    );
    console.log("For structural checks alone, explicitly set checks.allow_empty = true.");
  }
}

export async function addProject(root: string, idInput?: string, pathInput?: string): Promise<void> {
  if (!!idInput !== !!pathInput) throw new Error("project ID and path must be supplied together");
  const id = idInput ?? (await prompt("Subproject ID"));
  const path = pathInput ?? (await prompt("Subproject path", id));
  if (!validId.test(id) || !safeProjectPath(path)) throw new Error(`invalid subproject ID or path: ${id}, ${path}`);
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
    `${old.trimEnd()}\n\n[[project]]\nid = "${id}"\npath = ${JSON.stringify(path)}\n` +
      languages
        .map((language) => `\n[[language_root]]\nlanguage = "${language}"\npath = ${JSON.stringify(path)}\n`)
        .join(""),
  );
  console.log(`Registered ${id} at ${path}.`);
  const charter = join(root, path, "workbench/CHARTER.md");
  if (!existsSync(charter)) console.log(`${charter} is absent; a human must write it before checks can pass.`);
  reportLanguages(root, id);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

export function configureGitHooks(root: string, distribution: string): void {
  const repository = realpathSync.native(git(root, ["rev-parse", "--show-toplevel"]));
  if (repository !== realpathSync.native(root)) throw new Error("setup must run for the project repository root");
  const expected = distribution === root ? ".githooks" : ".workbench/.githooks";
  const configured = spawnSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { encoding: "utf8" });
  if (configured.status !== 0 && configured.status !== 1) throw new Error(configured.stderr.trim());
  const current = configured.stdout.trim();
  if (current && current !== expected && current !== join(distribution, ".githooks")) {
    throw new Error(`core.hooksPath already points to '${current}'; integrate the Workbench hook without replacing it`);
  }
  for (const name of ["pre-commit", "commit-msg"]) {
    if (!existsSync(join(distribution, ".githooks", name))) throw new Error(`missing Workbench ${name} hook`);
  }
  if (!current) git(root, ["config", "--local", "core.hooksPath", expected]);
  const exclude = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  syncCitationIgnores(root, exclude);
  console.log("Enabled Workbench Git change gates");
}

export function syncCitationIgnores(root: string, excludePath?: string): void {
  if (!excludePath) {
    const repository = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (repository.status !== 0 || resolve(repository.stdout.trim()) !== resolve(root)) return;
  }
  const exclude = excludePath ?? git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  const library = citationLibrarySetting(root);
  const original = existsSync(exclude) ? readText(exclude) : "";
  const lines = new Set(original.split(/\r?\n/));
  const escape = (value: string) => value.replace(/[\\*?[\]#! ]/g, "\\$&");
  const additions = readProjects(root)
    .map((project) => `/${escape([project.path === "." ? "" : project.path, library].filter(Boolean).join("/"))}/`)
    .filter((line) => !lines.has(line));
  if (additions.length) {
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `\n${additions.join("\n")}\n`);
  }
}
