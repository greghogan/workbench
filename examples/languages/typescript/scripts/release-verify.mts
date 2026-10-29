import { log } from "node:console";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.argv[3] ?? process.cwd());
const artifacts = resolve(process.argv[2] ?? process.env.WORKBENCH_DIST_DIR ?? join(root, "dist"));
const temporary = mkdtempSync(join(tmpdir(), "workbench-release-check-"));
function run(command: string, args: readonly string[], cwd = temporary) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(`Release artifact check failed: ${String(result.error ?? (result.stderr || result.status))}`);
  return result.stdout;
}
function artifact(extension: string) {
  const matches = readdirSync(artifacts).filter((name) => name.endsWith(extension));
  assert.equal(matches.length, 1, `expected one ${extension} artifact`);
  const [match] = matches;
  assert.ok(match, `missing ${extension} artifact`);
  return join(artifacts, match);
}
try {
  if (process.platform === "win32") assert.ok(process.env.SystemRoot, "Windows must provide SystemRoot");
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "", "System32", "tar.exe") : "tar";
  run(tar, ["-xzf", artifact(".tgz"), "-C", temporary]);
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string };
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

  log(`Verified release artifacts from ${root} outside the source checkout.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
