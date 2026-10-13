import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { builderCPUArguments } from "./resources.mjs";

// The application's Guix channel need not contain Apptainer. Its runtime comes from the existing locked Nix input.
export function runApptainer(artifact, source, image, args, capture = false) {
  if (!image || !/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error("Apptainer requires a digest-pinned Nix image");
  if ([source, artifact].some((path) => path.includes(","))) throw new Error("Docker mounts cannot contain commas");
  const store = `type=volume,src=workbench-nix-${image.split("@sha256:")[1].slice(0, 16)},dst=/nix`;
  const acquire = spawnSync(
    process.env.WORKBENCH_CI_DOCKER ?? "docker",
    [
      "run",
      "--rm",
      "--mount",
      store,
      "--mount",
      `type=bind,src=${resolve(source)},dst=/source,readonly`,
      image,
      "nix",
      ...builderCPUArguments("nix"),
      "--extra-experimental-features",
      "nix-command flakes",
      "build",
      "--no-update-lock-file",
      "--no-link",
      "--print-out-paths",
      "path:/source#apptainer",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (acquire.error || acquire.status !== 0)
    throw new Error(`Apptainer acquisition failed: ${acquire.error ?? acquire.status}`);
  const tool = acquire.stdout.trim().split("\n").at(-1);
  if (!tool?.startsWith("/nix/store/")) throw new Error("Nix did not return the Apptainer runtime");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--security-opt=seccomp=unconfined",
      "--security-opt=systempaths=unconfined",
      "--env",
      "APPTAINER_USERNS=true",
      "--mount",
      store,
      "--mount",
      `type=bind,src=${resolve(artifact)},dst=/artifacts,readonly`,
      "--workdir",
      "/tmp",
      "--env",
      "APPTAINER_CACHEDIR=/tmp/cache",
      "--env",
      "APPTAINER_CONFIGDIR=/tmp/config",
      image,
      "sh",
      "-eu",
      "-c",
      'if [ ! -e /etc/localtime ]; then rm -f /etc/localtime; touch /etc/localtime; fi; exec "$@"',
      "workbench-apptainer",
      `${tool}/bin/apptainer`,
      ...args,
    ],
    { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" },
  );
  if (result.error || result.status !== 0) throw new Error(`Apptainer failed: ${result.error ?? result.status}`);
  return result.stdout?.trim();
}
