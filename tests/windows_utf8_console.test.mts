import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test.skipIf(process.platform !== "win32")("private build consoles preserve Unicode output and failure status", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-console-"));
  try {
    const builds = join(root, "builds"),
      working = join(root, "work space 文"),
      child = join(root, "compiler space 文.mjs"),
      launcher = join(root, "launch.mjs");
    const args = ["", 'quote " character', "C:\\trailing space\\", "%!^&()<>|;", "文"];
    mkdirSync(builds);
    mkdirSync(working);
    writeFileSync(
      child,
      `import {spawnSync} from 'node:child_process';
import {captureOwnedChild} from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../scripts/owned-child.mjs")).href)};
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
assert.deepEqual(process.argv.slice(2),${JSON.stringify(args)});
assert.equal(realpathSync.native(process.cwd()),realpathSync.native(${JSON.stringify(working)}));
const page=spawnSync('cmd.exe',['/d','/c','chcp'],{encoding:'utf8'});
if(page.status!==0 || !page.stdout.includes('65001')) throw new Error('Build console is not UTF-8');
const nested=await captureOwnedChild('cmd.exe',['/d','/c','chcp'],{cwd:process.cwd(),env:process.env,signal:new AbortController().signal},65536);
if(nested.status!==0 || !nested.stdout.includes('65001')) throw new Error('Captured worker lost the UTF-8 console: '+nested.stdout+nested.stderr);
console.log('dependency 文'); console.error('diagnostic 文'); process.exitCode=23;
`,
    );
    writeFileSync(
      launcher,
      `import {runWindowsUtf8Console} from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../scripts/windows-utf8-console.mjs")).href)};
await runWindowsUtf8Console(${JSON.stringify([child, ...args])},${JSON.stringify(builds)},${JSON.stringify(working)});
`,
    );
    const result = spawnSync(process.execPath, [launcher], { encoding: "utf8", windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout, result.stderr).toContain("dependency 文");
    expect(result.stderr).toContain("diagnostic 文");
    expect(result.stderr).toContain("status=23");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
