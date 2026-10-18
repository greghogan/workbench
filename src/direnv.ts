import { existsSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import type { BuildPaths } from "./builds.js";
import { readLanguageRoots, readText, writeAtomic, writeNew } from "./core.js";
import { ownedPath } from "./paths.js";
import { userConfigPath } from "./user-config.js";

const start = "# >>> Workbench direnv >>>";
const end = "# <<< Workbench direnv <<<";
const block = [
  start,
  "_workbench_exports=$(workbench paths --direnv) || exit",
  'eval "$_workbench_exports"',
  "unset _workbench_exports",
  end,
].join("\n");
const managed = /^# >>> Workbench direnv >>>\r?\n[\s\S]*?^# <<< Workbench direnv <<<\r?$/m;
const localSource =
  /^(?:source_env_if_exists|source_env|source|\.)[ \t]+(?:\.envrc\.local|'\.envrc\.local'|"\.envrc\.local")[ \t]*(?:#.*)?\r?$/m;

function readRegular(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  if (!lstatSync(path).isFile()) throw new Error(`${path}: expected a regular file`);
  return readText(path);
}

function integrated(contents: string | undefined, path: string): string {
  if (contents === undefined) return `${block}\n\nwatch_file .envrc.local\nsource_env_if_exists .envrc.local\n`;
  if (contents.includes(start) || contents.includes(end)) {
    if (contents.split(start).length !== 2 || contents.split(end).length !== 2 || !managed.test(contents))
      throw new Error(`${path}: repair the incomplete or duplicate Workbench direnv block before setup`);
    return contents.replace(managed, () => block);
  }
  const local = localSource.exec(contents);
  if (local) return `${contents.slice(0, local.index)}${block}\n\n${contents.slice(local.index)}`;
  if (contents.split(/\r?\n/).some((line) => !line.trimStart().startsWith("#") && line.includes(".envrc.local")))
    throw new Error(`${path}: use a separate 'source_env_if_exists .envrc.local' line before integrating direnv`);
  return `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}\n${block}\n\nwatch_file .envrc.local\nsource_env_if_exists .envrc.local\n`;
}

/** Plan every edit before writing, preserving shell code outside Workbench's marked block. */
export function configureDirenv(root: string): void {
  const directories = [...new Set([".", ...readLanguageRoots(root).map((entry) => entry.path)])];
  const changes: { path: string; original: string | undefined; contents: string; mode?: number }[] = [];
  for (const directory of directories) {
    const path = ownedPath(root, join(directory, ".envrc").split("\\").join("/"));
    const original = readRegular(path);
    changes.push({ path, original, contents: integrated(original, path) });
    const local = ownedPath(root, join(directory, ".envrc.local").split("\\").join("/"));
    if (readRegular(local) === undefined)
      changes.push({
        path: local,
        original: undefined,
        contents: "# Optional personal environment settings for this build root.\n",
        mode: 0o600,
      });
  }
  const ignore = ownedPath(root, ".gitignore");
  const original = readRegular(ignore);
  const missing = [".direnv/", ".envrc.local"].filter((rule) => !(original ?? "").split(/\r?\n/).includes(rule));
  if (missing.length)
    changes.push({
      path: ignore,
      original,
      contents: `${original ?? ""}${original && !original.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
    });
  for (const change of changes) {
    if (change.original === change.contents) continue;
    if (change.original === undefined) writeNew(change.path, change.contents, change.mode);
    else writeAtomic(change.path, change.contents, lstatSync(change.path).mode & 0o777);
    console.log(`Configured ${relative(root, change.path)}.`);
  }
  console.log("Direnv hooks are ready; review each .envrc and activate it with 'direnv allow' in that root.");
}

/** Watch the same tool inputs used for build identity, including absent files and personal configuration. */
export function direnvWatchPaths(root: string, paths: BuildPaths): string[] {
  const owner = process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root;
  return [
    ...new Set([
      userConfigPath(),
      join(root, "workbench/config.toml"),
      join(root, "workbench/projects.toml"),
      join(owner, "workbench/local.toml"),
      join(paths.projectDirectory, ".envrc.local"),
      ...paths.inputs,
    ]),
  ];
}
