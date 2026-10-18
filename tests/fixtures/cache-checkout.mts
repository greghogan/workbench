import { cpSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

/** Cache planning needs real configuration and distributable planners, but no records or test bodies. */
export function cacheCheckout(repository: string, destination: string) {
  const products = new Set([
    ".git",
    "node_modules",
    "vendor",
    ".bundle",
    ".pnpm-store",
    "target",
    "build",
    "dist",
    "coverage",
    ".venv",
    ".direnv",
    ".envrc.local",
    "local.toml",
    ".collections",
    ".local-collections",
    "__pycache__",
  ]);
  for (const path of [
    "bin",
    "bundle",
    "scripts",
    "src",
    "languages",
    ".devcontainer",
    "package.json",
    "pnpm-lock.yaml",
    ".node-version",
    ".tool-versions",
    "flake.nix",
    "flake.lock",
    "channels.scm",
    "manifest.scm",
    "workbench/config.toml",
    "workbench/projects.toml",
    "workbench/automation.toml",
  ]) {
    const target = join(destination, path);
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(join(repository, path), target, { recursive: true, filter: (path) => !products.has(basename(path)) });
  }
  // Retain subproject manifests and pins, skipping authored code and products.
  cpSync(join(repository, "examples"), join(destination, "examples"), {
    recursive: true,
    filter: (path) => !products.has(basename(path)) && !["src", "tests", "lib", "scripts"].includes(basename(path)),
  });
}
