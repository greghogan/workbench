import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { publicationTarget } from "./file-publication.mjs";

const generated = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".bundle",
  ".pnpm-store",
  "target",
  "build",
  "dist",
  "coverage",
  ".direnv",
  ".envrc.local",
  ".venv",
  ".venv.workbench-backup",
  "__pycache__",
  ".mypy_cache",
  ".ruff_cache",
  ".pytest_cache",
  ".coverage",
  "htmlcov",
  "local.toml",
  ".collections",
  ".local-collections",
  ".skill-links.json",
  ".skill-links.json.lock",
  ".skill-catalog.json",
]);
export const sourceCheckoutPaths = [
  "src",
  "tests",
  "scripts",
  "examples",
  "demo",
  "languages",
  "collections",
  "workbench",
  "docs",
  "skills",
  "bin",
  "bundle",
  ".githooks",
  ".github",
  ".devcontainer",
  "Makefile",
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  "tsconfig.json",
  "eslint.config.mts",
  "eslint.config.mjs",
  "vitest.config.mts",
  "vitest.config.mjs",
  ".prettierrc.json",
  "AGENTS.md",
  "README.md",
  "flake.nix",
  "flake.lock",
  ".dockerignore",
  "channels.scm",
  "manifest.scm",
  "browser.nix",
  "browser.scm",
  "check-inputs.nix",
  "check-inputs.scm",
  "managed-check-inputs.json",
  "managed-bootstrap.json",
  "managed-registry.json.br",
  ".envrc",
  ".node-version",
  ".tool-versions",
  ".gitignore",
  ".gitattributes",
];

export function sourceCheckoutPathIncluded(path: string): boolean {
  if (publicationTarget(path) !== undefined) return false;
  return path
    .replaceAll("\\", "/")
    .split("/")
    .every(
      (name) =>
        !generated.has(name) &&
        !name.startsWith(".coverage.") &&
        !/\.(?:egg-info|profraw|profdata|pyc|tsbuildinfo)$/.test(name),
    );
}

/** A prepared test workspace retains generated helpers; a clean-source rehearsal excludes them separately. */
export function copySourceCheckout(root: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  for (const name of sourceCheckoutPaths) {
    if (!existsSync(join(root, name))) continue;
    cpSync(join(root, name), join(destination, name), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) => sourceCheckoutPathIncluded(relative(root, path)),
    });
  }
}
