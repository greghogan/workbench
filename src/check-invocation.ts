import { guixChannelFile } from "../scripts/managed-contract.mjs";
import { required } from "./invariants.js";
import { builderCPUArguments } from "../scripts/cpu-budget.mjs";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { distributionRoot } from "./project-context.js";
import { quote } from "./toolchains.js";
import { devcontainerCommand } from "./devcontainers.js";
import { type CheckEnvironment } from "./environments.js";
import { type BuildPaths } from "./builds.js";

export function checkInvocation(
  directory: string,
  selected: CheckEnvironment,
  command: string[],
  repositoryRoot?: string,
  dockerImage?: string,
  builds?: BuildPaths,
  cpus?: string,
  profile?: string,
): string[] {
  const builderArguments = (builder: string) => (cpus === undefined ? [] : builderCPUArguments(builder, cpus));
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
        ...builderArguments("guix"),
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
      ...builderArguments("guix"),
      "--",
      "shell",
      // Guix's manifest cache does not observe changes to imported package definitions.
      "--rebuild-cache",
      ...(profile ? [`--root=${profile}`] : []),
      ...builderArguments("guix"),
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
        `nix ${builderArguments("nix").map(quote).join(" ")} --extra-experimental-features "nix-command flakes" develop --no-update-lock-file --ignore-environment --keep HOME --keep WORKBENCH_PROJECT_ROOT --keep WORKBENCH_DISTRIBUTION_MATERIALIZED --command "$@" || status=$?`,
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
    ...builderArguments("nix"),
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
