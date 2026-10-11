import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.argv[3] ?? process.cwd());
const artifacts = resolve(process.argv[2] ?? join(root, "dist"));
const temporary = mkdtempSync(join(tmpdir(), "workbench-release-check-"));
const suffix = process.platform === "win32" ? ".exe" : "";
function run(command, args, cwd = temporary) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(`Release artifact check failed: ${result.error ?? result.stderr ?? result.status}`);
  return result.stdout;
}
function artifact(extension) {
  const matches = readdirSync(artifacts).filter((name) => name.endsWith(extension));
  assert.equal(matches.length, 1, `expected one ${extension} artifact`);
  return join(artifacts, matches[0]);
}
try {
  artifact(".tar.gz");
  const environment = join(temporary, "venv");
  assert.ok(process.env.WORKBENCH_PYTHON, "use the selected native Python environment");
  run("uv", ["--no-config", "venv", "--python", process.env.WORKBENCH_PYTHON, environment]);
  const python = join(environment, process.platform === "win32" ? "Scripts" : "bin", `python${suffix}`);
  run("uv", ["--no-config", "pip", "install", "--python", python, "--no-index", "--no-deps", artifact(".whl")]);
  run(python, [
    "-I",
    "-c",
    "from workbench_python_reference.arithmetic import add, count_byte; assert add(20, 22) == 42; assert count_byte(b'banana', 97) == 3",
  ]);

  console.log(`Verified release artifacts from ${root} outside the source checkout.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
