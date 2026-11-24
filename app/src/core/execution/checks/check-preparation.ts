import { currentExecutionEnvironment } from "../environments/execution-context.js";
import { recordResultTools, selectedToolRequirements } from "../../toolchains/tool-references.js";
import { policyExecutionEnvironment } from "../../collections/policy-compatibility.js";
import { checkExecutionEnvironment } from "../environments/execution-resources.js";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { distributionRoot } from "../../projects/project-context.js";
import { guardToolchains, resolveCheckCommand } from "../../toolchains/toolchains.js";
import { compilerEnvironment, type CompilerSelection } from "../../toolchains/compilers.js";
import { nativeCheckEnvironment } from "./check-environment.js";
import { managedProfilePath, prepareManagedProfile } from "../../artifacts/managed-profiles.js";
import { inSelectedShell, type CheckEnvironment } from "../environments/environments.js";
import {
  buildPaths,
  buildEnvironment,
  buildStorageRoots,
  prepareBuild,
  prepareBuildDependencies,
} from "../../artifacts/builds.js";
import { checkInvocation } from "./check-invocation.js";
import { commandInvocation } from "../../toolchains/tool-execution.js";
import { required } from "../../runtime/invariants.js";

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
  toolProbesOnly?: boolean;
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
  toolProbesOnly = false,
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
  const execution = currentExecutionEnvironment();
  let profileBuilds =
    localBuilds &&
    (selected === "nix" || selected === "guix") &&
    !execution.WORKBENCH_ENVIRONMENTS &&
    execution.WORKBENCH_PREPARED !== "1"
      ? localBuilds
      : undefined;
  // Keep prepared profiles addressable from different snapshots without sharing mutable build outputs.
  if (profileBuilds && execution.WORKBENCH_LOCAL_CONFIG_ROOT) {
    const identity = { ...profileBuilds.identity, checkout: execution.WORKBENCH_LOCAL_CONFIG_ROOT };
    const { dependencyRoots } = buildStorageRoots(profileBuilds.storageRoot, identity);
    profileBuilds = {
      ...profileBuilds,
      identity,
      dependencyRoots,
      dependencies: join(dependencyRoots, `${selected}-${identity.fingerprint}`),
    };
  }
  const profile = profileBuilds && managedProfilePath(profileBuilds);
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
  const offlineTools =
    currentExecutionEnvironment().WORKBENCH_OFFLINE === "1"
      ? {
          WORKBENCH_OFFLINE: "1",
          UV_OFFLINE: "1",
          npm_config_offline: "true",
          PNPM_CONFIG_OFFLINE: "true",
          CARGO_NET_OFFLINE: "true",
          GOPROXY: "off",
          GOSUMDB: "off",
          COMPOSER_DISABLE_NETWORK: "1",
          MAVEN_ARGS: `${(native ?? currentExecutionEnvironment()).MAVEN_ARGS ?? ""} --offline`.trim(),
        }
      : {};
  const managedCommand =
    repositoryRoot &&
    inspectTools &&
    !toolProbesOnly &&
    ["nix", "guix", "nix-docker"].includes(selected) &&
    existsSync(join(directory, "managed-check-inputs.json"))
      ? ["node", join(distributionRoot(repositoryRoot), "bin/workbench.mjs"), "managed-inputs-exec", "--", ...checked]
      : checked;
  const commandEnvironment = {
    ...budget,
    ...offlineTools,
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
  const env: NodeJS.ProcessEnv = native
    ? { ...native, ...offlineTools }
    : {
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
      if (profile && profileBuilds && execution.WORKBENCH_OFFLINE !== "1") {
        if (!localBuilds.external || profileBuilds !== localBuilds) prepareBuildDependencies(profileBuilds);
        prepareManagedProfile(profileBuilds, profile);
        if (selected === "guix") prepareManagedProfile(profileBuilds, `${profile}-pending`, "pending");
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
  return {
    builds,
    prepare,
    invocation,
    env,
    name,
    directory,
    lockBuild,
    profileDependencies: profileBuilds?.dependencies,
  };
}
