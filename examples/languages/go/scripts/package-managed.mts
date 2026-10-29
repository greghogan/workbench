import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { builderCPUArguments } from "./resources.mjs";

const [builder, format, nixImage] = process.argv.slice(2);
if (!format) throw new Error("Specify the release package format");
const output = process.env.WORKBENCH_RELEASE_OUTPUT;
if (!output) throw new Error("use workbench release prepare to supply a private output directory");
function run(command: string, args: readonly string[], capture = false) {
  const env = { ...process.env };
  delete env.GUIX_BUILD_OPTIONS;
  const result: import("node:child_process").SpawnSyncReturns<string | null> = spawnSync(command, args, {
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${String(result.error ?? result.status)}`);
  return result.stdout?.trim();
}
if (builder === "nix" || builder === "nix-docker") {
  if (!["closure", "portable", "docker"].includes(format)) throw new Error("unsupported Nix package format");
  const attribute = format === "closure" ? "default" : format;
  const script = [
    "result=$(nix " +
      builderCPUArguments("nix").join(" ") +
      ' --extra-experimental-features "nix-command flakes" build --no-update-lock-file --no-link --print-out-paths "path:$1#' +
      attribute +
      '")',
    ...(format === "closure"
      ? [
          'nix-store --query --requisites "$result" > "$2/store-paths.txt"',
          'xargs nix-store --export < "$2/store-paths.txt" > "$2/closure.nar"',
        ]
      : ['cp -L "$result" "$2/' + (format === "portable" ? "count.tar.gz" : "docker.tar.gz") + '"']),
    ...(builder === "nix-docker" ? ['chown -R "$3" "$2"'] : []),
  ].join("\n");
  if (builder === "nix-docker") {
    if (!nixImage || !/@sha256:[0-9a-f]{64}$/.test(nixImage))
      throw new Error("Nix Docker packaging requires a digest-pinned image");
    const source = resolve(".");
    if ([source, output].some((path) => path.includes(","))) throw new Error("Docker mounts cannot contain commas");
    if (!process.getuid || !process.getgid) throw new Error("Nix Docker packaging requires Unix user identities");
    run(process.env.WORKBENCH_CI_DOCKER ?? "docker", [
      "run",
      "--rm",
      "--network=host",
      "--mount",
      `type=bind,src=${source},dst=/source,readonly`,
      "--mount",
      `type=bind,src=${output},dst=/output`,
      "--mount",
      `type=volume,src=workbench-nix-${nixImage.slice(nixImage.indexOf("@sha256:") + 8, nixImage.indexOf("@sha256:") + 24)},dst=/nix`,
      nixImage,
      "sh",
      "-eu",
      "-c",
      script,
      "workbench-package",
      "/source",
      "/output",
      `${String(process.getuid())}:${String(process.getgid())}`,
    ]);
  } else run("sh", ["-eu", "-c", script, "workbench-package", resolve("."), output]);
} else if (builder === "guix") {
  if (!["tarball", "relocatable", "portable", "docker", "squashfs", "apptainer"].includes(format))
    throw new Error("unsupported Guix package format");
  const packFormat = ["squashfs", "apptainer"].includes(format)
    ? "squashfs"
    : format === "docker"
      ? "docker"
      : "tarball";
  const artifact = run(
    "guix",
    [
      "time-machine",
      "-C",
      lstatSync("channels.scm", { throwIfNoEntry: false })
        ? resolve("channels.scm")
        : resolve(process.env.WORKBENCH_PROJECT_ROOT ?? ".", "channels.scm"),
      ...builderCPUArguments("guix"),
      "--",
      "pack",
      ...builderCPUArguments("guix"),
      "-f",
      packFormat,
      ...(format === "relocatable" ? ["-R"] : format === "portable" ? ["-RR"] : []),
      ...(format === "docker" ? ["--image-tag=workbench-count-guix", "--entry-point=bin/count"] : []),
      "-S",
      "/bin=bin",
      "-m",
      "release-manifest.scm",
    ],
    true,
  )
    ?.split("\n")
    .at(-1);
  if (!artifact?.startsWith("/gnu/store/")) throw new Error("Guix did not return a store artifact");
  copyFileSync(
    artifact,
    join(output, packFormat === "squashfs" ? "count.squashfs" : format === "docker" ? "docker.tar.gz" : "count.tar.gz"),
  );
} else throw new Error("select nix, nix-docker, or guix");
