import type { CheckRunResult } from "./check-report.js";
import { guixChannelFile } from "../scripts/managed-contract.mjs";
import { randomUUID } from "node:crypto";
import { checkOutput, checkOutputPrelude } from "./check-output.js";
import { prepareCheckLogs, checkLogDirectory } from "./builds.js";
import { withCacheLock, withCacheLockSync } from "./cache-lock.js";
import { runCheckGroups } from "./check-runner.js";
import { CheckCancellation } from "./check-cancellation.js";
import { withCheckCoordination } from "./check-coordination.js";
import type { ProcessLock } from "./process-lock.js";
import { withCachedChecks } from "./check-cache.js";
import { recordResultTools, selectedToolRequirements } from "./tool-references.js";
import { withToolCacheUse, withToolCacheUseAsync } from "./tool-cache-lock.js";
import { policyExecutionEnvironment } from "./policy-compatibility.js";
import { required } from "./invariants.js";
import { executionEnvironment } from "./execution-resources.js";
import { builderCPUArguments } from "../scripts/cpu-budget.mjs";
import { ownedPath } from "./paths.js";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  distributionRoot,
  readConfig,
  readLanguageRoots,
  readProjects,
  readToml,
  rootOf,
  type Project,
  type CheckDefinition,
} from "./core.js";
import { catalog } from "./language-config.js";
import { guardToolchains, quote, resolveCheckCommand } from "./toolchains.js";
import { compilerEnvironment, type CompilerSelection } from "./compilers.js";
import { nativeCheckEnvironment } from "./check-environment.js";
import { readCheckOrder } from "./check-order.js";
import { checkExecution } from "./check-resources.js";
import { validateCheckControl } from "./check-control.js";
import { devcontainerCommand } from "./devcontainers.js";
import { managedProfilePath, prepareManagedProfile, releaseGuixEnvironmentRoot } from "./managed-profiles.js";

import {
  checkEnvironment,
  executionPreference,
  inSelectedShell,
  withDevelopmentSelection,
  type CheckEnvironment,
} from "./environments.js";
import { checkPolicy, commandArguments, planChecks, type CheckSelection } from "./check-plan.js";
import {
  buildPaths,
  buildEnvironment,
  prepareBuild,
  prepareBuildDependencies,
  withBuildLock,
  cleanBuilds,
  type BuildPaths,
} from "./builds.js";
import { terminalTable } from "./terminal-table.js";
export type { CheckEnvironment } from "./environments.js";
export interface ConfiguredCheck {
  name: string;
  role: string;
  command: string[];
  project: Project;
  directory: string;
  location: string;
  warnSeconds: number | undefined;
  environment: CheckEnvironment;
  dockerImage: string | undefined;
  stages: string[];
  online: boolean;
  requiresSetup: boolean;
  coverage: ReturnType<typeof checkPolicy>["coverage"];
  source?: string;
}
const validRole = /^[a-z][a-z0-9-]*$/;

export function readChecks(root: string): ConfiguredCheck[] {
  const config = readConfig(root);
  const projects = readProjects(root);
  if (config.checks?.allow_empty !== undefined && typeof config.checks.allow_empty !== "boolean")
    throw new Error("checks.allow_empty must be Boolean");
  const defaultEnvironment = checkEnvironment(config.checks?.environment ?? "native", "checks.environment");
  const dockerImage = config.checks?.nix_docker_image;
  if (
    dockerImage !== undefined &&
    (typeof dockerImage !== "string" || !/^[^\s]+@sha256:[0-9a-f]{64}$/.test(dockerImage))
  )
    throw new Error("checks.nix_docker_image must be an image pinned by SHA-256 digest");
  if (defaultEnvironment === "nix-docker" && !dockerImage)
    throw new Error("checks.nix_docker_image is required for 'nix-docker'");
  const seen = new Set<string>();
  const definitions: CheckDefinition[] = [...(config.check ?? [])];
  const sources = new Map<string, string>();
  const automation = ownedPath(root, "workbench/automation.toml");
  const projectSource =
    existsSync(automation) && Object.hasOwn(readToml(automation) as object, "check")
      ? automation
      : ownedPath(root, "workbench/config.toml");
  const languages = config.check_suite?.length ? catalog(root) : [];
  const roots = config.check_suite?.length ? readLanguageRoots(root) : [];
  for (const suite of config.check_suite ?? []) {
    if (!roots.some((entry) => entry.language === suite.language && entry.path === suite.path))
      throw new Error(`check_suite: register ${suite.language}@${suite.path} as a language root first`);
    const language = languages.find((entry) => entry.id === suite.language);
    if (!language) throw new Error(`check_suite: unknown language '${suite.language}'`);
    for (const check of language.command) {
      const name = `${suite.language}@${suite.path}: ${check.name ?? check.role}`;
      definitions.push({ ...check, name, path: suite.path });
      sources.set(name, `${language.source}: ${join(language.directory, "automation.toml")}`);
    }
  }
  const checks = definitions.map((entry) => {
    for (const key of Object.keys(entry))
      if (
        ![
          "name",
          "role",
          "project",
          "path",
          "command",
          "stages",
          "online",
          "requires_setup",
          "environment",
          "warn_seconds",
          "coverage",
          "extensions",
        ].includes(key)
      )
        throw new Error(`check '${entry.name}': unknown field '${key}'`);
    if (typeof entry.name !== "string" || !entry.name.trim() || seen.has(entry.name))
      throw new Error("every check needs a unique nonempty name");
    seen.add(entry.name);
    const role = entry.role;
    if (!validRole.test(role)) throw new Error(`check '${entry.name}' has an invalid role`);
    commandArguments(entry.command, `check '${entry.name}'`);
    const policy = checkPolicy(entry);
    const project = projects.find((candidate) => candidate.id === (entry.project ?? projects[0]?.id));
    if (!project) throw new Error(`check '${entry.name}' names unknown project '${String(entry.project)}'`);
    if (
      entry.path !== undefined &&
      (entry.project !== undefined ||
        (entry.path !== "." &&
          (isAbsolute(entry.path) ||
            entry.path.includes("\\") ||
            entry.path
              .split(/[\\/]/)
              .some(
                (part) =>
                  !part ||
                  part === "." ||
                  part === ".." ||
                  [".git", ".workbench", "workbench", "target", "libexec"].includes(part),
              ))))
    )
      throw new Error(`check '${entry.name}' has an unsafe or ambiguous path`);
    if (entry.path) ownedPath(root, entry.path);
    if (entry.path && entry.path !== ".") {
      let directory = root;
      for (const component of entry.path.split("/")) {
        directory = join(directory, component);
        if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
          throw new Error(`check '${entry.name}' path must be a real directory`);
      }
    }
    if (entry.warn_seconds !== undefined && (!Number.isFinite(entry.warn_seconds) || entry.warn_seconds <= 0))
      throw new Error(`check '${entry.name}' warn_seconds must be positive`);
    const selectedEnvironment = checkEnvironment(
      entry.environment ?? defaultEnvironment,
      `check '${entry.name}' environment`,
    );
    if (selectedEnvironment === "nix-docker" && !dockerImage)
      throw new Error(`check '${entry.name}' needs checks.nix_docker_image`);
    return {
      ...policy,
      name: entry.name,
      role,
      command: entry.command,
      project,
      directory: entry.path === undefined ? rootOf(root, project) : join(root, entry.path),
      location: entry.path ?? project.id,
      warnSeconds: entry.warn_seconds,
      environment: selectedEnvironment,
      dockerImage,
      source: sources.get(entry.name) ?? `project: ${projectSource}`,
    };
  });
  readCheckOrder(root, checks);
  return checks;
}

function wrapped(
  directory: string,
  selected: CheckEnvironment,
  command: string[],
  repositoryRoot?: string,
  dockerImage?: string,
  builds?: BuildPaths,
  cpus = "1",
  profile?: string,
): string[] {
  if (selected === "native") return command;
  if (selected === "devcontainer") return devcontainerCommand(repositoryRoot ?? directory, directory, command);
  if (process.platform === "win32")
    throw new Error("managed check environments require a POSIX host; use Linux CI from Windows");
  const sharedDistribution = repositoryRoot ? distributionRoot(repositoryRoot) : undefined;
  const environments = process.env.WORKBENCH_ENVIRONMENTS;
  if (environments && (selected === "nix" || selected === "guix")) {
    if (process.env.WORKBENCH_DEVCONTAINER !== "1")
      throw new Error("Prepared environments require the selected container");
    const roots = JSON.parse(readFileSync(join(environments, "roots.json"), "utf8")) as string[];
    const name = repositoryRoot ? relative(repositoryRoot, directory).replaceAll("\\", "/") || "." : ".";
    const index = roots.indexOf(name);
    if (index < 0) throw new Error(`The prepared image does not contain environment '${name}'`);
    const profile = join(environments, String(index));
    return selected === "guix"
      ? [
          join(environments, "runtimes", String(index), "bin/guix"),
          "shell",
          `--profile=${profile}`,
          "--",
          "sh",
          "-eu",
          "-c",
          'export LD_LIBRARY_PATH="$1/lib:$1/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; shift; exec "$@"',
          "workbench-guix-runtime",
          profile,
          ...command,
        ]
      : [
          "nix",
          "--extra-experimental-features",
          "nix-command flakes",
          "--option",
          "flake-registry",
          "",
          "develop",
          "--offline",
          profile,
          "--command",
          ...command,
        ];
  }

  if (selected === "guix") {
    const runtimeRelative = sharedDistribution ? relative(repositoryRoot ?? directory, sharedDistribution) : undefined;
    const externalRuntime =
      runtimeRelative !== undefined &&
      (isAbsolute(runtimeRelative) || runtimeRelative === ".." || runtimeRelative.startsWith(`..${sep}`));
    const channels = guixChannelFile(repositoryRoot ?? directory, directory);
    for (const file of [channels, join(directory, "manifest.scm")]) {
      if (!existsSync(file)) throw new Error(`${file}: Guix check environment needs this input`);
    }
    if (process.env.WORKBENCH_OFFLINE === "1" || process.env.WORKBENCH_PREPARED === "1") {
      if (process.env.WORKBENCH_DEVCONTAINER !== "1")
        throw new Error("Offline Guix execution requires the prepared container");
      const profile = required(
        process.env.WORKBENCH_GUIX_TIME_MACHINE_PROFILE,
        "Offline Guix image must declare its retained time-machine profile",
      );
      return [
        profile + "/bin/guix",
        "shell",
        "--rebuild-cache",
        ...builderCPUArguments("guix", cpus),
        "-m",
        "manifest.scm",
        "--",
        ...command,
      ];
    }
    return [
      ...(sharedDistribution ? ["env", "WORKBENCH_DISTRIBUTION_MATERIALIZED=1"] : []),
      "guix",
      "time-machine",
      "-C",
      channels,
      ...builderCPUArguments("guix", cpus),
      "--",
      "shell",
      // Guix's manifest cache does not observe changes to imported package definitions.
      "--rebuild-cache",
      ...(profile ? [`--root=${profile}`] : []),
      ...builderCPUArguments("guix", cpus),
      "--container",
      "--emulate-fhs",
      "--network",
      "--preserve=^WORKBENCH_PROJECT_ROOT$",
      ...(sharedDistribution
        ? [
            ...(externalRuntime ? [`--expose=${sharedDistribution}`] : []),
            "--preserve=^WORKBENCH_DISTRIBUTION_MATERIALIZED$",
          ]
        : []),
      ...(builds
        ? [`--share=${builds.directory}`, `--share=${builds.dependencyRoots}`, `--share=${builds.pnpmStore}`]
        : []),
      ...(repositoryRoot && resolve(repositoryRoot) !== resolve(directory)
        ? [`--share=${resolve(repositoryRoot)}`]
        : []),
      "-m",
      "manifest.scm",
      "--",
      ...command,
    ];
  }
  for (const file of ["flake.nix", "flake.lock"]) {
    if (!existsSync(join(directory, file))) throw new Error(`${directory}: Nix check environment needs '${file}'`);
  }
  if (selected === "nix-docker") {
    if (!dockerImage) throw new Error("nix-docker requires checks.nix_docker_image");
    const source = resolve(repositoryRoot ?? directory);
    const subdirectory = relative(source, resolve(directory));
    if (subdirectory === ".." || subdirectory.startsWith(`..${sep}`) || isAbsolute(subdirectory))
      throw new Error(`${directory}: check root is outside the project tree`);
    if (source.includes(",") || builds?.directory.includes(",") || builds?.dependencies.includes(","))
      throw new Error("Docker bind mounts do not support commas in source paths");
    const reports = join(directory, "coverage");
    mkdirSync(reports, { recursive: true });
    if (lstatSync(reports).isSymbolicLink()) throw new Error(`${reports}: report output must be a real directory`);
    const owner = `${String(required(process.getuid, "expected process.getuid")())}:${String(required(process.getgid, "expected process.getgid")())}`;
    const digest = required(dockerImage.split("@sha256:")[1], 'expected dockerImage.split("@sha256:")[1]');
    return [
      process.env.WORKBENCH_CI_DOCKER ?? "docker",
      "run",
      "--rm",
      "--mount",
      `type=bind,src=${source},dst=/source,readonly`,
      ...(sharedDistribution
        ? [
            "--mount",
            `type=bind,src=${sharedDistribution},dst=${sharedDistribution},readonly`,
            "--env",
            "WORKBENCH_DISTRIBUTION_MATERIALIZED=1",
          ]
        : []),
      "--mount",
      `type=bind,src=${reports},dst=/reports`,
      ...(builds
        ? [
            "--mount",
            `type=bind,src=${builds.directory},dst=${builds.directory}`,
            "--mount",
            `type=bind,src=${builds.dependencies},dst=${builds.dependencies}`,
            "--mount",
            `type=bind,src=${builds.pnpmStore},dst=${builds.pnpmStore}`,
          ]
        : []),
      "--mount",
      `type=volume,src=workbench-nix-${digest.slice(0, 16)},dst=/nix`,
      "--env",
      "WORKBENCH_PROJECT_ROOT=/work",
      dockerImage,
      "sh",
      "-ceu",
      [
        "mkdir -p /work",
        "tar -C /source --exclude=.git --exclude=node_modules --exclude=.pnpm-store --exclude=target --exclude=build --exclude=coverage --exclude=.venv --exclude=.mypy_cache --exclude=.ruff_cache --exclude=__pycache__ -cf /tmp/workbench-source.tar .",
        "tar -C /work -xf /tmp/workbench-source.tar; rm /tmp/workbench-source.tar",
        'cd "$1"; shift',
        "status=0",
        `nix ${builderCPUArguments("nix", cpus).map(quote).join(" ")} --extra-experimental-features "nix-command flakes" develop --no-update-lock-file --ignore-environment --keep HOME --keep WORKBENCH_PROJECT_ROOT --keep WORKBENCH_DISTRIBUTION_MATERIALIZED --command "$@" || status=$?`,
        // Only report artifacts leave the disposable copy, including on a failed check.
        `if [ -d coverage ]; then cp -R coverage/. /reports/; chown -R ${quote(owner)} /reports; fi`,
        ...(builds ? [`chown -R ${quote(owner)} ${quote(builds.directory)} ${quote(builds.dependencies)}`] : []),
        'exit "$status"',
      ].join("\n"),
      "workbench-nix-docker",
      join("/work", subdirectory),
      // Native package-manager binaries expect the ELF loader at its conventional Linux path.
      // Only the disposable container is changed; the selected Nix shell supplies the loader.
      "sh",
      "-eu",
      "-c",
      [
        'if [ -n "${NIX_CC:-}" ] && [ -f "$NIX_CC/nix-support/dynamic-linker" ]; then',
        '  dynamic_linker=$(cat "$NIX_CC/nix-support/dynamic-linker")',
        "  for library_directory in /lib /lib64; do",
        '    mkdir -p "$library_directory"',
        '    loader_path="$library_directory/${dynamic_linker##*/}"',
        '    if [ ! -e "$loader_path" ]; then ln -s "$dynamic_linker" "$loader_path"; fi',
        "  done",
        "fi",
        ...(builds
          ? [
              "status=0",
              '"$@" || status=$?',
              `node --input-type=module -e ${quote(readFileSync(join(distributionRoot(repositoryRoot ?? directory), "scripts/cache-ownership.mjs"), "utf8"))} -- workbench-cache-ownership ${quote(owner)} ${quote(builds.pnpmStore)} || status=$?`,
              'exit "$status"',
            ]
          : ['exec "$@"']),
      ].join("\n"),
      "workbench-nix-runtime",
      ...command,
    ];
  }
  return [
    "nix",
    ...builderCPUArguments("nix", cpus),
    "--extra-experimental-features",
    "nix-command flakes",
    ...(process.env.WORKBENCH_OFFLINE === "1" ? ["--offline"] : []),
    "develop",
    `path:${directory}`,
    "--no-update-lock-file",
    ...(profile ? ["--profile", profile] : []),
    ...(process.env.WORKBENCH_OFFLINE === "1" || process.env.WORKBENCH_PREPARED === "1"
      ? []
      : ["--ignore-environment", "--keep", "HOME", "--keep", "WORKBENCH_PROJECT_ROOT"]),
    "--command",
    ...command,
  ];
}

export function runCommand(
  directory: string,
  name: string,
  command: string[],
  selected: CheckEnvironment = "native",
  repositoryRoot?: string,
  dockerImage?: string,
  inspectTools = true,
  lockBuild = false,
  compilerSelection: CompilerSelection & { verbose?: boolean } = {},
): void {
  const execute = () => {
    const prepared = prepareCheckCommand(
      directory,
      name,
      command,
      selected,
      repositoryRoot,
      dockerImage,
      inspectTools,
      lockBuild,
      compilerSelection,
    );
    const run = () => {
      prepared.prepare();
      executePreparedCommand(prepared);
    };
    const use = () => {
      if (prepared.builds && prepared.profile && !inSelectedShell(directory, selected))
        withCacheLockSync(prepared.builds.dependencies, run, 0);
      else run();
    };
    if (prepared.builds && lockBuild) withBuildLock(prepared.builds, use);
    else use();
  };
  if (selected === "native" && inspectTools) {
    const tools = repositoryRoot
      ? selectedToolRequirements(
          repositoryRoot,
          relative(repositoryRoot, directory).replaceAll("\\", "/") || ".",
          compilerSelection,
        )
      : undefined;
    withToolCacheUse(execute, tools);
  } else execute();
}

/** Development commands keep the event loop responsive while active work owns its cache locks. */
export async function runCommandAsync(
  cancellation: CheckCancellation,
  directory: string,
  name: string,
  command: string[],
  selected: CheckEnvironment = "native",
  repositoryRoot?: string,
  compilerSelection: CompilerSelection = {},
): Promise<void> {
  const execute = async () => {
    cancellation.checkpoint();
    const prepared = prepareCheckCommand(
      directory,
      name,
      command,
      selected,
      repositoryRoot,
      undefined,
      true,
      false,
      compilerSelection,
    );
    const run = async () => {
      cancellation.checkpoint();
      prepared.prepare();
      await cancellation.execute(prepared.invocation, directory, prepared.env, true);
      cancellation.checkpoint();
    };
    if (prepared.builds && prepared.profile && !inSelectedShell(directory, selected))
      await withCacheLock(prepared.builds.dependencies, run, 0);
    else await run();
  };
  if (selected === "native") {
    const tools = repositoryRoot
      ? selectedToolRequirements(
          repositoryRoot,
          relative(repositoryRoot, directory).replaceAll("\\", "/") || ".",
          compilerSelection,
        )
      : undefined;
    await withToolCacheUseAsync(execute, tools);
  } else await execute();
}

function prepareCheckCommand(
  directory: string,
  name: string,
  command: string[],
  selected: CheckEnvironment = "native",
  repositoryRoot?: string,
  dockerImage?: string,
  inspectTools = true,
  lockBuild = false,
  compilerSelection: CompilerSelection & { verbose?: boolean } = {},
) {
  compilerSelection = { ...compilerSelection, environment: selected };
  const compilerEnv = inspectTools ? compilerEnvironment(directory, compilerSelection) : {};
  const resolved = resolveCheckCommand(
    directory,
    command,
    repositoryRoot ? distributionRoot(repositoryRoot) : undefined,
  );
  const outsideContainer = selected === "devcontainer" && process.env.WORKBENCH_DEVCONTAINER !== "1";
  const checked =
    inspectTools && !outsideContainer
      ? guardToolchains(
          directory,
          resolved,
          selected !== "native" && selected !== "devcontainer",
          compilerSelection,
          !(compilerSelection.verbose ?? process.env.WORKBENCH_VERBOSE === "1"),
        )
      : resolved;
  const builds =
    repositoryRoot && inspectTools ? buildPaths(repositoryRoot, directory, selected, compilerSelection) : undefined;
  const localBuilds =
    builds && !(selected === "devcontainer" && process.env.WORKBENCH_DEVCONTAINER !== "1") ? builds : undefined;
  const profile =
    localBuilds &&
    (selected === "nix" || selected === "guix") &&
    !process.env.WORKBENCH_ENVIRONMENTS &&
    process.env.WORKBENCH_PREPARED !== "1" &&
    process.env.WORKBENCH_OFFLINE !== "1"
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
    ...executionEnvironment(repositoryRoot ?? directory),
    ...(repositoryRoot && selected !== "native" ? policyExecutionEnvironment(repositoryRoot) : {}),
  };
  const native =
    (selected === "native" || (selected === "devcontainer" && !outsideContainer)) && inspectTools && repositoryRoot
      ? nativeCheckEnvironment(
          repositoryRoot,
          directory,
          compilerSelection,
          Number(budget.WORKBENCH_CPU_BUDGET),
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
  const withOutputs = native
    ? managedCommand
    : [
        "env",
        ...Object.entries({
          ...budget,
          ...(repositoryRoot && !outsideContainer
            ? { WORKBENCH_DISTRIBUTION_ROOT: distributionRoot(repositoryRoot) }
            : {}),
          ...(outputPaths ? buildEnvironment(outputPaths) : {}),
          ...compilerEnv,
          ...Object.fromEntries(
            ["WORKBENCH_CI_TARGET", "WORKBENCH_CONTAINER_CHECKOUT", "WORKBENCH_LOCAL_CI_IMAGE"].flatMap((name) =>
              process.env[name] === undefined ? [] : [[name, process.env[name]]],
            ),
          ),
        }).map(([key, value]) => `${key}=${value}`),
        ...managedCommand,
      ];
  const wrappedCommand =
    inspectTools && inSelectedShell(directory, selected)
      ? withOutputs
      : wrapped(
          directory,
          selected,
          withOutputs,
          repositoryRoot,
          dockerImage,
          builds?.external ? builds : undefined,
          budget.WORKBENCH_CPU_BUDGET,
          profile,
        );
  // Git Bash supplies the same command-array semantics for scripts and .cmd tools on Windows.
  const invocation =
    process.platform === "win32" && !native
      ? ["sh", "-eu", "-c", 'exec "$@"', "workbench-command", ...wrappedCommand]
      : wrappedCommand;
  const env: NodeJS.ProcessEnv = native ?? {
    ...process.env,
    ...(repositoryRoot ? { WORKBENCH_PROJECT_ROOT: repositoryRoot } : {}),
    ...budget,
  };
  if (selected === "guix") delete env.GUIX_BUILD_OPTIONS;
  const prepare = () => {
    if (localBuilds) {
      prepareBuild(localBuilds);
      if (profile && !localBuilds.external) prepareBuildDependencies(localBuilds);
      if (profile) {
        prepareManagedProfile(localBuilds, profile);
        if (selected === "guix") releaseGuixEnvironmentRoot(localBuilds.dependencies);
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

function executePreparedCommand(prepared: ReturnType<typeof prepareCheckCommand>): void {
  const { invocation, env, name, directory } = prepared;
  const result = spawnSync(required(invocation[0], "expected invocation[0]"), invocation.slice(1), {
    cwd: directory,
    env,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(`${name} failed with ${String(result.error ?? result.status)}`);
}

export interface CheckInspectionOptions extends CheckSelection {
  json?: boolean;
  all?: boolean;
}

/** Inspection and execution resolve the same stage, setup, environment, and coverage choices. */
export function inspectChecks(root: string, options: CheckSelection = {}) {
  return withDevelopmentSelection(
    root,
    options.environment,
    options.profile,
    () => inspectConfiguredChecks(root, options),
    options.workspace,
  );
}

function inspectConfiguredChecks(root: string, options: CheckSelection) {
  const configured = readChecks(root);
  const environment = executionPreference(root, options.environment, options.profile);
  const plan = planChecks(root, configured, { ...options, ...(environment ? { environment } : {}) });
  const execution = checkExecution(root, plan);
  const describe = (check: ConfiguredCheck, environment: string) => ({
    name: check.name,
    role: check.role,
    path: relative(root, check.directory).replaceAll("\\", "/") || ".",
    environment,
    command: check.command,
    source: check.source,
    stages: check.stages,
    online: check.online,
    requiresSetup: check.requiresSetup,
  });
  return {
    stage: plan.stage ?? null,
    structuralValidation: (options.role?.length ?? 0) === 0 && (options.excludeRole?.length ?? 0) === 0,
    allowEmpty: !!readConfig(root).checks?.allow_empty,
    execution: {
      availableCpus: execution.availableCpus,
      maxJobs: execution.maxJobs,
      sessions: plan.sessions.map((session, index) => ({
        path: relative(root, session.directory).replaceAll("\\", "/") || ".",
        environment: session.environment,
        cpus: required(execution.cpus[index], "missing check CPU allocation"),
        after: (execution.dependencies[index] ?? []).map((dependency) => {
          const predecessor = required(plan.sessions[dependency.session], "missing check dependency");
          return {
            path: relative(root, predecessor.directory).replaceAll("\\", "/") || ".",
            environment: predecessor.environment,
            phase: dependency.phase,
          };
        }),
      })),
    },
    selected: plan.sessions.flatMap((session) => session.checks.map((check) => describe(check, session.environment))),
    excluded: plan.excluded.map(({ check, reason }) => ({
      ...describe(check, environment ?? check.environment),
      reason,
    })),
  };
}

export function listChecks(root: string, options: CheckInspectionOptions = {}): void {
  const plan = inspectChecks(root, options);
  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`Check plan (${plan.stage ?? "manual selection"})`);
  console.log(
    plan.structuralValidation
      ? "Includes structural validation."
      : "Focused role run; structural validation is skipped.",
  );
  if (!plan.selected.length) {
    console.log(
      plan.allowEmpty ? "configured: structural checks only (checks.allow_empty = true)" : "configured: none selected",
    );
  } else {
    const sources = [...new Set(plan.selected.map((check) => check.source ?? "unknown"))];
    console.log(
      terminalTable(
        ["ROOT", "ROLE", "ENVIRONMENT", "CHECK", "SOURCE"],
        plan.selected.map((check) => [
          check.path,
          check.role,
          check.environment,
          check.name,
          String(sources.indexOf(check.source ?? "unknown") + 1),
        ]),
      ),
    );
    for (const [index, source] of sources.entries()) console.log(`${String(index + 1)}: ${source}`);
    console.log(`Up to ${String(plan.execution.maxJobs)} groups share ${String(plan.execution.availableCpus)} CPUs.`);
    for (const session of plan.execution.sessions) {
      const after = session.after.map(
        (dependency) => `${dependency.path} (${dependency.environment}) ${dependency.phase}`,
      );
      console.log(
        `${session.path} (${session.environment}): ${String(session.cpus)} CPUs${after.length ? `; after ${after.join(", ")}` : ""}.`,
      );
    }
  }
  if (options.all && plan.excluded.length) {
    console.log("Excluded checks:");
    console.log(
      terminalTable(
        ["ROOT", "ROLE", "CHECK", "REASON"],
        plan.excluded.map((check) => [check.path, check.role, check.name, check.reason]),
      ),
    );
  } else if (plan.excluded.length)
    console.log(
      `${String(plan.excluded.length)} checks excluded; use ${options.online ? "--json" : "--all or --json"} for details.`,
    );
}

export async function runChecks(
  root: string,
  options: CheckSelection = {},
  validate?: () => Promise<void>,
  recordReport?: (report: CheckRunResult) => void,
): Promise<void> {
  root = realpathSync(root);
  const cancellation = new CheckCancellation();
  try {
    await withCheckCoordination(root, cancellation, async (owner) => {
      await validate?.();
      cancellation.checkpoint();
      await withDevelopmentSelection(
        root,
        options.environment,
        options.profile,
        async () => {
          const plan = configuredCheckPlan(root, options);
          const run = () =>
            withCachedChecks(
              root,
              options,
              plan,
              (selected) => runCheckGroups(root, options, selected, cancellation, owner, recordReport),
              cancellation.signal,
            );
          if (!plan.cleanup && plan.sessions.some((session) => session.environment === "native"))
            await withToolCacheUseAsync(
              run,
              selectedToolRequirements(
                root,
                plan.sessions
                  .filter((session) => session.environment === "native")
                  .map((session) => relative(root, session.directory).replaceAll("\\", "/") || "."),
                options,
              ),
            );
          else await run();
        },
        options.workspace,
      );
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") cancellation.checkpoint();
    throw error;
  } finally {
    cancellation.close();
  }
}

/** Internal worker entry point: a single ordered root/environment session owns its shell and cleanup. */
export async function runCheckSession(
  root: string,
  options: CheckSelection,
  directory: string,
  environment: string,
  control: string,
): Promise<void> {
  validateCheckControl(control);
  const cancellation = new CheckCancellation();
  try {
    await cancellation.waitForStart();
    await runConfiguredChecks(
      root,
      options,
      realpathSync(resolve(root, directory)),
      checkEnvironment(environment, "worker environment"),
      cancellation,
      control,
    );
    cancellation.checkpoint();
  } finally {
    cancellation.close();
  }
}

function configuredCheckPlan(root: string, options: CheckSelection, directory?: string) {
  root = realpathSync(root);
  if (
    (options.compiler !== undefined || options.compilerVersion !== undefined) &&
    options.path === undefined &&
    !directory
  )
    throw new Error("compiler overrides require --path");
  const selectedEnvironment = executionPreference(root, options.environment, options.profile);
  const checks = readChecks(root);
  const plan = planChecks(
    root,
    checks,
    { ...options, ...(selectedEnvironment ? { environment: selectedEnvironment } : {}) },
    directory,
  );
  if (!plan.sessions.length) {
    if (options.role?.length || options.excludeRole?.length || options.path !== undefined || options.project)
      throw new Error(
        `no configured checks ${options.role?.length ? `have roles '${options.role.join(", ")}'` : "selected"} in the selected stage and scope`,
      );
    if (!readConfig(root).checks?.allow_empty)
      throw new Error(
        "no configured check commands for this stage; configure checks or explicitly set checks.allow_empty = true",
      );
    console.log("No configured commands: structural checks only (checks.allow_empty = true).");
  }
  if (!plan.cleanup) for (const session of plan.sessions) inSelectedShell(session.directory, session.environment);
  return plan;
}

async function runConfiguredChecks(
  root: string,
  options: CheckSelection,
  directory: string,
  environment: CheckEnvironment,
  cancellation: CheckCancellation,
  control: string,
): Promise<void> {
  root = realpathSync(root);
  const plan = configuredCheckPlan(root, options, directory);
  plan.sessions = plan.sessions.filter((session) => session.environment === environment);
  if (plan.sessions.length !== 1) throw new Error("check workers require exactly one root/environment group");
  if (options.checkNames) {
    const names = new Set(options.checkNames);
    for (const session of plan.sessions) {
      session.checks = session.checks.filter((check) => names.has(check.name));
      if (session.checks.length !== names.size)
        throw new Error("check worker selection differs from configured checks");
    }
  }
  const total = plan.sessions.reduce((sum, session) => sum + session.checks.length, 0);
  let completed = 0;
  const verbose = options.verbose ?? process.env.WORKBENCH_VERBOSE === "1";
  // Setup and all dependent commands share one session, including disposable environments.
  try {
    for (const { directory, environment, checks: group } of plan.sessions) {
      const logID = randomUUID();
      const launcher = resolveCheckCommand(
        directory,
        ["node", "{workbench}/bin/workbench.mjs"],
        distributionRoot(root),
      );
      const script = [
        ...checkOutputPrelude(total, verbose, logID, control),
        ...(plan.cleanup
          ? [
              [
                ...launcher,
                "build-clean",
                root,
                ...(group.some((entry) => entry.role === "distclean") ? ["--dependencies"] : []),
              ]
                .map(quote)
                .join(" "),
            ]
          : []),
        group
          .flatMap((entry) => {
            const command = resolveCheckCommand(directory, entry.command, distributionRoot(root));
            const setup =
              entry.role === "setup" &&
              (existsSync(join(directory, "package.json")) || existsSync(join(directory, "pyproject.toml")))
                ? [...launcher, "dependency-setup", "--", ...command]
                : command;
            const observed =
              entry.warnSeconds === undefined
                ? setup
                : [...launcher, "observe", String(entry.warnSeconds), "--", ...setup];
            const presentCoverage = entry.role === "coverage";
            const collector = resolveCheckCommand(
              directory,
              ["node", "{workbench}/scripts/check-coverage-summary.mjs"],
              distributionRoot(root),
            )
              .map(quote)
              .join(" ");
            const step = ++completed;
            const body = presentCoverage
              ? ["coverage_status=0", `${observed.map(quote).join(" ")} || coverage_status=$?`]
              : [observed.map(quote).join(" ")];
            const after = presentCoverage
              ? [
                  "workbench_check_replay=$coverage_status",
                  "presentation_status=0",
                  `${collector} "$coverage_status" ${String(Date.now())}${directory === distributionRoot(root) ? " --no-job-summary" : ""} || presentation_status=$?`,
                  '[ "$coverage_status" -eq 0 ] || exit "$coverage_status"',
                  '[ "$presentation_status" -eq 0 ] || exit "$presentation_status"',
                ]
              : [];
            return checkOutput(body, `${entry.name} (${entry.role})`, step, verbose, after);
          })
          .join("\n"),
      ].join("\n");
      const hasCoverage = group.some((entry) => entry.role === "coverage");
      const summaryPath = hasCoverage
        ? ownedPath(directory, "coverage/coverage-summary.json")
        : join(directory, "coverage/coverage-summary.json");
      const previousSummary = hasCoverage && existsSync(summaryPath) ? readFileSync(summaryPath) : undefined;
      let complete = false;
      let scriptDirectory: string | undefined;
      try {
        // MSYS and native Windows processes use different command-line quoting.
        // A script file preserves literal backslashes and quotes in configured commands.
        let invocation = ["sh", "-eu", "-c", script];
        if (process.platform === "win32") {
          scriptDirectory = mkdtempSync(join(tmpdir(), "workbench-check-session-"));
          const path = join(scriptDirectory, "checks.sh");
          writeFileSync(path, script);
          invocation = ["sh", "-eu", path.replaceAll("\\", "/")];
        }
        const execute = async () => {
          cancellation.checkpoint();
          const prepared = prepareCheckCommand(
            directory,
            `checks in '${required(group[0], "expected group[0]").location}' (${environment})`,
            invocation,
            environment,
            root,
            required(group[0], "expected group[0]").dockerImage,
            !plan.cleanup,
            !plan.cleanup,
            options,
          );
          const run = async (owner?: ProcessLock) => {
            cancellation.checkpoint();
            const use = async () => {
              prepared.prepare();
              await cancellation.execute(prepared.invocation, directory, prepared.env, false, owner);
            };
            if (prepared.builds && prepared.profile && !inSelectedShell(directory, environment))
              await withCacheLock(prepared.builds.dependencies, use, 0);
            else await use();
          };
          if (prepared.builds && !plan.cleanup) await withBuildLock(prepared.builds, run);
          else await run();
        };
        if (environment === "native" && !plan.cleanup)
          await withToolCacheUseAsync(
            execute,
            selectedToolRequirements(root, relative(root, directory).replaceAll("\\", "/") || ".", options),
          );
        else await execute();
        complete = true;
      } finally {
        if (scriptDirectory) rmSync(scriptDirectory, { recursive: true, force: true });
        try {
          if (!verbose && environment === "native" && !plan.cleanup) {
            const paths = buildPaths(root, directory, environment, options);
            const logs = join(paths.directory, "check-logs", logID);
            if (existsSync(logs)) {
              const archive = checkLogDirectory(
                paths.storageRoot,
                process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? paths.identity.checkout,
                paths.identity.root,
                logID,
              );
              withCacheLockSync(archive, () => {
                prepareCheckLogs(
                  paths.storageRoot,
                  process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? paths.identity.checkout,
                  paths.identity.root,
                  logID,
                );
                cpSync(logs, archive, { recursive: true });
                rmSync(logs, { recursive: true, force: true });
              });
              console.log(`Full check logs: ${archive}`);
            }
          }
        } catch (error) {
          console.error(`Could not retain check logs: ${String(error)}`);
        }
        if (hasCoverage && !complete) {
          ownedPath(directory, "coverage/coverage-summary.json");
          if (previousSummary) {
            mkdirSync(join(directory, "coverage"), { recursive: true });
            writeFileSync(summaryPath, previousSummary);
          } else rmSync(summaryPath, { force: true });
        }
      }
    }
    console.log(`Passed ${String(total)}/${String(total)} checks.`);
  } finally {
    if (process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1") {
      for (const directory of new Set(plan.sessions.map((session) => session.directory)))
        cleanBuilds(buildPaths(root, directory, "native", {}, false), true);
    }
  }
}
