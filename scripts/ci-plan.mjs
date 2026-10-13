import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { readHostedPlan } from "./ci-plan-contract.mjs";

export function planCI(environment = process.env, root = process.cwd()) {
  const matrix = readHostedPlan(
    JSON.parse(
      execFileSync(process.execPath, ["bin/workbench.mjs", "checks", "matrix", "--grouped"], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        cwd: root,
        env: environment,
      }),
    ),
  );
  const summary = `## CI coverage\n\n${matrix.native.include.length} native platform jobs; ${matrix.environments.include.length} managed environments. Every configured root is checked.\n`;
  console.log(summary);
  if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, summary);
  if (environment.GITHUB_OUTPUT) appendFileSync(environment.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
  if (environment.RUNNER_TEMP)
    writeFileSync(join(environment.RUNNER_TEMP, "workbench-ci-plan.json"), JSON.stringify(matrix) + "\n");
  return matrix;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) planCI();
