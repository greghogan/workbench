import { required, errorFrom } from "../values.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { targetEnvironment, targetPhases } from "../ci-contract.mjs";
import { createRunReport, parseRunReport, runReportedTarget, runSucceeded, writeRunReport } from "../ci-results.mjs";
import { parseCIWorkerRequest } from "../ci-worker-request.mjs";

// This private request is created by the coordinator from its frozen source snapshot.
const { workspace, distribution, target, reports, image, profile, cache, shared, adapter, uid, gid } =
  parseCIWorkerRequest(JSON.parse(readFileSync(required(process.argv[2], "Missing worker request path"), "utf8")));
function execute(command: string, args: readonly string[], env = process.env) {
  const child = spawnSync(command, args, { cwd: workspace, env, stdio: "inherit" });
  if (child.error || child.status !== 0) throw new Error(`${command} failed: ${String(child.error ?? child.status)}`);
}
const run = createRunReport([target.id], reports);
const results = join(reports, "job-results.json");
writeRunReport(results, run);
try {
  if (profile) {
    writeFileSync(join(reports, "targets.json"), JSON.stringify([target]));
    const env = {
      RUNNER_TEMP: "/reports",
      WORKBENCH_CI_TARGETS: "/reports/targets.json",
      WORKBENCH_CPU_BUDGET: shared.WORKBENCH_CPU_BUDGET,
      ...(shared.WORKBENCH_CPUS === undefined ? {} : { WORKBENCH_CPUS: shared.WORKBENCH_CPUS }),
    };
    let failure: Error | undefined;
    try {
      execute(process.execPath, [
        join(distribution, "bin/workbench.mjs"),
        "ci-image-exec",
        profile,
        "--image",
        required(image, "Missing worker image"),
        "--reports",
        reports,
        "--env-json",
        JSON.stringify(env),
        "--",
        "node",
        "{workbench}/scripts/ci-linux/run.mjs",
      ]);
    } catch (error) {
      failure = errorFrom(error);
    }
    const returned = parseRunReport(
      JSON.parse(readFileSync(join(reports, "guest-results.json"), "utf8")),
      [target.id],
      reports,
    );
    run.targets = returned.targets;
    run.errors = returned.errors;
    if (failure && runSucceeded(returned)) throw failure;
  } else if (target.kind === "environment") {
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
    let containerError: Error | undefined;
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
        `${String(uid)}:${String(gid)}`,
        "--workdir",
        "/workspace",
        ...(
          [
            [workspace, "/workspace"],
            [cache, cache],
            [reports, "/reports"],
          ] as const
        ).flatMap(([source, destination]) => {
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
        required(image, "Missing worker image"),
        "node",
        `${guestDistribution}/scripts/ci-linux/run.mjs`,
      ]);
    } catch (error) {
      containerError = errorFrom(error);
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
