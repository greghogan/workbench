import { required } from "./invariants.js";
import { ownedPath } from "./paths.js";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  distributionRoot,
  readConfig,
  readLanguageRoots,
  readProjects,
  rootOf,
  type Project,
  type CheckDefinition,
} from "./core.js";
import { catalog } from "./languages.js";
import { guardToolchains, quote, resolveCheckCommand } from "./toolchains.js";
import { compilerEnvironment, type CompilerSelection } from "./compilers.js";
import { nativeEnvironment } from "./native-tools.js";
import { devcontainerCommand } from "./devcontainers.js";

import { checkEnvironment, executionPreference, inSelectedShell, type CheckEnvironment } from "./environments.js";
import { checkPolicy, commandArguments, planChecks, type CheckSelection } from "./check-plan.js";
import { buildPaths, buildEnvironment, prepareBuild, withBuildLock, cleanBuilds, type BuildPaths } from "./builds.js";
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
  const languages = config.check_suite?.length ? catalog(root) : [];
  const roots = config.check_suite?.length ? readLanguageRoots(root) : [];
  for (const suite of config.check_suite ?? []) {
    if (!roots.some((entry) => entry.language === suite.language && entry.path === suite.path))
      throw new Error(`check_suite: register ${suite.language}@${suite.path} as a language root first`);
    const language = languages.find((entry) => entry.id === suite.language);
    if (!language) throw new Error(`check_suite: unknown language '${suite.language}'`);
    for (const check of language.command)
      definitions.push({ ...check, name: `${suite.path}: ${check.name ?? check.role}`, path: suite.path });
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
    if (!entry.name.trim() || seen.has(entry.name)) throw new Error("every check needs a unique nonempty name");
    seen.add(entry.name);
    const role = entry.role;
    if (!validRole.test(role)) throw new Error(`check '${entry.name}' has an invalid role`);
    commandArguments(entry.command, `check '${entry.name}'`);
    const policy = checkPolicy(entry);
    if (["clean", "distclean", "format-write", "release"].includes(role) && policy.stages.length)
      throw new Error(`${entry.name}: ${role} must be manual-only (stages = [])`);
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
): string[] {
  if (selected === "native") return command;
  if (selected === "devcontainer") return devcontainerCommand(repositoryRoot ?? directory, directory, command);
  if (process.platform === "win32")
    throw new Error("managed check environments require a POSIX host; use Linux CI from Windows");
  if (selected === "guix") {
    for (const file of ["channels.scm", "manifest.scm"]) {
      if (!existsSync(join(directory, file))) throw new Error(`${directory}: Guix check environment needs '${file}'`);
    }
    return [
      "guix",
      "time-machine",
      "-C",
      "channels.scm",
      "--",
      "shell",
      "--container",
      "--emulate-fhs",
      "--network",
      "--preserve=^WORKBENCH_PROJECT_ROOT$",
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
      "docker",
      "run",
      "--rm",
      "--mount",
      `type=bind,src=${source},dst=/source,readonly`,
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
        'nix --extra-experimental-features "nix-command flakes" develop --no-update-lock-file --ignore-environment --keep HOME --keep WORKBENCH_PROJECT_ROOT --command "$@" || status=$?',
        // Only report artifacts leave the disposable copy, including on a failed check.
        `if [ -d coverage ]; then cp -R coverage/. /reports/; chown -R ${quote(owner)} /reports; fi`,
        ...(builds
          ? [
              `chown -R ${quote(owner)} ${quote(builds.directory)} ${quote(builds.dependencies)} ${quote(builds.pnpmStore)}`,
            ]
          : []),
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
        'exec "$@"',
      ].join("\n"),
      "workbench-nix-runtime",
      ...command,
    ];
  }
  return [
    "nix",
    "--extra-experimental-features",
    "nix-command flakes",
    "develop",
    "--no-update-lock-file",
    "--ignore-environment",
    "--keep",
    "HOME",
    "--keep",
    "WORKBENCH_PROJECT_ROOT",
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
  const checked = inspectTools
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
  const withOutputs = outputPaths
    ? [
        "env",
        ...Object.entries({ ...buildEnvironment(outputPaths), ...compilerEnv }).map(
          ([key, value]) => `${key}=${value}`,
        ),
        ...checked,
      ]
    : checked;
  const wrappedCommand =
    inspectTools && inSelectedShell(directory, selected)
      ? withOutputs
      : wrapped(directory, selected, withOutputs, repositoryRoot, dockerImage, builds?.external ? builds : undefined);
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

function containsShell(directory: string, depth = 4): boolean {
  if (depth === 0 || !existsSync(directory)) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isFile() && (extname(entry.name) === ".sh" || entry.name === ".envrc")) return true;
    if (
      entry.isDirectory() &&
      ![".git", ".workbench", "target", "node_modules"].includes(entry.name) &&
      containsShell(path, depth - 1)
    )
      return true;
  }
  return false;
}

export function listChecks(root: string, options: CheckSelection = {}): void {
  if (Object.keys(options).length) {
    const configured = readChecks(root);
    const environment = executionPreference(root, options.environment);
    const plan = planChecks(root, configured, { ...options, ...(environment ? { environment } : {}) });
    console.log(`Check plan (${plan.stage ?? "manual selection"}):`);
    const included = new Set<string>();
    for (const session of plan.sessions) {
      for (const check of session.checks) {
        included.add(check.name);
        console.log(
          `selected: ${check.name} (role: ${check.role}, root: ${check.location}, environment: ${session.environment}): ${check.command.join(" ")}`,
        );
      }
    }
    for (const check of configured)
      if (!included.has(check.name))
        console.log(`excluded: ${check.name} (outside selected stage, role, scope, or target)`);
    return;
  }
  console.log("built-in: Workbench records, maps, generated agent context, and Markdown");
  console.log("adapter checks: pending whitespace, merge markers, private keys, and change messages");
  const languages = catalog(root);
  for (const entry of readLanguageRoots(root)) {
    const id = entry.language;
    const language = languages.find((candidate) => candidate.id === id);
    if (!language) {
      console.log(`language guidance for ${entry.path} (${id}): no built-in reference project`);
      continue;
    }
    console.log(
      `language guidance for ${entry.path} (${language.name}): ${language.summary}; reference: ${language.reference}`,
    );
    for (const check of language.command) {
      console.log(`  recommended role ${check.role}${check.heavy ? ", heavy" : ""}: ${check.command.join(" ")}`);
    }
  }
  for (const project of readProjects(root)) {
    if (containsShell(rootOf(root, project)))
      console.log(`inferred for ${project.id}: shell formatting, syntax, and ShellCheck`);
  }
  const preference = executionPreference(root);
  if (preference) console.log(`local execution selection: ${preference}`);
  const configured = readChecks(root);
  if (!configured.length)
    console.log(
      readConfig(root).checks?.allow_empty
        ? "configured: structural checks only (checks.allow_empty = true)"
        : "configured: none; add [[check]] commands or explicitly set checks.allow_empty = true",
    );
  for (const check of configured) {
    console.log(
      `configured: ${check.name} (role: ${check.role}, root: ${check.location}, ` +
        `environment: ${preference ?? check.environment}, stages: ${check.stages.join(", ") || "manual-only"}${check.heavy ? ", heavy" : ""}): ${check.command.join(" ")}`,
    );
  }
}

export function runChecks(root: string, options: CheckSelection = {}): void {
  if ((options.compiler !== undefined || options.compilerVersion !== undefined) && options.path === undefined)
    throw new Error("compiler overrides require --path");
  const selectedEnvironment = executionPreference(root, options.environment);
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
      const script = [
        ...(plan.cleanup
          ? [
              [
                "node",
                relative(directory, join(distributionRoot(root), "bin/workbench.mjs")),
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
            const launcher = ["node", relative(directory, join(distributionRoot(root), "bin/workbench.mjs"))];
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
            const collector = [
              "node",
              relative(directory, join(distributionRoot(root), "scripts/check-coverage-summary.mjs")),
            ]
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
