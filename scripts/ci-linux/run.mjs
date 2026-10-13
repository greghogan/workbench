import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { targetEnvironment, targetPhases } from "../ci-contract.mjs";
import { createRunReport, runReportedTarget, runSucceeded, writeRunReport } from "../ci-results.mjs";

const distribution = process.env.WORKBENCH_DISTRIBUTION_ROOT;
const targets = JSON.parse(readFileSync(process.env.WORKBENCH_CI_TARGETS, "utf8"));
const reports = process.env.RUNNER_TEMP;
if (!Array.isArray(targets) || !targets.length) throw new Error("Local CI requires selected targets");
mkdirSync(process.env.HOME, { recursive: true });
const run = createRunReport(
  targets.map((target) => target.id),
  reports,
);
const resultsPath = join(reports, "guest-results.json");
writeRunReport(resultsPath, run);
for (const target of targets) {
  runReportedTarget(run, target.id, join(process.cwd(), target.path, "coverage"), (report) => {
    const env = { ...process.env, ...targetEnvironment(target), RUNNER_TEMP: report };
    for (const phase of targetPhases(target)) {
      const child = spawnSync(process.execPath, [join(distribution, "scripts/ci-run.mjs"), phase], {
        env,
        stdio: "inherit",
      });
      if (child.error || child.status !== 0) throw new Error(`${phase} failed: ${child.error ?? child.status}`);
    }
  });
  writeRunReport(resultsPath, run);
}
if (!runSucceeded(run)) process.exitCode = 1;
