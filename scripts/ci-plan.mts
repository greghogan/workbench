import { isMainScript } from "./script-entry.mjs";
import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readHostedPlan } from "./ci-plan-contract.mts";

export function planCI(environment = process.env, root = process.cwd()) {
  const matrix = readHostedPlan(
    JSON.parse(
      execFileSync(process.execPath, ["bin/workbench.mjs", "check", "matrix", "--grouped"], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        cwd: root,
        env: environment,
      }),
    ),
  );
  const summary = `## CI coverage\n\n${String(matrix.native.include.length)} native platform jobs; ${String(matrix.environments.include.length)} managed environments. Every configured root is checked.\n`;
  console.log(summary);
  if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, summary);
  if (environment.GITHUB_OUTPUT)
    appendFileSync(
      environment.GITHUB_OUTPUT,
      `matrix=${JSON.stringify(matrix)}\nartifact=ci-plan-${environment.GITHUB_RUN_ID ?? "local"}-${environment.GITHUB_RUN_ATTEMPT ?? "1"}\n`,
    );
  if (environment.RUNNER_TEMP)
    writeFileSync(join(environment.RUNNER_TEMP, "workbench-ci-plan.json"), JSON.stringify(matrix) + "\n");
  return matrix;
}

if (isMainScript(import.meta.url)) planCI();
