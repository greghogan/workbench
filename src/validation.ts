import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readConfig, readLanguageRoots, readProjects, rootOf, type Project } from "./core.js";
import { syncMaps } from "./maps.js";
import { syncReleaseIndexes } from "./releases.js";
import { syncAgents } from "./agents.js";
import { syncSkills } from "./skills.js";
import { distributionRoot } from "./core.js";
import { validateRecords, validateRelationships } from "./records.js";
import { readChecks } from "./checks.js";
import { ciMatrix } from "./ci.js";
import { selectedCompiler } from "./compilers.js";
import { validateCommitPolicy } from "./commit.js";
import { formattingErrors, recordPaths } from "./formatting.js";
import { documentationErrors } from "./documentation.js";
import { citationLibrarySetting } from "./citations.js";
import { syncRecordSequences } from "./record-sequences.js";
import { syncTaskChecklists } from "./task-checklists.js";
import { syncCollectionLinks } from "./collection-links.js";
import { decisionScopes } from "./decisions.js";

function collectMarkdown(directory: string, files: Set<string>): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || [".collections", ".local-collections"].includes(entry.name)) continue;
    if (entry.isDirectory()) collectMarkdown(path, files);
    else if (entry.isFile() && path.endsWith(".md")) files.add(path);
  }
}

export async function validate(root: string): Promise<void> {
  const errors: string[] = [];
  const files = new Set<string>();
  let width: number | undefined;
  try {
    width = readConfig(root).markdown?.wrap_width;
  } catch (error) {
    errors.push(String(error));
  }
  for (const action of [
    () => readChecks(root),
    () => {
      if (readConfig(root).ci !== undefined) ciMatrix(root);
    },
    () => validateCommitPolicy(root),
    () => citationLibrarySetting(root),
    () => readProjects(root),
    () => {
      for (const entry of readLanguageRoots(root)) selectedCompiler(join(root, entry.path));
    },
  ]) {
    try {
      action();
    } catch (error) {
      errors.push(String(error));
    }
  }
  for (const relative of ["AGENTS.md", "workbench/config.toml", "workbench/projects.toml", "workbench/CHARTER.md"]) {
    const path = join(root, relative);
    if (!existsSync(path) || !lstatSync(path).isFile()) errors.push(`${path}: required file is missing`);
    else if (path.endsWith(".md")) files.add(path);
  }
  const readme = join(root, "README.md");
  if (existsSync(readme)) files.add(readme);
  collectMarkdown(join(root, "workbench"), files);
  let projects: Project[];
  try {
    projects = readProjects(root);
  } catch (error) {
    errors.push(String(error));
    projects = [];
  }
  for (const project of projects) {
    const directory = rootOf(root, project);
    errors.push(...validateRecords(directory, project.id));
    if (project.path !== ".") {
      const charter = join(directory, "workbench/CHARTER.md");
      if (!existsSync(charter)) errors.push(`${charter}: required file is missing`);
      else files.add(charter);
      collectMarkdown(join(directory, "workbench"), files);
    }
  }
  if (projects.length) {
    try {
      errors.push(...validateRelationships(root));
    } catch (error) {
      errors.push(String(error));
    }
    for (const action of [
      () => syncCollectionLinks(root, true),
      () => syncRecordSequences(root, true),
      () => syncTaskChecklists(root, true),
      () => syncMaps(root, true),
      () => syncReleaseIndexes(root, true),
      () => syncAgents(root, true),
      () => syncSkills(root, distributionRoot(root), true),
    ]) {
      try {
        action();
      } catch (error) {
        errors.push(String(error));
      }
    }
  }
  if (width && projects.length) {
    try {
      errors.push(...(await formattingErrors(recordPaths(root), width)));
    } catch (error) {
      errors.push(String(error));
    }
  }
  try {
    for (const scope of decisionScopes(root))
      if (scope.source) {
        files.add(join(scope.directory, "workbench/decision-map.md"));
        for (const decision of scope.decisions) files.add(decision.path);
      }
    errors.push(...documentationErrors(root, [...files].sort()));
  } catch (error) {
    errors.push(String(error));
  }
  if (errors.length) {
    for (const error of errors) console.error(error);
    throw new Error(`Workbench validation failed (${String(errors.length)} issue(s)).`);
  }
  console.log(`Workbench validation passed (${String(files.size)} Markdown files).`);
}
