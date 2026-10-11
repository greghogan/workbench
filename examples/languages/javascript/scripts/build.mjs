import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const source = process.cwd();
const stage =
  process.env.WORKBENCH_STORAGE_EXTERNAL !== "false" && process.env.WORKBENCH_BUILD_DIR
    ? join(process.env.WORKBENCH_BUILD_DIR, "javascript")
    : source;
if (existsSync(stage) && lstatSync(stage).isSymbolicLink()) throw new Error("build staging must be a real directory");
mkdirSync(stage, { recursive: true });
if (stage !== source) {
  // Preserve Node's package boundary, self references, and dependency resolution outside the source tree.
  writeFileSync(join(stage, "package.json"), readFileSync("package.json"));
  const modules = join(stage, "node_modules");
  if (!existsSync(modules)) symlinkSync(join(source, "node_modules"), modules, "junction");
  if (!lstatSync(modules).isSymbolicLink() || realpathSync(modules) !== realpathSync("node_modules"))
    throw new Error("external JavaScript dependencies must link to this project's node_modules");
}
function run(command, args, cwd = source) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`JavaScript build failed: ${result.error ?? result.status}`);
}
// Remove stale emitted modules after source deletions; dependency links and caches remain intact.
rmSync(join(stage, "build"), { recursive: true, force: true });
cpSync(join(source, "src"), join(stage, "build/src"), { recursive: true });
if (process.argv[2] === "release") {
  for (const file of ["README.md", "LICENSE"])
    if (stage !== source && existsSync(file)) cpSync(file, join(stage, file));
  const output = resolve(process.env.WORKBENCH_RELEASE_OUTPUT ?? "dist");
  mkdirSync(output, { recursive: true });
  if (!process.env.npm_execpath) throw new Error("invoke release through the declared package manager");
  const pack = ["pack", "--pack-destination", output];
  if (/\.[cm]?js$/i.test(process.env.npm_execpath)) run(process.execPath, [process.env.npm_execpath, ...pack], stage);
  else run(process.env.npm_execpath, pack, stage);
}
