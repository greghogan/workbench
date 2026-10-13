import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";

// Project-owned recipe: retain toolchains and dependency inputs, then prove a fresh offline build.
const [builder, option] = process.argv.slice(2);
if (!["native", "nix", "guix"].includes(builder) || (option && option !== "--verify"))
  throw new Error("Use prepare-development.mjs native|nix|guix [--verify]");
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "bin/workbench.mjs");
const verify = option === "--verify";
function run(command, args, cwd = root) {
  const quiet = !verify && args[1] === "tools" && args[2] === "install";
  const log = "/tmp/workbench-tool-install.log";
  const output = quiet ? openSync(log, "w") : undefined;
  if (quiet) console.log(`Preparing verified native tools (${args.slice(3).join(" ")})...`);
  let child;
  try {
    child = spawnSync(command, args, {
      cwd,
      stdio: output === undefined ? "inherit" : ["ignore", output, output],
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: root },
    });
  } finally {
    if (output !== undefined) closeSync(output);
  }
  if (child.error || child.status !== 0) {
    if (quiet) spawnSync("tail", ["-n", "100", log], { stdio: "inherit" });
    throw new Error(`${command} failed: ${child.error ?? child.status}`);
  }
}
const matrix = JSON.parse(execFileSync(process.execPath, [cli, "checks", "matrix"], { cwd: root, encoding: "utf8" }));
const paths = [...new Set(matrix.native.include.map((entry) => entry.path))];
if (!verify && builder === "native") {
  run(process.execPath, [cli, "tools", "install", "--exclude-tool", "miri"]);
  for (const name of [...new Set(matrix.native.include.map((entry) => entry.toolchain).filter(Boolean))])
    run(process.execPath, [cli, "tools", "install", "--toolchain", name, "--exclude-tool", "miri"]);
}
for (const [index, path] of paths.entries()) {
  const directory = join(root, path);
  console.log(`::group::${verify ? "Offline verification" : "Prepare"}: ${builder} ${path}`);
  if (!verify && builder === "nix") {
    mkdirSync("/opt/workbench/shells", { recursive: true });
    run("nix", [
      "--extra-experimental-features",
      "nix-command flakes",
      "flake",
      "archive",
      "--no-update-lock-file",
      `path:${directory}`,
    ]);
    run("nix", [
      "--extra-experimental-features",
      "nix-command flakes",
      "develop",
      "--no-update-lock-file",
      "--profile",
      `/opt/workbench/shells/${index}`,
      `path:${directory}`,
      "--command",
      "true",
    ]);
  }
  if (!verify && builder === "nix" && index === 0) {
    // Locked native package-manager dependencies need the conventional ELF loader in this disposable image.
    run("nix", [
      "--extra-experimental-features",
      "nix-command flakes",
      "develop",
      "--no-update-lock-file",
      `path:${directory}`,
      "--command",
      "sh",
      "-eu",
      "-c",
      'loader=$(cat "$NIX_CC/nix-support/dynamic-linker"); for dir in /lib /lib64; do mkdir -p "$dir"; test -e "$dir/${loader##*/}" || ln -s "$loader" "$dir/${loader##*/}"; done',
    ]);
  }
  if (!verify && builder === "guix") {
    mkdirSync("/opt/workbench/shells", { recursive: true });
    run("/opt/workbench-guix/bin/guix", [
      "package",
      "-m",
      join(directory, "manifest.scm"),
      "-p",
      `/opt/workbench/shells/${index}`,
    ]);
  }
  for (const role of !verify && path === "." ? ["build"] : ["build", "test"])
    run(process.execPath, [cli, "checks", "run", "--path", path, "--environment", builder, "--role", role]);
  console.log("::endgroup::");
}
