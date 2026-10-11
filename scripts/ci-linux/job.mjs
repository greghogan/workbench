import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { targetEnvironment, targetPhases } from "../ci-contract.mjs";
import { createRunReport, parseRunReport, runReportedTarget, runSucceeded, writeRunReport } from "../ci-results.mjs";
import { parseCIWorkerRequest } from "../ci-worker-request.mjs";

// This private request is created by the coordinator from its frozen source snapshot.
const { workspace, distribution, target, reports, image, cache, shared, adapter, uid, gid } = parseCIWorkerRequest(
  JSON.parse(readFileSync(process.argv[2], "utf8")),
);
function execute(command, args, env = process.env) {
  const child = spawnSync(command, args, { cwd: workspace, env, stdio: "inherit" });
  if (child.error || child.status !== 0) throw new Error(`${command} failed: ${child.error ?? child.status}`);
}
const run = createRunReport([target.id], reports);
const results = join(reports, "job-results.json");
writeRunReport(results, run);
try {
  if (target.kind === "environment") {
    runReportedTarget(run, target.id, join(workspace, target.path, "coverage"), (report) => {
      const env = {
        ...process.env,
        ...shared,
        ...targetEnvironment(target),
        WORKBENCH_PROJECT_ROOT: workspace,
        WORKBENCH_DISTRIBUTION_ROOT: distribution,
        WORKBENCH_CI_DOCKER: adapter,
        RUNNER_TEMP: report,
      };
      if (target.environment === "devcontainer")
        execute(process.execPath, [join(distribution, "bin/workbench.mjs"), "tools", "install", "--devcontainer"], env);
      for (const phase of targetPhases(target))
        execute(process.execPath, [join(distribution, "scripts/ci-run.mjs"), phase], env);
    });
  } else {
    mkdirSync(join(reports, "home"), { recursive: true });
    writeFileSync(join(reports, "targets.json"), JSON.stringify([target]));
    const guestDistribution = `/workspace/${relative(workspace, distribution)}`;
    let containerError;
    try {
      execute("docker", [
        "run",
        "--rm",
        "--label",
        `workbench.ci.workspace=${workspace}`,
        "--network=host",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user",
        `${uid}:${gid}`,
        "--workdir",
        "/workspace",
        ...[
          [workspace, "/workspace"],
          [cache, cache],
          [reports, "/reports"],
        ].flatMap(([source, destination]) => {
          if (source.includes(",")) throw new Error("Docker bind mounts do not support commas in source paths");
          return ["--mount", `type=bind,src=${source},dst=${destination}`];
        }),
        ...Object.entries({
          ...shared,
          HOME: "/reports/home",
          RUNNER_TEMP: "/reports",
          TMPDIR: "/tmp",
          WORKBENCH_DISTRIBUTION_ROOT: guestDistribution,
          WORKBENCH_PROJECT_ROOT: "/workspace",
          WORKBENCH_CI_TARGETS: "/reports/targets.json",
        }).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        image,
        "node",
        `${guestDistribution}/scripts/ci-linux/run.mjs`,
      ]);
    } catch (error) {
      containerError = error;
    }
    const returned = parseRunReport(
      JSON.parse(readFileSync(join(reports, "guest-results.json"), "utf8")),
      [target.id],
      reports,
    );
    run.targets = returned.targets;
    run.errors = returned.errors;
    if (containerError && (runSucceeded(returned) || returned.targets.some((result) => result.finished === undefined)))
      throw containerError;
  }
} catch (error) {
  run.errors.push({
    phase: "target execution or results",
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  writeRunReport(results, run);
}
if (!runSucceeded(run)) process.exitCode = 1;
