#!/usr/bin/env node
import { required } from "../../src/invariants.ts";
import type { TargetResult } from "../../scripts/ci-results.mjs";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const mode = process.env.FIXTURE_BEHAVIOR;
const operation = args[0];
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
if (operation === "build") {
  if (mode === "build-failure") fail("fixture image failed");
  const policy = JSON.parse(readFileSync(join(required(args.at(-1), "Build context"), "bootstrap.json"), "utf8")) as {
    sha256?: string;
    checksums?: { signature?: { keys?: string } };
  };
  if (!policy.sha256 || !policy.checksums?.signature?.keys) fail("missing bootstrap verification policy");
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
  const mounts = new Map<string, string>();
  const env = { ...process.env };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mount") {
      const fields = new Map(
        required(args[++i], "Mount argument")
          .split(",")
          .map((part) => {
            const at = part.indexOf("=");
            return [part.slice(0, at), part.slice(at + 1)];
          }),
      );
      mounts.set(required(fields.get("dst"), "Mount destination"), required(fields.get("src"), "Mount source"));
    } else if (args[i] === "--env") {
      const value = required(args[++i], "Environment argument");
      const at = value.indexOf("=");
      env[value.slice(0, at)] = value.slice(at + 1);
    }
  }
  const workspace = mounts.get("/workspace");
  const reports = mounts.get("/reports");
  if (!workspace || !reports || !existsSync(join(workspace, "draft"))) fail("missing snapshot mounts");
  if (readFileSync(join(workspace, "draft"), "utf8") !== "pending input") fail("snapshot lost pending inputs");
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (value.startsWith("/workspace")) env[name] = workspace + value.slice("/workspace".length);
    if (value.startsWith("/reports")) env[name] = reports + value.slice("/reports".length);
  }
  const cache = required(env.WORKBENCH_CACHE_HOME, "Guest cache");
  if (env.CARGO_HOME !== join(cache, "ci/cargo") || env.UV_PYTHON_INSTALL_DIR !== join(cache, "uv-python/python"))
    fail("guest cache isolation failed");
  writeFileSync(required(process.env.FIXTURE_REPORTS, "Reports receipt"), reports);
  if (mode === "no-results") process.exit(0);
  const child = spawnSync(
    process.execPath,
    [join(required(env.WORKBENCH_DISTRIBUTION_ROOT, "Guest distribution"), "scripts/ci-linux/run.mjs")],
    {
      cwd: workspace,
      env,
      stdio: "inherit",
    },
  );
  if (child.error) fail(child.error.message);
  const file = join(reports, "guest-results.json");
  const run = JSON.parse(readFileSync(file, "utf8")) as { targets: TargetResult[]; errors: Record<string, unknown>[] };
  if (mode === "missing-target") run.targets = [];
  if (mode === "duplicate-target") run.targets.push(required(run.targets[0], "Duplicated target"));
  if (mode === "unknown-target") required(run.targets[0], "Changed target").id = "unselected";
  if (mode === "invalid-error") run.errors.push({ phase: "fixture", message: 42 });
  if (mode === "incomplete-results") {
    const target = required(run.targets[0], "Incomplete target");
    target.success = false;
    target.error = "Target was not executed";
    delete target.started;
    delete target.finished;
  }
  writeFileSync(file, JSON.stringify(mode === "invalid-results" ? {} : run));
  process.exitCode = mode === "incomplete-results" ? 2 : (child.status ?? 1);
} else if (operation === "ps") {
  if (mode === "cleanup-failure") fail("fixture cleanup failed");
  console.log("owned-container");
} else if (operation === "rm") {
  if (args.slice(1).join(" ") !== "--force owned-container") fail("attempted cleanup of an unowned container");
  appendFileSync(
    required(process.env.FIXTURE_EVENTS, "Event log"),
    JSON.stringify({ cleaned: "owned-container" }) + "\n",
  );
} else fail(`Unsupported fixture Docker operation: ${String(operation)}`);
