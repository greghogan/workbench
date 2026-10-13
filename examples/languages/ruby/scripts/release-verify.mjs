import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.argv[3] ?? process.cwd());
const artifacts = resolve(process.argv[2] ?? join(root, "dist"));
const temporary = mkdtempSync(join(tmpdir(), "workbench-release-check-"));
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
  const gemHome = join(temporary, "gems");
  const archive = artifact(".gem");
  run("ruby", [
    "-S",
    "gem",
    "install",
    "--local",
    archive,
    "--install-dir",
    gemHome,
    "--no-document",
    "--ignore-dependencies",
  ]);
  const library = join(gemHome, "gems", "workbench-ruby-reference-0.1.0", "lib");
  assert.equal(
    run("ruby", [
      "-I",
      library,
      "-rworkbench_ruby_reference",
      "-e",
      'abort unless WorkbenchRubyReference.sum([20,22]) == 42; print WorkbenchRubyReference.count_byte("banana",97)',
    ]).trim(),
    "3",
  );
  const executable = join(gemHome, "gems", "workbench-ruby-reference-0.1.0", "bin/count");
  assert.equal(run("ruby", ["-I", library, executable, "97", "banana"]).trim(), "3");
  assert.notEqual(spawnSync("ruby", ["-I", library, executable, "256", "banana"], { cwd: temporary }).status, 0);

  console.log(`Verified release artifacts from ${root} outside the source checkout.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
