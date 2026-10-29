import { record, required, string } from "./values.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the installed interpreter directly, without development dependencies or runtime acquisition.
const unsupported = process.argv[2] === "--unsupported";
assert.deepEqual(process.argv.slice(2), unsupported ? ["--unsupported"] : []);
const distribution = fileURLToPath(new URL("..", import.meta.url));
const requirement = string(
  record(
    record(JSON.parse(readFileSync(join(distribution, "package.json"), "utf8")), "Invalid package metadata").engines,
    "Missing package engines",
  ).node,
  "Missing Node requirement",
);
const temporary = mkdtempSync(join(tmpdir(), "workbench-node-runtime-"));
try {
  const trace = join(temporary, "trace.jsonl"),
    preload = join(temporary, "trace.cjs");
  writeFileSync(
    preload,
    `require("node:fs").appendFileSync(${JSON.stringify(trace)},JSON.stringify({version:process.versions.node,entry:process.argv[1]})+"\\n");
require("node:net").Socket.prototype.connect = function () { throw new Error("startup attempted network access"); };
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
  for (const kind of ["CACHE", "CONFIG", "DATA", "STATE"])
    env[`WORKBENCH_${kind}_HOME`] = join(temporary, kind.toLowerCase());
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
  if (unsupported) {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(`Node.js ${requirement.slice(2)} or newer is required to bootstrap Workbench`));
    assert.equal(result.stdout, "");
  } else {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Usage: workbench/);
  }
  const launches = readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => record(JSON.parse(line), "Invalid launch trace"));
  assert.deepEqual(launches, [{ version: process.versions.node, entry }]);
  assert.equal(
    existsSync(required(env.WORKBENCH_CACHE_HOME, "Missing cache home")),
    false,
    "startup must not acquire a runtime",
  );
  console.log(
    unsupported
      ? `Workbench rejected unsupported Node ${process.versions.node} before loading commands.`
      : `Workbench ran directly on installed Node ${process.versions.node}.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
