import { capturedText } from "./values.mjs";
import { record, required } from "./values.mjs";
import { guixChannelFile } from "./managed-contract.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { builderCPUArguments, cpuBudget } from "./cpu-budget.mjs";

export function prepareManagedPackage(
  builder: string,
  nixImage: string | undefined,
  output = process.env.WORKBENCH_RELEASE_OUTPUT,
  source = resolve("."),
) {
  if (!output || !["nix", "guix"].includes(builder)) throw new Error("Use a configured Nix or Guix release profile");
  mkdirSync(output, { recursive: true });
  const cpus = cpuBudget();
  const env = { ...process.env };
  delete env.GUIX_BUILD_OPTIONS;
  function run(command: string, args: readonly string[], capture = false, options = {}) {
    const child = spawnSync(command, args, {
      env,
      cwd: source,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      encoding: "utf8",
      ...options,
    });
    if (child.error || child.status !== 0)
      throw new Error(`${command} failed: ${String(child.error ?? (child.stderr || child.status))}`);
    return capturedText(child.stdout).trim();
  }
  function storePath(value: string, prefix: string) {
    if (!new RegExp(`^/${prefix}/store/[a-z0-9]{32}-[A-Za-z0-9+._-]+$`).test(value))
      throw new Error(`Expected one immutable ${prefix} package output: ${value}`);
    return value;
  }
  const check = record(
    JSON.parse(readFileSync(join(source, "managed-release-check.json"), "utf8")),
    "Invalid managed release check",
  );
  let packagePath;
  if (builder === "guix") {
    const arguments_ = [
      "time-machine",
      "-C",
      guixChannelFile(process.env.WORKBENCH_PROJECT_ROOT ?? source, source),
      ...builderCPUArguments("guix", cpus),
      "--",
    ];
    packagePath = storePath(
      run("guix", [...arguments_, "build", ...builderCPUArguments("guix", cpus), "-f", "package.scm"], true),
      "gnu",
    );
    const pack = storePath(
      run(
        "guix",
        [
          ...arguments_,
          "pack",
          ...builderCPUArguments("guix", cpus),
          "-RR",
          "--compression=gzip",
          ...(check.site ? [] : ["-S", "/bin=bin"]),
          "-m",
          "release-manifest.scm",
        ],
        true,
      ),
      "gnu",
    );
    copyFileSync(pack, join(output, "package.tar.gz"));
  } else {
    if (!nixImage || !/@sha256:[a-f0-9]{64}$/.test(nixImage))
      throw new Error("Nix execution requires a digest-pinned builder image");
    if ([source, output].some((path) => path.includes(","))) throw new Error("Docker mounts cannot contain commas");
    const script = [
      `result=$(nix ${builderCPUArguments("nix", cpus).join(" ")} --extra-experimental-features "nix-command flakes" build --no-update-lock-file --no-link --print-out-paths "$1#default")`,
      'printf "%s" "$result" > "$2/package-path.txt"',
      'nix-store --query --requisites "$result" > "$2/store-paths.txt"',
      'xargs nix-store --export < "$2/store-paths.txt" > "$2/closure.nar"',
      'chown -R "$3" "$2"',
    ].join("\n");
    if (spawnSync("nix", ["--version"], { env, stdio: "ignore" }).status === 0) {
      run("sh", [
        "-eu",
        "-c",
        script,
        "workbench-package",
        `path:${source}`,
        resolve(output),
        `${String(required(process.getuid, "Managed packaging requires a POSIX uid")())}:${String(required(process.getgid, "Managed packaging requires a POSIX gid")())}`,
      ]);
    } else
      run(process.env.WORKBENCH_CI_DOCKER ?? "docker", [
        "run",
        "--rm",
        "--network=host",
        "--mount",
        `type=bind,src=${source},dst=/source,readonly`,
        "--mount",
        `type=bind,src=${resolve(output)},dst=/output`,
        "--mount",
        `type=volume,src=workbench-nix-${required(nixImage.split("@sha256:")[1], "Missing Nix image digest").slice(0, 16)},dst=/nix`,
        nixImage,
        "sh",
        "-eu",
        "-c",
        script,
        "workbench-package",
        "path:/source",
        "/output",
        `${String(required(process.getuid, "Managed packaging requires a POSIX uid")())}:${String(required(process.getgid, "Managed packaging requires a POSIX gid")())}`,
      ]);
    packagePath = storePath(readFileSync(join(output, "package-path.txt"), "utf8"), "nix");
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, "managed-release.json"),
    JSON.stringify({ version: 1, builder, package: packagePath, check }, null, 2) + "\n",
  );
  if (builder === "nix") rmSync(join(output, "package-path.txt"));
  console.log(`Prepared ${builder} package ${basename(packagePath)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  prepareManagedPackage(
    required(process.argv[2], "Missing managed builder"),
    process.argv[3],
    process.argv[4],
    process.argv[5],
  );
