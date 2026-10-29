import { isMainScript } from "./script-entry.mjs";
import { capturedText, record, required } from "./values.mjs";

import { guixChannelFile } from "./managed-contract.mjs";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  function run(command: string, args: readonly string[], stdout: "pipe" | "inherit" | number = "inherit") {
    const options = {
      env,
      cwd: source,
      stdio: [stdout === "pipe" ? "ignore" : "inherit", stdout, "inherit"],
      encoding: "utf8",
      shell: false,
    } satisfies SpawnSyncOptionsWithStringEncoding;
    const child = spawnSync(command, args, options);
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
      run("guix", [...arguments_, "build", ...builderCPUArguments("guix", cpus), "-f", "package.scm"], "pipe"),
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
        "pipe",
      ),
      "gnu",
    );
    copyFileSync(pack, join(output, "package.tar.gz"));
  } else {
    if (!nixImage || !/@sha256:[a-f0-9]{64}$/.test(nixImage))
      throw new Error("Nix execution requires a digest-pinned builder image");
    if ([source, output].some((path) => path.includes(","))) throw new Error("Docker mounts cannot contain commas");
    const hostNix = spawnSync("nix", ["--version"], { env, stdio: "ignore" }).status === 0;
    const execute = (command: "nix" | "nix-store", args: readonly string[], stdout: "pipe" | number) =>
      hostNix
        ? run(command, args, stdout)
        : run(
            "docker",
            [
              "run",
              "--rm",
              "--network=host",
              "--mount",
              `type=bind,src=${source},dst=/source,readonly`,
              "--mount",
              `type=volume,src=workbench-nix-${required(nixImage.split("@sha256:")[1], "Missing Nix image digest").slice(0, 16)},dst=/nix`,
              nixImage,
              command,
              ...args,
            ],
            stdout,
          );
    packagePath = storePath(
      execute(
        "nix",
        [
          ...builderCPUArguments("nix", cpus),
          "--extra-experimental-features",
          "nix-command flakes",
          "build",
          "--no-update-lock-file",
          "--no-link",
          "--print-out-paths",
          `path:${hostNix ? pathToFileURL(source).pathname : "/source"}#default`,
        ],
        "pipe",
      ),
      "nix",
    );
    const paths = execute("nix-store", ["--query", "--requisites", packagePath], "pipe")
      .split(/\r?\n/)
      .map((path) => storePath(path, "nix"));
    if (!paths.includes(packagePath)) throw new Error("Nix closure does not contain the selected package");
    const archive = openSync(join(output, "closure.nar"), "w");
    try {
      execute("nix-store", ["--export", ...paths], archive);
    } finally {
      closeSync(archive);
    }
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, "managed-release.json"),
    JSON.stringify({ version: 1, builder, package: packagePath, check }, null, 2) + "\n",
  );
  console.log(`Prepared ${builder} package ${basename(packagePath)}`);
}

if (isMainScript(import.meta.url))
  prepareManagedPackage(
    required(process.argv[2], "Missing managed builder"),
    process.argv[3],
    process.argv[4],
    process.argv[5],
  );
