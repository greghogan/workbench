import { record, required } from "./values.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Run with the bootstrap Node under test; the real CLI must hand off before loading its command framework.
const distribution = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "workbench-bootstrap-probe-"));
try {
  const trace = join(temporary, "trace.jsonl"),
    preload = join(temporary, "trace.cjs");
  writeFileSync(
    preload,
    `require("node:fs").appendFileSync(${JSON.stringify(trace)},JSON.stringify({version:process.versions.node,entry:process.argv[1]})+"\\n");`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
  for (const name of [
    "GUIX_ENVIRONMENT",
    "IN_NIX_SHELL",
    "WORKBENCH_SHELL_ENVIRONMENT",
    "WORKBENCH_PREPARED",
    "WORKBENCH_DEVCONTAINER",
    "WORKBENCH_COMPATIBILITY_RUNTIME",
    "WORKBENCH_EXECUTING_SPEC",
    "WORKBENCH_PROJECT_ROOT",
  ])
    Reflect.deleteProperty(env, name);
  const entry = join(distribution, "bin/workbench.mjs");
  const result = spawnSync(process.execPath, [entry, "--help"], { cwd: temporary, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Usage: workbench/);
  const launches = readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => record(JSON.parse(line), "Invalid launch trace"))
    .filter(({ entry: path }) => path === entry);
  assert.equal(required(launches[0], "Missing bootstrap launch").version, process.versions.node);
  const pinned = readFileSync(join(distribution, ".node-version"), "utf8").trim();
  assert.equal(required(launches.at(-1), "Missing final launch").version, pinned);
  if (process.versions.node !== pinned)
    assert.ok(launches.length >= 2, "bootstrap must hand off to the pinned runtime");
  console.log(`Bootstrap Node ${process.versions.node} successfully launched Workbench on Node ${pinned}.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
