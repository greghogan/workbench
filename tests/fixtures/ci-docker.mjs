#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const mode = process.env.FIXTURE_BEHAVIOR;
const operation = args[0];
const fail = (message) => {
  console.error(message);
  process.exit(2);
};
if (operation === "build") {
  if (mode === "build-failure") fail("fixture image failed");
  const policy = JSON.parse(readFileSync(join(args.at(-1), "bootstrap.json"), "utf8"));
  if (!policy.sha256 || !policy.checksums.signature.keys) fail("missing bootstrap verification policy");
} else if (operation === "image") {
  console.log(JSON.stringify({ Os: "linux", Architecture: mode === "wrong-architecture" ? "arm64" : "amd64" }));
} else if (operation === "run") {
  if (mode === "container-failure") fail("fixture container failed");
  if (
    !args.includes("--cap-drop=ALL") ||
    !args.includes("--security-opt=no-new-privileges") ||
    args.includes("--platform")
  )
    fail("guest isolation contract failed");
  const mounts = new Map();
  const env = { ...process.env };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mount") {
      const fields = Object.fromEntries(args[++i].split(",").map((part) => part.split("=")));
      mounts.set(fields.dst, fields.src);
    } else if (args[i] === "--env") {
      const value = args[++i];
      const at = value.indexOf("=");
      env[value.slice(0, at)] = value.slice(at + 1);
    }
  }
  const workspace = mounts.get("/workspace");
  const reports = mounts.get("/reports");
  if (!workspace || !reports || !existsSync(join(workspace, "draft"))) fail("missing snapshot mounts");
  if (readFileSync(join(workspace, "draft"), "utf8") !== "pending input") fail("snapshot lost pending inputs");
  for (const [name, value] of Object.entries(env)) {
    if (value.startsWith("/workspace")) env[name] = workspace + value.slice("/workspace".length);
    if (value.startsWith("/reports")) env[name] = reports + value.slice("/reports".length);
  }
  if (
    env.CARGO_HOME !== join(env.WORKBENCH_CACHE_HOME, "ci/cargo") ||
    env.UV_PYTHON_INSTALL_DIR !== join(env.WORKBENCH_CACHE_HOME, "uv-python/python")
  )
    fail("guest cache isolation failed");
  writeFileSync(process.env.FIXTURE_REPORTS, reports);
  if (mode === "no-results") process.exit(0);
  const child = spawnSync(process.execPath, [join(env.WORKBENCH_DISTRIBUTION_ROOT, "scripts/ci-linux/run.mjs")], {
    cwd: workspace,
    env,
    stdio: "inherit",
  });
  if (child.error) fail(child.error.message);
  const file = join(reports, "guest-results.json");
  const run = JSON.parse(readFileSync(file, "utf8"));
  if (mode === "missing-target") run.targets = [];
  if (mode === "duplicate-target") run.targets.push(run.targets[0]);
  if (mode === "unknown-target") run.targets[0].id = "unselected";
  if (mode === "invalid-error") run.errors.push({ phase: "fixture", message: 42 });
  if (mode === "incomplete-results") {
    run.targets[0].success = false;
    run.targets[0].error = "Target was not executed";
    delete run.targets[0].started;
    delete run.targets[0].finished;
  }
  writeFileSync(file, JSON.stringify(mode === "invalid-results" ? {} : run));
  process.exitCode = mode === "incomplete-results" ? 2 : child.status;
} else if (operation === "ps") {
  if (mode === "cleanup-failure") fail("fixture cleanup failed");
  console.log("owned-container");
} else if (operation === "rm") {
  if (args.slice(1).join(" ") !== "--force owned-container") fail("attempted cleanup of an unowned container");
  appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ cleaned: "owned-container" }) + "\n");
} else fail(`Unsupported fixture Docker operation: ${operation}`);
