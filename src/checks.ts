import { readDistributionPin } from "./distribution-manifest.js";
import { required } from "./invariants.js";
import { executionEnvironment } from "./execution-resources.js";
import { builderCPUArguments } from "../scripts/cpu-budget.mjs";
import { ownedPath } from "./paths.js";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import { nativeEnvironment } from "./native-tools.js";
import { devcontainerCommand } from "./devcontainers.js";

import {
  checkEnvironment,
  executionPreference,
  inSelectedShell,
  withDevelopmentSelection,
  type CheckEnvironment,
} from "./environments.js";
import { checkPolicy, commandArguments, planChecks, type CheckSelection } from "./check-plan.js";
import { buildPaths, buildEnvironment, prepareBuild, withBuildLock, cleanBuilds, type BuildPaths } from "./builds.js";
import { terminalTable } from "./terminal-table.js";
export type { CheckEnvironment } from "./environments.js";
export interface ConfiguredCheck {
  name: string;
  role: string;
  command: string[];
  project: Project;
  directory: string;
  location: string;
  heavy: boolean;
  warnSeconds: number | undefined;
  environment: CheckEnvironment;
  dockerImage: string | undefined;
  stages: string[];
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
  return definitions.map((entry) => {
    for (const key of Object.keys(entry))
      if (
        ![
          "name",
          "role",
          "project",
          "path",
          "command",
          "stages",
          "heavy",
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
    if (entry.heavy !== undefined && typeof entry.heavy !== "boolean")
      throw new Error(`check '${entry.name}' heavy must be Boolean`);
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
      heavy: !!entry.heavy,
      warnSeconds: entry.warn_seconds,
      environment: selectedEnvironment,
      dockerImage,
      source: sources.get(entry.name) ?? `project: ${projectSource}`,
    };
  });
}

export function available(command: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((directory) => {
    const suffixes = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD").split(";")] : [""];
    return suffixes.some((suffix) => {
      try {
        return statSync(join(directory, command + suffix)).isFile();
      } catch {
        return false;
      }
    });
  });
}

function wrapped(
  directory: string,
  selected: CheckEnvironment,
  command: string[],
  repositoryRoot?: string,
  dockerImage?: string,
  builds?: BuildPaths,
  cpus = "1",
): string[] {
  if (selected === "native") return command;
  if (selected === "devcontainer") return devcontainerCommand(repositoryRoot ?? directory, directory, command);
  if (process.platform === "win32")
    throw new Error("managed check environments require a POSIX host; use Linux CI from Windows");
  const sharedDistribution =
    repositoryRoot && readDistributionPin(repositoryRoot) ? distributionRoot(repositoryRoot) : undefined;
  if (selected === "guix") {
    for (const file of ["channels.scm", "manifest.scm"]) {
      if (!existsSync(join(directory, file))) throw new Error(`${directory}: Guix check environment needs '${file}'`);
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
      "channels.scm",
      ...builderCPUArguments("guix", cpus),
      "--",
      "shell",
      ...builderCPUArguments("guix", cpus),
      "--container",
      "--emulate-fhs",
      "--network",
      "--preserve=^WORKBENCH_PROJECT_ROOT$",
      ...(sharedDistribution
        ? [`--expose=${sharedDistribution}`, "--preserve=^WORKBENCH_DISTRIBUTION_MATERIALIZED$"]
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
  heavy = false,
  selected: CheckEnvironment = "native",
  repositoryRoot?: string,
  dockerImage?: string,
  inspectTools = true,
  lockBuild = false,
  compilerSelection: CompilerSelection = {},
): void {
  const compilerEnv = inspectTools ? compilerEnvironment(directory, compilerSelection) : {};
  const resolved = resolveCheckCommand(
    directory,
    command,
    repositoryRoot ? distributionRoot(repositoryRoot) : undefined,
  );
  const outsideContainer = selected === "devcontainer" && process.env.WORKBENCH_DEVCONTAINER !== "1";
  const checked =
    inspectTools && !outsideContainer
      ? guardToolchains(directory, resolved, selected !== "native" && selected !== "devcontainer", compilerSelection)
      : resolved;
  const builds =
    repositoryRoot && inspectTools ? buildPaths(repositoryRoot, directory, selected, compilerSelection) : undefined;
  const localBuilds =
    builds && !(selected === "devcontainer" && process.env.WORKBENCH_DEVCONTAINER !== "1") ? builds : undefined;
  const outputPaths =
    localBuilds && selected === "nix-docker" && !localBuilds.external
      ? { ...localBuilds, directory: join("/work", relative(repositoryRoot ?? directory, directory), "build") }
      : localBuilds;
  const budget = executionEnvironment(repositoryRoot ?? directory);
  const withOutputs = [
    "env",
    ...Object.entries({
      ...budget,
      ...(outputPaths ? buildEnvironment(outputPaths) : {}),
      ...compilerEnv,
      ...Object.fromEntries(
        ["WORKBENCH_CI_TARGET", "WORKBENCH_CONTAINER_CHECKOUT"].flatMap((name) =>
          process.env[name] === undefined ? [] : [[name, process.env[name]]],
        ),
      ),
    }).map(([key, value]) => `${key}=${value}`),
    ...checked,
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
          budget.WORKBENCH_CPUS,
        );
  // Git Bash supplies the same command-array semantics for scripts and .cmd tools on Windows.
  const invocation =
    process.platform === "win32"
      ? ["sh", "-eu", "-c", 'exec "$@"', "workbench-command", ...wrappedCommand]
      : wrappedCommand;
  const env: NodeJS.ProcessEnv = {
    ...((selected === "native" || (selected === "devcontainer" && process.env.WORKBENCH_DEVCONTAINER === "1")) &&
    inspectTools &&
    repositoryRoot
      ? nativeEnvironment(directory, distributionRoot(repositoryRoot), compilerSelection)
      : process.env),
    ...(repositoryRoot ? { WORKBENCH_PROJECT_ROOT: repositoryRoot } : {}),
    ...budget,
  };
  if (selected === "guix") delete env.GUIX_BUILD_OPTIONS;
  const run = () => {
    if (localBuilds) prepareBuild(localBuilds);
    if (heavy && process.env.WORKBENCH_REQUIRE_BENCHCTL === "1" && !available("benchctl"))
      throw new Error(
        "benchctl is required for heavy checks; run Workbench checks from the host or provide benchctl in this shell",
      );
    if (heavy && available("benchctl")) {
      const submit = spawnSync("benchctl", ["hold", "--format", "text", "--", ...invocation], {
        cwd: directory,
        env,
        encoding: "utf8",
      });
      if (submit.error || submit.status !== 0)
        throw new Error(`${name} could not submit to benchd: ${String(submit.stderr || submit.error)}`);
      const job = submit.stdout.trim();
      if (!/^[0-9a-f]+$/.test(job)) throw new Error(`${name} received an invalid benchd job ID`);
      const follow = spawnSync("benchctl", ["follow", "--format", "text", job], {
        cwd: directory,
        env,
        stdio: "inherit",
      });
      if (follow.error || follow.status !== 0) throw new Error(`${name} failed in benchd job ${job}`);
      return;
    }
    const result = spawnSync(required(invocation[0], "expected invocation[0]"), invocation.slice(1), {
      cwd: directory,
      env,
      stdio: "inherit",
    });
    if (result.error || result.status !== 0)
      throw new Error(`${name} failed with ${String(result.error ?? result.status)}`);
  };
  if (builds && lockBuild) withBuildLock(builds, run);
  else run();
}

export interface CheckInspectionOptions extends CheckSelection {
  json?: boolean;
  all?: boolean;
}

/** Inspection and execution resolve the same stage, setup, environment, and coverage choices. */
export function inspectChecks(root: string, options: CheckSelection = {}) {
  return withDevelopmentSelection(root, options.environment, options.profile, () =>
    inspectConfiguredChecks(root, options),
  );
}

function inspectConfiguredChecks(root: string, options: CheckSelection) {
  const configured = readChecks(root);
  const environment = executionPreference(root, options.environment, options.profile);
  const plan = planChecks(root, configured, { ...options, ...(environment ? { environment } : {}) });
  const describe = (check: ConfiguredCheck, environment: string) => ({
    name: check.name,
    role: check.role,
    path: relative(root, check.directory).replaceAll("\\", "/") || ".",
    environment,
    command: check.command,
    source: check.source,
    heavy: check.heavy,
    stages: check.stages,
  });
  return {
    stage: plan.stage ?? null,
    structuralValidation: !options.role,
    allowEmpty: !!readConfig(root).checks?.allow_empty,
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
    console.log(`${String(plan.excluded.length)} checks excluded; use --all or --json for details.`);
}

export function runChecks(root: string, options: CheckSelection = {}): void {
  withDevelopmentSelection(root, options.environment, options.profile, () => {
    runConfiguredChecks(root, options);
  });
}

function runConfiguredChecks(root: string, options: CheckSelection): void {
  root = realpathSync(root);
  if ((options.compiler !== undefined || options.compilerVersion !== undefined) && options.path === undefined)
    throw new Error("compiler overrides require --path");
  const selectedEnvironment = executionPreference(root, options.environment, options.profile);
  const plan = planChecks(root, readChecks(root), {
    ...options,
    ...(selectedEnvironment ? { environment: selectedEnvironment } : {}),
  });
  if (!plan.sessions.length) {
    if (options.role || options.path !== undefined || options.project)
      throw new Error(
        `no configured checks ${options.role ? `have role '${options.role}'` : "selected"} in the selected stage and scope`,
      );
    if (!readConfig(root).checks?.allow_empty)
      throw new Error(
        "no configured check commands for this stage; configure checks or explicitly set checks.allow_empty = true",
      );
    console.log("No configured commands: structural checks only (checks.allow_empty = true).");
  }
  if (!plan.cleanup) for (const session of plan.sessions) inSelectedShell(session.directory, session.environment);
  // Setup and all dependent commands share one session, including disposable environments.
  try {
    for (const { directory, environment, checks: group } of plan.sessions) {
      const launcher = resolveCheckCommand(
        directory,
        ["node", "{workbench}/bin/workbench.mjs"],
        distributionRoot(root),
      );
      const script = [
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
            const presentCoverage = entry.role === "coverage" && directory !== distributionRoot(root);
            const collector = resolveCheckCommand(
              directory,
              ["node", "{workbench}/scripts/check-coverage-summary.mjs"],
              distributionRoot(root),
            )
              .map(quote)
              .join(" ");
            return [
              `printf '%s\\n' ${quote(`Running configured check '${entry.name}' (${entry.role})...`)}`,
              ...(presentCoverage
                ? [
                    "coverage_status=0",
                    `${observed.map(quote).join(" ")} || coverage_status=$?`,
                    "presentation_status=0",
                    `${collector} "$coverage_status" ${String(Date.now())} || presentation_status=$?`,
                    '[ "$coverage_status" -eq 0 ] || exit "$coverage_status"',
                    '[ "$presentation_status" -eq 0 ] || exit "$presentation_status"',
                  ]
                : [observed.map(quote).join(" ")]),
            ];
          })
          .join("\n"),
      ].join("\n");
      const hasCoverage = group.some((entry) => entry.role === "coverage");
      const summaryPath = hasCoverage
        ? ownedPath(directory, "coverage/coverage-summary.json")
        : join(directory, "coverage/coverage-summary.json");
      const previousSummary = hasCoverage && existsSync(summaryPath) ? readFileSync(summaryPath) : undefined;
      let complete = false;
      try {
        runCommand(
          directory,
          `checks in '${required(group[0], "expected group[0]").location}' (${environment})`,
          ["sh", "-eu", "-c", script],
          group.some((entry) => entry.heavy),
          environment,
          root,
          required(group[0], "expected group[0]").dockerImage,
          !plan.cleanup,
          !plan.cleanup,
          options,
        );
        complete = true;
      } finally {
        if (hasCoverage && !complete) {
          ownedPath(directory, "coverage/coverage-summary.json");
          if (previousSummary) {
            mkdirSync(join(directory, "coverage"), { recursive: true });
            writeFileSync(summaryPath, previousSummary);
          } else rmSync(summaryPath, { force: true });
        }
      }
    }
  } finally {
    if (process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1") {
      for (const directory of new Set(plan.sessions.map((session) => session.directory)))
        cleanBuilds(buildPaths(root, directory, "native", {}, false), true);
    }
  }
}
