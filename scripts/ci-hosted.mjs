import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { targetEnvironment, targetPhases } from "./ci-contract.mjs";
import { createRunReport, runReportedTarget, runSucceeded, writeRunReport } from "./ci-results.mjs";

const matrix = JSON.parse(process.env.CI_MATRIX);
const kind = process.argv[2];
const cli = join(process.cwd(), "bin/workbench.mjs");
const inspect = (...args) =>
  execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
function run(args, env = process.env) {
  const child = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (child.error || child.status !== 0) throw new Error(`${args[0]} failed: ${child.error ?? child.status}`);
}
const catalog = JSON.parse(inspect("checks", "matrix", "--targets"));
const targets = catalog.filter((target) => {
  if (!matrix.paths.includes(target.path)) return false;
  if (kind === "native" && target.kind === "compatibility")
    return matrix.os === "linux" && target.architecture === matrix.architecture;
  if (target.kind !== kind) return false;
  if (kind === "native") return target.os === matrix.os && target.architecture === matrix.architecture;
  if (kind === "environment") return target.environment === matrix.environment;
  return (
    target.runtime === matrix.runtime &&
    target.version === matrix.version &&
    target.architecture === (matrix.architecture ?? "x64")
  );
});
if (!targets.length) throw new Error("Hosted job has no configured targets");
const encoded = inspect("config", "get", "ci.images", "--scope", "project");
const images = encoded === "<unset>" ? {} : JSON.parse(encoded);
const builder = kind === "environment" ? (matrix.environment === "nix-docker" ? "nix" : matrix.environment) : "native";
const profile = process.platform === "linux" ? images[builder] : undefined;
if (["nix", "guix"].includes(builder) && !profile)
  throw new Error(`${builder} CI requires a prepared profile in ci.images`);
const reports = join(process.env.RUNNER_TEMP, "workbench-reports");
mkdirSync(reports, { recursive: true });
if (profile) {
  run([cli, "tools", "install", "--devcontainer"]);
  run([cli, "development", "prepare", profile]);
  writeFileSync(join(reports, "targets.json"), JSON.stringify(targets));
  run([
    cli,
    "ci-image-exec",
    profile,
    "--reports",
    reports,
    "--env-json",
    JSON.stringify({ RUNNER_TEMP: "/reports", WORKBENCH_CI_TARGETS: "/reports/targets.json" }),
    "--",
    "node",
    "{workbench}/scripts/ci-linux/run.mjs",
  ]);
  // Only an explicitly authorized trusted workflow sets this switch. PRs never publish.
  if (process.env.WORKBENCH_PUBLISH_IMAGES === "true") run([cli, "development", "publish", profile]);
} else {
  if (builder === "devcontainer") run([cli, "tools", "install", "--devcontainer"]);
  const result = createRunReport(
    targets.map((target) => target.id),
    reports,
  );
  const save = () => writeRunReport(join(reports, "results.json"), result);
  save();
  for (const target of targets) {
    runReportedTarget(result, target.id, join(process.cwd(), target.path, "coverage"), (report) => {
      const env = { ...process.env, ...targetEnvironment(target), RUNNER_TEMP: report };
      for (const phase of targetPhases(target)) run(["scripts/ci-run.mjs", phase], env);
    });
    save();
  }
  if (!runSucceeded(result)) process.exitCode = 1;
}
