import { validateCommitPolicy } from "./commit.js";
import { terminalTable } from "./terminal-table.js";
import { quote } from "./toolchains.js";
import { projectName } from "./project-hierarchy.js";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { planProject, configureGitHooks, preflightGitHooks, gitHookNames } from "./projects.js";
import { defaultId } from "./project-identity.js";
import { ProjectEdits } from "./project-edits.js";
import { planLanguage, detected } from "./languages.js";
import { distributionRoot } from "./project-context.js";
import { readProjects, readLanguageRoots, readConfig, projectsFromData } from "./project-configuration.js";
import { readText } from "./files.js";
import { synchronize } from "./sync.js";
import type { CommitStyle } from "./config-schema.js";
import { registerConsumingProject } from "./project-registration.js";
import { reconcileCollection } from "./collection-reconcile.js";
import { initialCollectionSource, acceptCollectionAdoption } from "./initial-collection.js";

export interface InitOptions {
  workbenchCollection?: boolean;
  yes?: boolean;
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
export async function initializeProject(requested: string, options: InitOptions): Promise<void> {
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
  const adoptCollection = options.workbenchCollection ?? !existsSync(registryPath);
  const id = options.id ?? (existsSync(registryPath) ? readProjects(root)[0]?.id : undefined) ?? defaultId(root);
  const edits = new ProjectEdits(root);
  planProject(edits, id, {
    ...(options.name === undefined ? {} : { name: options.name }),
    detect: options.adopt === true && !options.language,
    ...(options.commitStyle === undefined ? {} : { commitStyle: options.commitStyle }),
    ...(options.recordsOnly ? { recordsOnly: true } : {}),
  });
  for (const path of ["AGENTS.md", ".gitignore", ".gitattributes", "workbench/CHARTER.md"]) edits.read(path); // Reject filesystem conflicts before publishing any files.
  if (edits.read("workbench/CHARTER.md") === undefined) edits.create("workbench/CHARTER.md", "");
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
  const collectionExists =
    existsSync(join(root, "workbench/config.toml")) &&
    readConfig(root).collections?.sources?.some((pin) => pin.id === "workbench");
  if (adoptCollection && !collectionExists && projects.some((project) => project.id === "workbench"))
    throw new Error(
      "The initial collection uses namespace 'workbench'; choose another --id or use --no-workbench-collection.",
    );
  const collection = adoptCollection && !collectionExists ? initialCollectionSource(distribution) : undefined;
  const hasGit = existsSync(join(root, ".git"));
  if (hasGit) {
    const repository = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (repository.status !== 0 || realpathSync.native(repository.stdout.trim()) !== realpathSync.native(root))
      throw new Error("select the project's Git repository root; use --root for an application subdirectory");
  }
  if (hasGit && options.hooks) preflightGitHooks(root, distribution);
  if (!hasGit && options.hooks) {
    for (const name of gitHookNames) {
      const target = edits.read(`.githooks/${name}`);
      if (target !== undefined && target !== readText(join(distribution, ".githooks", name)))
        throw new Error(`.githooks/${name} already exists; retain your hooks by omitting --hooks`);
    }
  }
  const name = projects[0] ? projectName(projects[0]) : id;
  if (options.plan) {
    console.log(`Initialization plan for ${name}\n${root}\n`);
    for (const file of edits.files.values())
      console.log(`  ${file.previous === undefined ? "Create" : "Update"} ${file.path}`);
    if (collection) console.log(`  Adopt Workbench ADR collection at ${collection.commit}`);
    console.log("  Refresh record maps and agent context");
    if (!hasGit) console.log("  Initialize Git");
    if (options.hooks) console.log("  Enable Workbench Git gates");
    return;
  }
  mkdirSync(root, { recursive: true });
  if (!hasGit) {
    const git = spawnSync("git", ["-C", root, "init", "--quiet"], { encoding: "utf8" });
    if (git.status !== 0) throw new Error(`cannot initialize Git: ${git.stderr.trim()}`);
  }
  edits.apply();
  if (collection) {
    let adopted;
    try {
      adopted = reconcileCollection(root, collection.source, {
        commit: collection.commit,
        ...(collection.fetchFrom ? { fetchFrom: collection.fetchFrom } : {}),
        id: "workbench",
        visibility: "public",
      });
    } catch (error) {
      throw new Error(
        "Project scaffold retained, but initial collection adoption failed. Correct the cause and rerun workbench init --workbench-collection.",
        { cause: error },
      );
    }
    if (options.yes) acceptCollectionAdoption(root, adopted);
  }
  synchronize(root, true, () => undefined);
  await registerConsumingProject(root);
  if (options.hooks) configureGitHooks(root, distribution, () => undefined);
  console.log(`Initialized ${name}\n`);
  const roots = readLanguageRoots(root);
  const checks = readConfig(root);
  console.log(
    terminalTable(
      ["Setting", "Value"],
      [
        ["Directory", root],
        ["Languages", [...new Set(roots.map((entry) => entry.language))].join(", ") || "Not selected"],
        [
          "Workbench ADR collection",
          collection
            ? options.yes
              ? "Adopted and accepted"
              : "Adopted; acceptance pending"
            : collectionExists
              ? "Existing selection preserved"
              : "Not selected",
        ],
        [
          "Checks",
          options.recordsOnly
            ? "Workbench documents only"
            : (checks.check?.length ?? 0) + (checks.check_suite?.length ?? 0)
              ? "Application checks configured"
              : "Application checks not configured",
        ],
        ["Git hooks", options.hooks ? "Workbench gates enabled" : "Existing selection preserved"],
        ["Commit messages", validateCommitPolicy(root).style],
      ],
    ),
  );
  const next: string[] = [];
  if (!readText(join(root, "workbench/CHARTER.md")).trim())
    next.push("Write workbench/CHARTER.md, or open workbench serve to edit it.");
  if (collection) {
    if (!options.yes)
      next.push(
        "Accept the collection with workbench collection accept workbench --yes, or review its records individually.",
      );
    next.push("Before committing, stage the collection reference: workbench collection stage workbench.");
  }
  if (language && !options.adopt)
    next.push(`Install language tools: workbench tools install --path ${quote(options.root ?? ".")}`);
  if (options.adopt && !options.check?.length && !(checks.check?.length || checks.check_suite?.length))
    next.push("Connect your application checks; see docs/adoption.md.");
  next.push(
    options.recordsOnly ? "Run workbench validate." : "Inspect workbench check --list, then run workbench check.",
  );
  console.log("\nNext steps");
  next.forEach((step, index) => {
    console.log(`  ${String(index + 1)}. ${step}`);
  });
}
