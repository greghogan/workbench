import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { CITarget } from "../src/ci-targets.js";
import { targetEnvironment, targetPhases } from "./ci-contract.mjs";
import { CIOperation, operationPhases } from "./ci-operations.mjs";
import { CILifecycle, executeCI } from "./ci-lifecycle.mjs";
import { createRunReport, runReportedTargetAsync, writeRunReport } from "./ci-results.mjs";

export interface CIExecution {
  targets: CITarget[];
  workspace: string;
  distribution: string;
  reports: string;
  resultFile: string;
  operation?: CIOperation;
  env?: NodeJS.ProcessEnv;
  lifecycle?: CILifecycle;
  installPrerequisites?: boolean;
}
/** Host, guest, and local managed jobs own exactly the same phase, failure and report lifecycle. */
export async function executeCITargets(options: CIExecution) {
  const run = createRunReport(
    options.targets.map((target) => target.id),
    options.reports,
  );
  const lifecycle = options.lifecycle ?? new CILifecycle();
  const save = () => {
    writeRunReport(options.resultFile, run);
  };
  try {
    mkdirSync(options.reports, { recursive: true });
    save();
    for (const target of options.targets) {
      await lifecycle.checkpoint();
      await runReportedTargetAsync(run, target.id, join(options.workspace, target.path, "coverage"), async (report) => {
        const env = { ...(options.env ?? process.env), ...targetEnvironment(target), RUNNER_TEMP: report };
        const phases =
          options.operation === undefined ? targetPhases(target) : operationPhases(target, options.operation);
        if (!phases.length) throw new Error("Target has no phases in this operation");
        const execute = async (phase: string) => {
          await lifecycle.checkpoint();
          await executeCI(process.execPath, [join(options.distribution, "scripts/ci-run.mjs"), phase], {
            cwd: options.workspace,
            env,
          });
        };
        // Operation workspaces share verified caches, not complete installations or project setup.
        if (options.installPrerequisites && target.kind === "native" && !phases.includes("native-install"))
          await execute("native-install");
        for (const phase of phases) await execute(phase);
      });
      save();
    }
    return run;
  } finally {
    if (!options.lifecycle) lifecycle.close();
  }
}
