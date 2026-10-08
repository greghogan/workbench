import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const roots = JSON.parse(process.env.CHECK_ROOTS ?? "[]");
if (!Array.isArray(roots) || !roots.length || roots.some((root) => typeof root !== "string" || !root))
  throw new Error("CHECK_ROOTS must list configured roots");
const workspace = process.cwd();
const mode = process.argv[2];
function run(command, args, cwd = workspace, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.status}`);
}
const cli = (...args) => run(process.execPath, [join(workspace, "bin/workbench.mjs"), ...args]);
let failed = false;
const successful = [];
for (const [index, root] of roots.entries()) {
  console.log(`::group::${mode}: ${root}`);
  try {
    if (mode === "native") {
      cli("tools", "install", "--path", root);
      cli("checks", "run", "--stage", "ci", "--path", root, "--environment", "native");
    } else if (mode === "release") {
      cli("checks", "run", "--role", "release", "--path", root, "--environment", "native");
      cli("native-exec", root, "--", "node", join(workspace, "scripts/check-release.mjs"));
      const artifacts = join(process.env.RUNNER_TEMP, "release-artifacts");
      mkdirSync(artifacts, { recursive: true });
      run("tar", ["-czf", join(artifacts, `${index}.tar.gz`), "-C", join(workspace, root, "dist"), "."]);
      writeFileSync(join(artifacts, `${index}.txt`), `${root}\n`);
    } else if (mode === "environment") {
      cli("checks", "run", "--stage", "ci", "--path", root, "--environment", process.env.CHECK_ENVIRONMENT);
    } else if (mode === "compiler" || mode === "compiler-install") {
      const selection = ["--compiler", process.env.COMPILER, "--compiler-version", process.env.COMPILER_VERSION];
      if (mode === "compiler-install") cli("tools", "install", "--path", root, ...selection);
      else
        for (const role of ["test", "sanitizers"])
          cli("checks", "run", "--role", role, "--path", root, "--environment", "native", ...selection);
    } else if (mode === "node") {
      const directory = resolve(root);
      const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      const manager = ["exec", "--yes", `--package=${metadata.packageManager}`, "--", "pnpm"];
      run(
        "npm",
        [
          ...manager,
          "install",
          "--frozen-lockfile",
          "--store-dir",
          join(process.env.WORKBENCH_CACHE_HOME, "downloads/pnpm"),
        ],
        directory,
      );
      run(process.execPath, ["--version"], directory);
      run("npm", [...manager, "run", "test"], directory);
    } else throw new Error(`unknown CI mode: ${mode}`);
    successful.push(root);
  } catch (error) {
    failed = true;
    console.error(`::error::${root}: ${error.message}`);
  } finally {
    console.log("::endgroup::");
  }
}
if (mode === "native" && process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `roots=${JSON.stringify(successful)}\n`);
if (failed) process.exitCode = 1;
