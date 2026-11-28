import { required, errorFrom } from "../../app/src/core/runtime/values.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { executeCITargets } from "../../app/src/core/execution/ci/support/ci-execution.mjs";
import { CIOperation } from "../../app/src/core/execution/ci/support/ci-operations.mjs";
import {
  createRunReport,
  parseRunReport,
  runSucceeded,
  writeRunReport,
} from "../../app/src/core/execution/ci/support/ci-results.mjs";
import { parseCIWorkerRequest } from "../../app/src/core/execution/ci/support/ci-worker-request.mjs";

// This private request is created by the coordinator from its frozen source snapshot.
const { workspace, distribution, target, operation, reports, image, profile, cache, shared, adapter, uid, gid } =
  parseCIWorkerRequest(JSON.parse(readFileSync(required(process.argv[2], "Missing worker request path"), "utf8")));
function execute(command: string, args: readonly string[], env = process.env) {
  const child = spawnSync(command, args, { cwd: workspace, env, stdio: "inherit" });
  if (child.error || child.status !== 0) throw new Error(`${command} failed: ${String(child.error ?? child.status)}`);
}
const operationEnvironment = {
  ...(operation === undefined ? {} : { WORKBENCH_CI_OPERATION: operation }),
  ...(operation !== undefined && operation !== CIOperation.Checks ? { WORKBENCH_CI_INSTALL_PREREQUISITES: "1" } : {}),
};
const run = createRunReport([target.id], reports);
const results = join(reports, "job-results.json");
writeRunReport(results, run);
try {
  if (profile) {
    const selection = join(reports, "targets.json");
    writeFileSync(selection, JSON.stringify([target]));
    let failure: Error | undefined;
    try {
      execute(
        process.execPath,
        [
          join(distribution, "bin/workbench.mjs"),
          "ci-image-job",
          profile,
          "--local-image",
          required(image, "Missing worker image"),
          "--targets",
          selection,
          "--reports",
          reports,
          ...(operation === undefined ? [] : ["--operation", operation]),
        ],
        { ...process.env, ...shared },
      );
    } catch (error) {
      failure = errorFrom(error);
    }
    const returned = parseRunReport(JSON.parse(readFileSync(results, "utf8")), [target.id], reports);
    run.targets = returned.targets;
    run.errors = returned.errors;
    if (failure && (runSucceeded(returned) || returned.targets.some((result) => result.finished === undefined)))
      throw failure;
  } else if (target.kind === "environment") {
    const env = {
      ...process.env,
      ...shared,
      WORKBENCH_PROJECT_ROOT: workspace,
      WORKBENCH_DISTRIBUTION_ROOT: distribution,
      WORKBENCH_CI_DOCKER: adapter,
    };
    if (target.environment === "devcontainer")
      execute(process.execPath, [join(distribution, "bin/workbench.mjs"), "tools", "install", "--devcontainer"], env);
    const result = await executeCITargets({
      targets: [target],
      workspace,
      distribution,
      reports,
      resultFile: results,
      env,
      ...(operation === undefined ? {} : { operation }),
    });
    run.targets = result.targets;
    run.errors = result.errors;
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
          ...operationEnvironment,
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
