// Generated from verify-managed.mts; edit the TypeScript source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runApptainer } from "./apptainer.mjs";
const [artifact, builder, format, nixImage, containerDockerfile, source] = process.argv.slice(2);
if (!artifact || !builder || !format || !containerDockerfile || !source)
  throw new Error("Specify the artifact, builder, format, image, Dockerfile, and source");
function run(command, args, capture = false) {
  const env = { ...process.env };
  delete env.GUIX_BUILD_OPTIONS;
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${String(result.error ?? (result.stderr === "" ? result.status : (result.stderr ?? result.status)))}`,
    );
  return result.stdout?.trim();
}
const base = /^FROM (\S+@sha256:[0-9a-f]{64})$/m.exec(readFileSync(containerDockerfile, "utf8"))?.[1];
if (!base) throw new Error("verification needs a digest-pinned Linux base");
const mount = `type=bind,src=${resolve(artifact)},dst=/artifacts,readonly`;
if (format === "docker") {
  const image = `workbench-count-${builder}:${builder === "guix" ? "latest" : "local"}`;
  const previous = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" });
  if (previous.status === 0)
    throw new Error(`${image}: existing image must be preserved; remove it explicitly before this verification`);
  let loaded = false;
  try {
    run("docker", ["load", "--input", join(artifact, "docker.tar.gz")]);
    loaded = true;
    assert.equal(run("docker", ["run", "--rm", "--pull=never", "--network=none", image, "a", "banana"], true), "3");
  } finally {
    if (loaded) run("docker", ["image", "rm", image]);
  }
} else if (format === "closure") {
  if (!nixImage || !/@sha256:[0-9a-f]{64}$/.test(nixImage))
    throw new Error("closure verification requires a digest-pinned Nix image");
  assert.equal(
    run(
      "docker",
      [
        "run",
        "--rm",
        "--network=none",
        "--mount",
        mount,
        nixImage,
        "sh",
        "-eu",
        "-c",
        'result=$(nix-store --import < /artifacts/closure.nar | tail -n1); "$result/bin/count" a banana',
      ],
      true,
    ),
    "3",
  );
} else if (["squashfs", "apptainer"].includes(format)) {
  if (builder !== "guix") throw new Error("the reference Apptainer workflow uses a Guix Squashfs pack");
  const args = [
    "exec",
    "--unsquash",
    "--cleanenv",
    "--containall",
    "--no-home",
    "/artifacts/count.squashfs",
    "/bin/count",
    "a",
    "banana",
  ];
  assert.equal(runApptainer(artifact, resolve(source), nixImage, args, true), "3");
} else {
  const script =
    "mkdir /tmp/package; tar -xzf /artifacts/count.tar.gz -C /tmp/package; /tmp/package/bin/count a banana";
  assert.equal(
    run(
      "docker",
      [
        "run",
        "--rm",
        "--network=none",
        "--mount",
        mount,
        ...(builder === "guix" && format === "relocatable" ? ["--security-opt=seccomp=unconfined"] : []),
        ...(builder === "guix" && format === "portable" ? ["--env", "GUIX_EXECUTION_ENGINE=proot"] : []),
        base,
        "sh",
        "-eu",
        "-c",
        script,
      ],
      true,
    ),
    "3",
  );
}
console.log(`Verified ${builder} ${format} package outside the source and builder stores.`);
