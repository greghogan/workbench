import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercise shipped artifacts outside the checkout, with no source-tree imports.
const root = process.cwd();
const artifacts = join(root, "dist");
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
  if (existsSync(join(root, "bin/workbench.mjs"))) {
    const packaged = join(artifacts, "workbench");
    cpSync(packaged, join(temporary, "workbench"), { recursive: true, verbatimSymlinks: true });
    const directory = join(temporary, "workbench");
    run(process.execPath, [join(directory, "bin/workbench.mjs"), "validate", directory], directory);
  } else if (existsSync(join(root, "package.json"))) {
    run("tar", ["-xzf", artifact(".tgz"), "-C", temporary]);
    const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict';
         const { sum, countByte } = await import(${JSON.stringify(metadata.name)});
         assert.equal(sum([20, 22]), 42);
         assert.equal(countByte(new TextEncoder().encode('banana'), 97), 3);
         assert.throws(() => countByte(new Uint8Array(), 256), RangeError);`,
      ],
      join(temporary, "package"),
    );
  } else if (existsSync(join(root, "pyproject.toml"))) {
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
  } else {
    const rust = existsSync(join(root, "Cargo.toml"));
    const executable = join(temporary, `${rust ? "rust-reference" : "count"}${suffix}`);
    cpSync(join(artifacts, `${rust ? "rust-reference" : "count"}${suffix}`), executable);
    assert.equal(run(executable, rust ? ["20", "22"] : ["a", "banana"]).trim(), rust ? "42" : "3");
  }
  console.log(`Verified release artifacts from ${resolve(root)} outside the source checkout.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
