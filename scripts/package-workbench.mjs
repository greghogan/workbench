import { cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { packageOutput } from "./package-output.mjs";

// A local runnable distribution, with source-owned policies, references and workflows.
const destination = resolve(process.env.WORKBENCH_RELEASE_OUTPUT ?? "dist", "workbench");
// Installed private standards require an explicit audience decision before exporting project context.
execFileSync(process.execPath, ["bin/workbench.mjs", "collection", "check-export"], { stdio: "inherit" });
packageOutput(process.cwd(), destination, (output) => {
  const generated = new Set([
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
    ".installation.json",
    "workbench-distribution.json",
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
    "languages",
    "collections",
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
    ".pnpmfile.cjs",
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
  execFileSync(process.execPath, ["bin/workbench.mjs", "collection", "bundle", join(output, "collections")], {
    stdio: "inherit",
  });
  execFileSync(process.execPath, [join(output, "bin/workbench.mjs"), "sync"], {
    cwd: output,
    stdio: "inherit",
    env: { ...process.env, WORKBENCH_PROJECT_ROOT: output },
  });
  const revision =
    process.env.WORKBENCH_SOURCE_REVISION ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync(process.execPath, ["bin/workbench.mjs", "installation", "seal", output, "--revision", revision], {
    stdio: "inherit",
  });
});
console.log(`Prepared runnable Workbench distribution at ${destination}`);
