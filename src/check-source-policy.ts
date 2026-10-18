import { existsSync } from "node:fs";
import { join } from "node:path";
import { detail, kinds, readConfig, readLanguageRoots, readProjects } from "./core.js";

/** Records are validated independently; tests own their fixtures instead of borrowing project policy. */
export function checkSourcePolicy(root: string) {
  const registered = existsSync(join(root, "workbench/projects.toml"));
  const scopes = registered ? readProjects(root).map((project) => project.path) : ["."];
  const roots = new Set([...scopes, ...(registered ? readLanguageRoots(root).map((entry) => entry.path) : [])]);
  const prefix = (scope: string, path: string) => (scope === "." ? path : `${scope}/${path}`);
  const files = new Set<string>();
  const directories: string[] = [];
  for (const scope of scopes) {
    for (const file of [
      "AGENTS.md",
      "workbench/CHARTER.md",
      "workbench/source-map.md",
      "workbench/release-index.tsv",
      "workbench/record-sequences.toml",
    ])
      files.add(prefix(scope, file));
    for (const kind of kinds) {
      files.add(prefix(scope, `workbench/${detail(kind).map}`));
      directories.push(prefix(scope, `workbench/${detail(kind).directory}`));
    }
    directories.push(prefix(scope, "workbench/source-maps"), prefix(scope, "workbench/collections"));
  }
  for (const scope of roots) files.add(prefix(scope, "coverage/coverage-summary.json"));
  const inputs = existsSync(join(root, "workbench/config.toml")) ? (readConfig(root).checks?.inputs ?? []) : [];
  return {
    inputs,
    includes: (path: string) =>
      inputs.some((input) => path === input || path.startsWith(`${input}/`) || input.startsWith(`${path}/`)) ||
      (!files.has(path) && !directories.some((directory) => path === directory || path.startsWith(`${directory}/`))),
  };
}
