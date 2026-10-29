import { currentExecutionEnvironment } from "./execution-context.js";
import { recordResultTools, selectedToolRequirements } from "./tool-references.js";
import { policyExecutionEnvironment } from "./policy-compatibility.js";
import { checkExecutionEnvironment } from "./execution-resources.js";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { distributionRoot } from "./project-context.js";
import { guardToolchains, resolveCheckCommand } from "./toolchains.js";
import { compilerEnvironment, type CompilerSelection } from "./compilers.js";
import { nativeCheckEnvironment } from "./check-environment.js";
import { managedProfilePath, prepareManagedProfile } from "./managed-profiles.js";
import { inSelectedShell, type CheckEnvironment } from "./environments.js";
import { buildPaths, buildEnvironment, prepareBuild, prepareBuildDependencies } from "./builds.js";
import { checkInvocation } from "./check-invocation.js";
import { commandInvocation } from "./tool-execution.js";
import { required } from "./invariants.js";

export interface CheckCommandRequest {
  directory: string;
  name: string;
  command: string[];
  selected?: CheckEnvironment;
  repositoryRoot?: string | undefined;
  dockerImage?: string | undefined;
  inspectTools?: boolean;
  lockBuild?: boolean;
  compilerSelection?: CompilerSelection & { verbose?: boolean };
}

export function prepareCheckCommand({
  directory,
  name,
  command,
  selected = "native",
  repositoryRoot,
  dockerImage,
  inspectTools = true,
  lockBuild = false,
  compilerSelection = {},
}: CheckCommandRequest) {
  compilerSelection = { ...compilerSelection, environment: selected };
  const compilerEnv = inspectTools ? compilerEnvironment(directory, compilerSelection) : {};
  const resolved = resolveCheckCommand(
    directory,
    command,
    repositoryRoot ? distributionRoot(repositoryRoot) : undefined,
  );
  const outsideContainer = selected === "devcontainer" && currentExecutionEnvironment().WORKBENCH_DEVCONTAINER !== "1";
  const checked =
    inspectTools && !outsideContainer
      ? guardToolchains(
          directory,
          resolved,
          selected !== "native" && selected !== "devcontainer",
          compilerSelection,
          !(compilerSelection.verbose ?? currentExecutionEnvironment().WORKBENCH_VERBOSE === "1"),
        )
      : resolved;
  const builds =
    repositoryRoot && inspectTools ? buildPaths(repositoryRoot, directory, selected, compilerSelection) : undefined;
  const localBuilds =
    builds && !(selected === "devcontainer" && currentExecutionEnvironment().WORKBENCH_DEVCONTAINER !== "1")
      ? builds
      : undefined;
  const profile =
    localBuilds &&
    (selected === "nix" || selected === "guix") &&
    !currentExecutionEnvironment().WORKBENCH_ENVIRONMENTS &&
    currentExecutionEnvironment().WORKBENCH_PREPARED !== "1" &&
    currentExecutionEnvironment().WORKBENCH_OFFLINE !== "1"
      ? managedProfilePath(localBuilds)
      : undefined;
  const outputPaths =
    localBuilds && selected === "nix-docker"
      ? {
          ...localBuilds,
          projectDirectory: join("/work", relative(repositoryRoot ?? directory, directory)),
          directory: localBuilds.external
            ? localBuilds.directory
            : join("/work", relative(repositoryRoot ?? directory, directory), "build"),
        }
      : localBuilds;
  const budget = {
    ...checkExecutionEnvironment(repositoryRoot ?? directory),
    ...(repositoryRoot && selected !== "native" ? policyExecutionEnvironment(repositoryRoot) : {}),
  };
  const native =
    (selected === "native" || (selected === "devcontainer" && !outsideContainer)) && inspectTools && repositoryRoot
      ? nativeCheckEnvironment(
          repositoryRoot,
          directory,
          compilerSelection,
          budget.WORKBENCH_CPU_BUDGET === undefined ? null : Number(budget.WORKBENCH_CPU_BUDGET),
          localBuilds,
        )
      : undefined;
  const managedCommand =
    repositoryRoot &&
    inspectTools &&
    ["nix", "guix", "nix-docker"].includes(selected) &&
    existsSync(join(directory, "managed-check-inputs.json"))
      ? ["node", join(distributionRoot(repositoryRoot), "bin/workbench.mjs"), "managed-inputs-exec", "--", ...checked]
      : checked;
  const commandEnvironment = {
    ...budget,
    ...(repositoryRoot && !outsideContainer ? { WORKBENCH_DISTRIBUTION_ROOT: distributionRoot(repositoryRoot) } : {}),
    ...(outputPaths ? buildEnvironment(outputPaths) : {}),
    ...compilerEnv,
    ...Object.fromEntries(
      ["WORKBENCH_CI_TARGET", "WORKBENCH_CONTAINER_CHECKOUT", "WORKBENCH_LOCAL_CI_IMAGE"].flatMap((name) =>
        currentExecutionEnvironment()[name] === undefined ? [] : [[name, currentExecutionEnvironment()[name]]],
      ),
    ),
  };
  const withOutputs =
    native || selected === "native"
      ? managedCommand
      : ["env", ...Object.entries(commandEnvironment).map(([key, value]) => `${key}=${value}`), ...managedCommand];
  const wrappedCommand =
    inspectTools && inSelectedShell(directory, selected)
      ? withOutputs
      : checkInvocation(
          directory,
          selected,
          withOutputs,
          repositoryRoot,
          dockerImage,
          builds?.external ? builds : undefined,
          budget.WORKBENCH_CPU_BUDGET,
          profile,
        );
  const env: NodeJS.ProcessEnv = native ?? {
    ...currentExecutionEnvironment(),
    ...(repositoryRoot ? { WORKBENCH_PROJECT_ROOT: repositoryRoot } : {}),
    ...(selected === "native" ? commandEnvironment : budget),
  };
  const invocation = commandInvocation(
    required(wrappedCommand[0], "A check command needs an executable"),
    wrappedCommand.slice(1),
    env,
    directory,
  );
  if (selected === "guix") delete env.GUIX_BUILD_OPTIONS;
  const prepare = () => {
    if (localBuilds) {
      prepareBuild(localBuilds);
      if (profile && !localBuilds.external) prepareBuildDependencies(localBuilds);
      if (profile) {
        prepareManagedProfile(localBuilds, profile);
        if (selected === "guix") prepareManagedProfile(localBuilds, `${profile}-pending`, "pending");
      }
      if (selected === "native" && localBuilds.external && repositoryRoot) {
        const tools = selectedToolRequirements(
          repositoryRoot,
          relative(repositoryRoot, directory).replaceAll("\\", "/") || ".",
          compilerSelection,
        );
        for (const [directory, kind] of [
          [localBuilds.directory, "builds"],
          [localBuilds.dependencies, "dependencies"],
        ] as const)
          recordResultTools({
            directory,
            kind,
            storageRoot: localBuilds.storageRoot,
            identity: localBuilds.identity,
            tools:
              kind === "dependencies"
                ? tools.filter((tool) => ["node", "python", "ruby", "php", "java", "gcc", "llvm"].includes(tool.tool))
                : tools,
          });
      }
    }
  };
  return { builds, prepare, invocation, env, name, directory, lockBuild, profile };
}
