import { required } from "../values.mjs";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readCITargets } from "../ci-contract.mjs";
import { readCIOperation } from "../ci-operations.mjs";
import { executeCITargets } from "../ci-execution.mjs";
import { runSucceeded } from "../ci-results.mjs";
const distribution = required(process.env.WORKBENCH_DISTRIBUTION_ROOT, "WORKBENCH_DISTRIBUTION_ROOT is required");
const targets = readCITargets(
  JSON.parse(readFileSync(required(process.env.WORKBENCH_CI_TARGETS, "WORKBENCH_CI_TARGETS is required"), "utf8")),
);
const reports = required(process.env.RUNNER_TEMP, "RUNNER_TEMP is required");
mkdirSync(required(process.env.HOME, "HOME is required"), { recursive: true });
const selected = process.env.WORKBENCH_CI_OPERATION;
const run = await executeCITargets({
  targets,
  distribution,
  workspace: process.cwd(),
  reports,
  resultFile: join(reports, "guest-results.json"),
  ...(selected === undefined ? {} : { operation: readCIOperation(selected) }),
  installPrerequisites: process.env.WORKBENCH_CI_INSTALL_PREREQUISITES === "1",
});
if (!runSucceeded(run)) process.exitCode = 1;
