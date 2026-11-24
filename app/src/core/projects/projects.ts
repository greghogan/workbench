import { workspaceSchemaVersion } from "./project-model.js";
import { projectPaths } from "./project-paths.js";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse } from "smol-toml";
import { citationLibrarySetting } from "../citations/citations.js";
import { projectNameField, type CommitStyle } from "../configuration/config-schema.js";
import { editToml } from "../configuration/toml-edit.js";
import { executingToolPin } from "../distribution/launcher-identity.js";
import { writeAtomic, writeNew } from "../runtime/file-publication.mjs";
import { readText } from "../runtime/files.js";
import { required } from "../runtime/invariants.js";
import { ownedPath } from "../runtime/paths.js";
import { detected } from "../toolchains/languages.js";
import { readConfig, readProjects } from "./project-configuration.js";
import { distributionRoot } from "./project-context.js";
import { ProjectEdits } from "./project-edits.js";
import { projectIdPattern as validId } from "./project-identity.js";

export function planProject(
  edits: ProjectEdits,
  id: string,
  options: { name?: string; commitStyle?: CommitStyle; detect?: boolean; recordsOnly?: boolean } = {},
): void {
  const root = edits.root;
  if (!validId.test(id)) throw new Error(`invalid root project ID: ${id}`);
  if (options.name !== undefined) projectNameField(options.name, "project.name");
  const projectsPath = projectPaths.projects;
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
  const configPath = projectPaths.config;
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
  if (!options.recordsOnly && edits.read("Makefile") === undefined)
    edits.create("Makefile", readText(join(distributionRoot(root), "Makefile")));
  const ignore = edits.read(".gitignore") ?? "";
  if (!ignore.split(/\r?\n/).includes(".workbench-cache-operations/"))
    edits.write(
      ".gitignore",
      ignore + (ignore && !ignore.endsWith("\n") ? "\n" : "") + ".workbench-cache-operations/\n",
    );
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
