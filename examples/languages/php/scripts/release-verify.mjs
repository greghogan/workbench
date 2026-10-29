// Generated from release-verify.mts; edit the TypeScript source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(process.argv[3] ?? process.cwd());
const artifacts = resolve(process.argv[2] ?? process.env.WORKBENCH_DIST_DIR ?? join(root, "dist"));
const temporary = mkdtempSync(join(tmpdir(), "workbench-release-check-"));
function run(command, args, cwd = temporary) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(`Release artifact check failed: ${String(result.error ?? (result.stderr || result.status))}`);
  return result.stdout;
}
function artifact(extension) {
  const matches = readdirSync(artifacts).filter((name) => name.endsWith(extension));
  assert.equal(matches.length, 1, `expected one ${extension} artifact`);
  const [match] = matches;
  assert.ok(match, `missing ${extension} artifact`);
  return join(artifacts, match);
}
try {
  run("php", ["-r", "$zip = new PharData($argv[1]); $zip->extractTo($argv[2]);", artifact(".zip"), temporary]);
  const library = join(temporary, "src/Arithmetic.php");
  assert.equal(
    run("php", [
      "-r",
      "require $argv[1]; if (WorkbenchReference\\Arithmetic::sum([20,22]) !== 42) exit(1); echo WorkbenchReference\\Arithmetic::countByte('banana',97);",
      library,
    ]).trim(),
    "3",
  );
  assert.equal(run("php", [join(temporary, "bin/count"), "97", "banana"]).trim(), "3");
  assert.notEqual(spawnSync("php", [join(temporary, "bin/count"), "256", "banana"], { cwd: temporary }).status, 0);
  console.log(`Verified release artifacts from ${root} outside the source checkout.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
