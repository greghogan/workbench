import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

/** Copy authored inputs and distributable bundles, excluding local/generated state. */
export function copySourceCheckout(root, destination) {
  mkdirSync(destination, { recursive: true });
  const generated = new Set([
    ".git",
    "node_modules",
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
  ]);
  for (const name of [
    "src",
    "tests",
    "scripts",
    "examples",
    "languages",
    "collections",
    "workbench",
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
    "eslint.config.mjs",
    "vitest.config.mjs",
    ".prettierrc.json",
    "AGENTS.md",
    "README.md",
    "channels.scm",
    "manifest.scm",
    ".envrc",
    ".node-version",
    ".tool-versions",
    ".gitignore",
    ".gitattributes",
  ]) {
    if (!existsSync(join(root, name))) continue;
    cpSync(join(root, name), join(destination, name), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) => {
        const name = basename(path);
        return (
          !generated.has(name) &&
          !name.startsWith(".coverage.") &&
          !/\.(?:egg-info|profraw|profdata|pyc|tsbuildinfo)$/.test(name)
        );
      },
    });
  }
}
