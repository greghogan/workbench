import { required, isStringArray } from "./values.mjs";
import { guixImageDefinition } from "./pack-guix-image.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { builderVolumes, builderCacheKey, guixChannelFile } from "./managed-contract.mjs";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";

// Builder recipes assemble only declared closures. Verification is a separate fresh-source invocation.
const [builder, image] = process.argv.slice(2);
if ((builder !== "nix" && builder !== "guix") || !image)
  throw new Error("Use prepare-managed-development.mjs nix|guix IMAGE");
const root = process.cwd();
const inputs = process.env.WORKBENCH_IMAGE_INPUTS;
if (!/^[a-f0-9]{64}$/.test(inputs ?? ""))
  throw new Error("Use workbench development prepare to select the image inputs");
const distribution = resolve(import.meta.dirname, "..");
await withManagedProcesses(async (scope) => {
  const run = (args: string[], capture = false, cleanup = false, executable = "docker") =>
    executable === "docker" && args[0] === "build"
      ? scope.run(
          process.execPath,
          [join(distribution, "bin/workbench.mjs"), "buildkit-build", "--", ...args.slice(1)],
          { capture, cleanup },
        )
      : scope.run(executable, args, { capture, cleanup });
  const roots: unknown = JSON.parse(
    await scope.run(process.execPath, [join(distribution, "bin/workbench.mjs"), "managed-image-roots"], {
      capture: true,
      cwd: root,
    }),
  );
  if (!isStringArray(roots) || !roots.length) throw new Error("Prepared managed images need configured language roots");
  const temporary = mkdtempSync(join(tmpdir(), "workbench-managed-image-"));
  scope.defer(() => {
    rmSync(temporary, { recursive: true, force: true });
  });
  const bootstrap = `workbench-builder:${randomUUID()}`;
  const container = `workbench-builder-${randomUUID()}`;
  writeFileSync(join(temporary, "roots.json"), JSON.stringify(roots));
  mkdirSync(join(temporary, "profiles"));
  const installed = await scope.run(builder, ["--version"], { capture: true, missing: true });
  if (installed !== undefined) {
    console.log(`Preparing ${builder} image using the host store`);
    await run(
      [
        join(distribution, "bin/workbench.mjs"),
        "managed-image-prepare",
        builder,
        image,
        join(temporary, "roots.json"),
        temporary,
      ],
      false,
      false,
      process.execPath,
    );
  } else {
    console.log(`Preparing ${builder} image using a Docker builder (${builder} is not installed)`);
    scope.defer(async () => {
      if (await run(["image", "ls", "--quiet", "--filter", `reference=${bootstrap}`], true, true))
        await run(["image", "rm", bootstrap], false, true);
    });
    await run([
      "build",
      "--network=host",
      "--ulimit=nofile=65536:65536",
      "--target",
      "base",
      "--file",
      join(root, ".devcontainer", builder, "Dockerfile"),
      "--tag",
      bootstrap,
      ...(builder === "guix"
        ? [
            "--build-arg",
            `WORKBENCH_GUIX_CHANNELS=${relative(root, guixChannelFile(root, join(root, required(roots[0], "Missing managed root")))).replaceAll("\\", "/")}`,
          ]
        : []),
      root,
    ]);
    const identity = await run(["image", "inspect", "--format", "{{.Id}}", bootstrap], true);
    const cache = builderCacheKey(process.env.WORKBENCH_PREPARATION_OWNER ?? root, builder, process.arch, identity);
    const volumes = builderVolumes(builder, cache);
    for (const volume of volumes) await run(["volume", "create", volume.name]);
    await run(
      [join(distribution, "bin/workbench.mjs"), "managed-builder-record", builder, cache],
      false,
      false,
      process.execPath,
    );
    const mounts = volumes.flatMap(({ name, destination }) => [
      "--mount",
      `type=volume,src=${name},dst=${destination}`,
    ]);
    scope.defer(async () => {
      if (await run(["container", "ls", "--all", "--quiet", "--filter", `name=^/${container}$`], true, true))
        await run(["rm", "--force", container], false, true);
    });
    await run([
      "create",
      "--name",
      container,
      "--cap-add=SYS_ADMIN",
      "--cap-add=NET_ADMIN",
      "--security-opt=seccomp=unconfined",
      "--ulimit=nofile=65536:65536",
      ...mounts,
      "--mount",
      `type=bind,src=${root},dst=/preparation,readonly`,
      "--mount",
      `type=bind,src=${temporary},dst=/output`,
      "--mount",
      `type=bind,src=${distribution},dst=/workbench,readonly`,
      "--env",
      "WORKBENCH_PREPARATION_DISTRIBUTION=/workbench",
      "--env",
      `WORKBENCH_MANAGED_CORES=${String(process.env.WORKBENCH_MANAGED_CORES ?? 1)}`,
      "--env",
      `WORKBENCH_MANAGED_JOBS=${String(process.env.WORKBENCH_MANAGED_JOBS ?? 1)}`,
      "--env",
      "WORKBENCH_ROOTS_FILE=/output/roots.json",
      "--env",
      `WORKBENCH_IMAGE_INPUTS=${String(inputs)}`,
      "--workdir",
      "/preparation",
      "--entrypoint",
      "/bin/sh",
      bootstrap,
      "/preparation/.devcontainer/managed-build.sh",
      builder,
    ]);
    await run(["start", "--attach", container]);
    const status = await run(["inspect", "--format", "{{.State.ExitCode}}", container], true);
    if (status !== "0") throw new Error(`${builder} image assembly failed: exit ${status}`);
    // The builder produces a Docker archive; Docker owns importing its layers and metadata.
    const archive = readFileSync(join(temporary, "image-path"), "utf8").trim();
    if (!archive.startsWith(builder === "guix" ? "/gnu/store/" : "/nix/store/"))
      throw new Error("Builder returned an invalid image store path");
    // Docker cp adds a tar wrapper. Stream its single archive entry to Docker, without a second disk copy.
    const loaded = await run(
      [
        "-o",
        "pipefail",
        "-c",
        'docker cp "$1:$2" - | tar -xO | docker load',
        "workbench-image-import",
        container,
        archive,
      ],
      true,
      false,
      "bash",
    );
    const id = /Loaded image(?: ID)?: (.+)/.exec(loaded)?.[1];
    if (!id) throw new Error("Docker did not report the imported image identity");
    await run(["tag", id, image]);
  }
  if (builder === "guix") {
    const { materialize } = guixImageDefinition(root);
    await run(
      [
        join(distribution, "bin/workbench.mjs"),
        "image-finalize",
        image,
        image,
        ...(materialize.length ? ["--materialize", ...materialize] : []),
      ],
      false,
      false,
      process.execPath,
    );
  }
});
