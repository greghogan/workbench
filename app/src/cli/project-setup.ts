import { projectPaths } from "../core/projects/project-paths.js";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { projectNameField } from "../core/configuration/config-schema.js";
import { ensureLocalIgnore } from "../core/execution/environments/environments.js";
import { readConfig, readProjects } from "../core/projects/project-configuration.js";
import { ProjectEdits } from "../core/projects/project-edits.js";
import { ProjectHierarchy, projectName } from "../core/projects/project-hierarchy.js";
import { defaultId, projectIdPattern as validId } from "../core/projects/project-identity.js";
import { registerConsumingProject } from "../core/projects/project-registration.js";
import { planProject } from "../core/projects/projects.js";
import { writeAtomic } from "../core/runtime/file-publication.mjs";
import { readText } from "../core/runtime/files.js";
import { required } from "../core/runtime/invariants.js";
import { registeredRootPath } from "../core/runtime/paths.js";
import { detected } from "../core/toolchains/languages.js";
import { reportLanguages } from "./language-output.js";
import { prompt } from "./terminal/project-prompt.js";

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

export async function setupProject(root: string, idInput?: string): Promise<void> {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`${root}: project root is not a directory`);
  const existing = existsSync(join(root, projectPaths.projects))
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
  if (!existsSync(join(root, projectPaths.charter)))
    console.log(
      `A human must write ${projectPaths.charter} before validation can pass. Use 'workbench serve' to write it in the browser.`,
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
  const registryPath = join(root, projectPaths.projects);
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
  console.log(
    `Registered ${new ProjectHierarchy(readProjects(root)).breadcrumb(registered)}${name ? ` (${id})` : ""} at ${path}.`,
  );
  const charter = join(root, path, projectPaths.charter);
  if (!existsSync(charter)) console.log(`${charter} is absent; a human must write it before checks can pass.`);
  reportLanguages(root, id);
}
