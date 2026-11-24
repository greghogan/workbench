import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeGitTree, stagedReviewTree, workingReviewTree } from "../../git/git-snapshot.js";
import { distributionRoot } from "../../projects/project-context.js";
import { createOwnedScratch } from "../../runtime/owned-scratch.mjs";
import { processCancellation, runOwnedChild } from "../../runtime/owned-child.mjs";
import { processFailure } from "../../runtime/process-outcome.mjs";
import { checkPolicyCompatibility } from "../../collections/policy-compatibility.js";
import { currentExecutionEnvironment } from "../environments/execution-context.js";
import type { CheckSelection } from "./check-plan.js";
import { inspectChecks, runChecks } from "./checks.js";
import { readChecks } from "./check-configuration.js";

export type AcquisitionSelection = Pick<
  CheckSelection,
  | "compiler"
  | "compilerVersion"
  | "environment"
  | "path"
  | "profile"
  | "project"
  | "toolchain"
  | "verbose"
  | "workspace"
> & { staged?: boolean };

/** Acquisition uses the ordinary command planner and keeps setup out of the developer's source tree. */
export async function acquireCheckInputs(root: string, { staged, ...selection }: AcquisitionSelection): Promise<void> {
  const environment = currentExecutionEnvironment();
  if (environment.WORKBENCH_OFFLINE === "1") throw new Error("Prepare check inputs from a connected environment");
  if (environment.WORKBENCH_EPHEMERAL_CHECKOUT !== "1" && existsSync(join(root, ".git"))) {
    const distribution = distributionRoot(root);
    const cancellation = processCancellation();
    const snapshot = createOwnedScratch(tmpdir(), "workbench-prepare");
    try {
      const tree = staged ? stagedReviewTree(root) : workingReviewTree(root);
      const source = join(snapshot.directory, "source");
      mkdirSync(source);
      materializeGitTree(root, tree, source);
      checkPolicyCompatibility(source, root);
      const arguments_ = [
        join(distribution, "bin/workbench.mjs"),
        "prepare",
        ...(
          [
            "path",
            "project",
            "environment",
            "profile",
            "workspace",
            "toolchain",
            "compiler",
            "compilerVersion",
          ] as const
        ).flatMap((key) => {
          const value = selection[key];
          return typeof value === "string"
            ? [key === "compilerVersion" ? "--compiler-version" : "--" + key, value]
            : [];
        }),
        ...(selection.verbose ? ["--verbose"] : []),
      ];
      const outcome = await runOwnedChild(process.execPath, arguments_, {
        cwd: source,
        env: {
          ...environment,
          WORKBENCH_DISTRIBUTION_ROOT: distribution,
          WORKBENCH_PROJECT_ROOT: source,
          WORKBENCH_LOCAL_CONFIG_ROOT: root,
          WORKBENCH_EPHEMERAL_CHECKOUT: "1",
          ...(staged ? { WORKBENCH_REVIEW_TREE: tree } : {}),
        },
        signal: cancellation.signal,
        owner: snapshot.owner,
        inheritOutput: true,
        inheritInput: true,
      });
      const failure = processFailure("Prepare check inputs", outcome);
      if (failure) throw failure;
    } finally {
      try {
        snapshot.release();
      } finally {
        cancellation.close();
      }
    }
    return;
  }
  if (staged) throw new Error("Staged preparation needs a Git checkout");
  const configuredRoles = new Set(readChecks(root).map(({ role }) => role));
  const role = ["setup", "acquire"].filter((name) => configuredRoles.has(name));
  const options = { ...selection, role, cache: false };
  if (role.length && inspectChecks(root, options).selected.length) await runChecks(root, options);
  else console.log("No dependency preparation is configured for the selected roots.");
}
