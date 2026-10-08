import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";

// A local runnable distribution, with source-owned policies, references and workflows.
const output = resolve("dist/workbench");
if (existsSync("dist") && lstatSync("dist").isSymbolicLink())
  throw new Error("dist must be a real directory; refusing to replace files through a symlink");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const generated = new Set([
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
]);
for (const source of [
  "bin",
  "bundle",
  "src",
  "tests",
  "workbench",
  "skills",
  ".githooks",
  ".gitattributes",
  ".github",
  ".devcontainer",
  "scripts",
  "examples",
  "Makefile",
  "LICENSE",
  "README.md",
  "AGENTS.md",
  ".node-version",
  ".tool-versions",
  ".envrc",
  ".gitignore",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "eslint.config.mjs",
  "vitest.config.mjs",
  ".prettierrc.json",
  "channels.scm",
  "manifest.scm",
]) {
  cpSync(source, join(output, source), {
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
// Regenerate both harnesses' links from the packaged sources, without copying personal harness state.
execFileSync(process.execPath, [join(output, "bin/workbench.mjs"), "sync"], { cwd: output, stdio: "inherit" });
console.log(`Prepared runnable Workbench distribution at ${output}`);
