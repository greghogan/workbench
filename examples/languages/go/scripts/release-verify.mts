import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.argv[3] ?? process.cwd());
const artifacts = resolve(process.argv[2] ?? process.env.WORKBENCH_DIST_DIR ?? join(root, "dist"));
const temporary = mkdtempSync(join(tmpdir(), "workbench-release-check-"));
const suffix = process.platform === "win32" ? ".exe" : "";
function run(command: string, args: readonly string[], cwd = temporary) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(`Release artifact check failed: ${String(result.error ?? (result.stderr || result.status))}`);
  return result.stdout;
}
try {
  const executable = join(temporary, `count${suffix}`);
  cpSync(join(artifacts, `count${suffix}`), executable);
  assert.equal(run(executable, ["a", "banana"]).trim(), "3", "Standalone release result");

  console.log(`Verified release artifacts from ${root} outside the source checkout.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
