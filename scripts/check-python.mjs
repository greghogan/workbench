import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const role = process.argv[2];
if (role !== "build" && role !== "release") throw new Error("expected build or release");
const builds = process.env.WORKBENCH_BUILD_DIR;
if (!builds) throw new Error("use Workbench checks or a configured Workbench shell for Python builds");
// Build backends can write metadata beside sources. Give them a disposable source copy as well as an output path.
const stage = join(builds, "python-source");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const excluded = new Set([
  ".git",
  ".venv",
  "build",
  "dist",
  "coverage",
  "__pycache__",
  ".mypy_cache",
  ".ruff_cache",
  ".pytest_cache",
]);
const include = (path) => !excluded.has(basename(path)) && !basename(path).endsWith(".egg-info");
for (const entry of readdirSync("."))
  if (include(entry)) cpSync(entry, join(stage, entry), { recursive: true, filter: include });
const output = role === "release" ? resolve("dist") : join(builds, "python-dist");
const result = spawnSync("uv", ["build", stage, "--out-dir", output], { stdio: "inherit" });
if (result.error || result.status !== 0) throw new Error(`Python build failed: ${result.error ?? result.status}`);
