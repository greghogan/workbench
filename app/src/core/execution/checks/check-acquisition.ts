import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeGitTree, readGitTree, stagedReviewTree, workingReviewTree } from "../../git/git-snapshot.js";
import { distributionRoot } from "../../projects/project-context.js";
import { languageRootsFromData, readConfig, readProjects } from "../../projects/project-configuration.js";
import { projectPaths } from "../../projects/project-paths.js";
import { readConfigurationToml } from "../../configuration/configuration-snapshot.js";
import { registeredRootPath } from "../../runtime/paths.js";
import { nativeToolVersionFiles } from "../../toolchains/native/native-assets.js";
import { createOwnedScratch } from "../../runtime/owned-scratch.mjs";
import { processCancellation, runOwnedChild } from "../../runtime/owned-child.mjs";
import { processFailure } from "../../runtime/process-outcome.mjs";
import { checkPolicyCompatibility } from "../../collections/policy-compatibility.js";
import { currentExecutionEnvironment, withExecutionEnvironment } from "../environments/execution-context.js";
import { executionPreference, withDevelopmentSelection } from "../environments/environments.js";
import { planChecks, type CheckSelection } from "./check-plan.js";
import { inspectChecks, runChecks } from "./checks.js";
import { readChecks } from "./check-configuration.js";
import { checkInputPaths, checkScopes } from "./check-input-scope.js";

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

const acquisitionRoles = ["setup", "acquire"];

/** Select from an immutable Git tree, including the control files the child uses to plan and verify the acquisition. */
export function materializeAcquisitionSource(
  root: string,
  tree: string,
  source: string,
  selection: Omit<AcquisitionSelection, "staged">,
): void {
  if (process.platform !== "win32" && (!selection.environment || selection.environment === "native")) {
    const files = readGitTree(root, tree);
    const declarations = [
      projectPaths.config,
      projectPaths.projects,
      projectPaths.automation,
      projectPaths.profiles,
    ].filter((path) => files.has(path));
    if (declarations.every((path) => files.get(path)?.mode === "100644" || files.get(path)?.mode === "100755")) {
      materializeGitTree(root, tree, source, declarations);
      if (tryMaterializeScopedAcquisition(root, tree, source, files, declarations, selection)) return;
      rmSync(source, { recursive: true });
      mkdirSync(source);
    }
  }
  materializeGitTree(root, tree, source);
}

function tryMaterializeScopedAcquisition(
  root: string,
  tree: string,
  source: string,
  files: ReturnType<typeof readGitTree>,
  declarations: string[],
  selection: Omit<AcquisitionSelection, "staged">,
): boolean {
  const selectPaths = checkInputPaths(files.keys());
  try {
    const config = readConfig(source);
    if (!Object.keys(config.input_groups ?? {}).length) return false;
    const projects = readProjects(source);
    const registry = join(source, projectPaths.projects);
    const roots = new Set([
      ...projects.map(({ path }) => path),
      ...languageRootsFromData(readConfigurationToml(registry), registry).map(({ path }) => path),
      ...(config.check ?? []).map(({ path }) => path ?? "."),
    ]);
    for (const path of roots) {
      registeredRootPath(path, "acquisition root");
      if (path === ".") continue;
      if (files.has(path) || selectPaths([path])[Symbol.iterator]().next().done) return false;
      mkdirSync(join(source, path), { recursive: true });
    }
    const checks = readChecks(source);
    const role = acquisitionRoles.filter((candidate) => checks.some((check) => check.role === candidate));
    if (!role.length) return false;
    const plan = withExecutionEnvironment(
      { ...currentExecutionEnvironment(), WORKBENCH_LOCAL_CONFIG_ROOT: root, WORKBENCH_PROJECT_ROOT: source },
      () =>
        withDevelopmentSelection(
          source,
          selection.environment,
          selection.profile,
          () => {
            const environment = executionPreference(source, selection.environment, selection.profile);
            return planChecks(source, checks, { ...selection, role, ...(environment ? { environment } : {}) });
          },
          selection.workspace,
        ),
    );
    if (plan.sessions.some((session) => session.environment !== "native")) return false;
    const scope = checkScopes(
      plan.sessions.flatMap(({ checks }) => checks),
      config.checks?.inputs,
    );
    if (scope.mode !== "scoped" || scope.paths.includes(".")) return false;
    const selected = new Set(
      selectPaths([
        ...scope.paths,
        ...projects.map(({ path }) => (path === "." ? "workbench" : `${path}/workbench`)),
        ...[...roots].flatMap((path) =>
          [...nativeToolVersionFiles, ".gitattributes", "package.json"].map((name) =>
            path === "." ? name : `${path}/${name}`,
          ),
        ),
      ]),
    );
    if ([...selected].some((path) => files.get(path)?.mode !== "100644" && files.get(path)?.mode !== "100755"))
      return false;
    for (const path of declarations) selected.delete(path);
    materializeGitTree(root, tree, source, [...selected]);
    return true;
  } catch {
    // Diagnose malformed or unsupported declarations against the complete snapshot in the ordinary child.
    return false;
  }
}

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
      materializeAcquisitionSource(root, tree, source, selection);
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
  const role = acquisitionRoles.filter((name) => configuredRoles.has(name));
  const options = { ...selection, role, cache: false };
  if (role.length && inspectChecks(root, options).selected.length) await runChecks(root, options);
  else console.log("No dependency preparation is configured for the selected roots.");
}
