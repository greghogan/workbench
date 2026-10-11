import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
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
try {
  const packaged = join(artifacts, "workbench");
  cpSync(packaged, join(temporary, "workbench"), { recursive: true, verbatimSymlinks: true });
  const directory = join(temporary, "workbench");
  run(process.execPath, [join(directory, "bin/workbench.mjs"), "validate", directory], directory);

  console.log(`Verified release artifacts from ${root} outside the source checkout.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
