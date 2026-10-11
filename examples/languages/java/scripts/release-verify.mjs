import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
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
  const jar = join(temporary, "count.jar");
  cpSync(artifact(".jar"), jar);
  assert.equal(run("java", ["-jar", jar, "97", "banana"]).trim(), "3");
  assert.equal(run("java", ["-jar", jar, "97", ""]).trim(), "0");
  assert.notEqual(spawnSync("java", ["-jar", jar, "256", "banana"]).status, 0);

  console.log(`Verified release artifacts from ${root} outside the source checkout.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
