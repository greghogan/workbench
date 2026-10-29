import { projectName } from "./project-hierarchy.js";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { planProject, configureGitHooks, preflightGitHooks } from "./projects.js";
import { defaultId } from "./project-identity.js";
import { ProjectEdits } from "./project-edits.js";
import { planLanguage, detected } from "./languages.js";
import { distributionRoot } from "./project-context.js";
import { readProjects, projectsFromData } from "./project-configuration.js";
import { readText } from "./files.js";
import { synchronize } from "./sync.js";
import type { CommitStyle } from "./config-schema.js";
import { registerConsumingProject } from "./project-registration.js";

export interface InitOptions {
  id?: string;
  name?: string;
  language?: string;
  root?: string;
  adopt?: boolean;
  recordsOnly?: boolean;
  hooks?: boolean;
  commitStyle?: CommitStyle;
  check?: string[];
  plan?: boolean;
}

/** The preview and application share the same validated file plan; initialization never runs project commands. */
export function initializeProject(requested: string, options: InitOptions): void {
  const root = resolve(requested);
  const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (gitAvailable.status !== 0) throw new Error("Git is required; install Git before initializing Workbench");
  if (existsSync(root) && (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()))
    throw new Error(`${root}: select a real project directory`);
  if (options.recordsOnly && (options.language || options.adopt || options.check?.length))
    throw new Error("--records-only cannot be combined with application initialization or checks");
  if (options.root && options.root !== "." && !options.language) throw new Error("--root requires --language");
  if (!options.language && !options.adopt && !options.recordsOnly)
    throw new Error(
      "select --language LANGUAGE, --adopt for existing code, or --records-only; run 'workbench language' for all supported starters",
    );
  const registryPath = join(root, "workbench/projects.toml");
  const id = options.id ?? (existsSync(registryPath) ? readProjects(root)[0]?.id : undefined) ?? defaultId(root);
  const edits = new ProjectEdits(root);
  planProject(edits, id, {
    ...(options.name === undefined ? {} : { name: options.name }),
    detect: options.adopt === true && !options.language,
    ...(options.commitStyle === undefined ? {} : { commitStyle: options.commitStyle }),
    ...(options.recordsOnly ? { recordsOnly: true } : {}),
  });
  for (const path of ["AGENTS.md", ".gitignore", ".gitattributes", "workbench/CHARTER.md"]) edits.read(path); // Reject filesystem conflicts before publishing any files.
  const projects = projectsFromData(parse(edits.read("workbench/projects.toml") ?? ""), registryPath);
  for (const project of projects) {
    const prefix = project.path === "." ? "" : `${project.path}/`;
    for (const name of [
      "decision-map.md",
      "task-map.md",
      "experiment-map.md",
      "environment-map.md",
      "citation-map.md",
      "release-map.md",
      "record-sequences.toml",
      "release-index.tsv",
    ])
      edits.read(`${prefix}workbench/${name}`);
  }
  let language = options.language;
  if (!language && options.adopt && options.check?.length) {
    const candidates = detected(root, ".");
    if (candidates.length !== 1)
      throw new Error("select --language LANGUAGE to associate --check with an existing root");
    language = candidates[0]?.[0];
  }
  if (language)
    planLanguage(edits, language, options.root ?? ".", {
      adopt: options.adopt === true,
      id,
      ...(options.check === undefined ? {} : { check: options.check }),
    });
  const distribution = distributionRoot(root);
  const hasGit = existsSync(join(root, ".git"));
  if (hasGit) {
    const repository = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (repository.status !== 0 || realpathSync.native(repository.stdout.trim()) !== realpathSync.native(root))
      throw new Error("select the project's Git repository root; use --root for an application subdirectory");
  }
  if (hasGit && options.hooks) preflightGitHooks(root, distribution);
  if (!hasGit && options.adopt)
    throw new Error(
      "existing-project adoption requires its Git repository root; run 'git init' first if this project is not yet versioned",
    );
  if (!hasGit && options.hooks) {
    for (const name of ["pre-commit", "pre-push", "commit-msg"]) {
      const target = edits.read(`.githooks/${name}`);
      if (target !== undefined && target !== readText(join(distribution, ".githooks", name)))
        throw new Error(`.githooks/${name} already exists; retain your hooks by omitting --hooks`);
    }
  }
  console.log(
    `Initialization ${options.plan ? "plan" : "for"} ${projects[0] ? projectName(projects[0]) : id} at ${root}`,
  );
  console.log(`Git hooks: ${options.hooks ? "enable Workbench gates" : "retain existing selection"}`);
  const config = parse(edits.read("workbench/config.toml") ?? "");
  console.log(`Commit messages: ${(config.commit as { style?: string } | undefined)?.style ?? "unrestricted"}`);
  for (const file of edits.files.values())
    console.log(`${file.previous === undefined ? "Create" : "Update"} ${file.path}`);
  console.log("Refresh record maps, sequences and selected agent context after initialization.");
  if (!hasGit) console.log("Create a local Git repository (no remote or commit).");
  if (options.plan) return;
  mkdirSync(root, { recursive: true });
  if (!hasGit) {
    const git = spawnSync("git", ["-C", root, "init", "--quiet"], { encoding: "utf8" });
    if (git.status !== 0) throw new Error(`cannot initialize Git: ${git.stderr.trim()}`);
  }
  edits.apply();
  synchronize(root);
  registerConsumingProject(root);
  if (options.hooks) configureGitHooks(root, distribution);
  console.log("Initialization complete. Nothing has been staged or committed.");
  if (!existsSync(join(root, "workbench/CHARTER.md")))
    console.log("Next: write workbench/CHARTER.md yourself, or run 'workbench serve' and choose Create charter.");
  if (language && !options.adopt) console.log(`Next: workbench tools install --path ${options.root ?? "."}`);
  if (options.adopt && !options.check?.length)
    console.log(
      "Application checks remain unchanged. Connect them with --check COMMAND, or edit workbench/automation.toml; see docs/adoption.md.",
    );
  console.log("Then: workbench check --list, workbench sync, and workbench validate.");
}
