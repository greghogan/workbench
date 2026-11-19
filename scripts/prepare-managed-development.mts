import { required, isStringArray, record, records } from "../app/src/core/runtime/values.mjs";
import { guixImageDefinition } from "./pack-guix-image.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { importManagedImage } from "./managed-image-import.mjs";
import {
  PreparationStore,
  builderOwner,
  guixChannelFile,
  managedStorePin,
  type ManagedStorePin,
} from "../app/src/core/execution/environments/managed/managed-contract.mjs";
import { writeAtomic } from "../app/src/core/runtime/file-publication.mjs";
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
const store = process.env.WORKBENCH_PREPARATION_STORE;
if (store !== PreparationStore.System && store !== PreparationStore.Managed)
  throw new Error("Use workbench development prepare to select the preparation store");
if (builder === "nix" && store === PreparationStore.System) process.env.NIX_REMOTE = "daemon";
const distribution = resolve(import.meta.dirname, "..");
const architecture = process.env.WORKBENCH_IMAGE_ARCHITECTURE ?? process.arch;
if (!["x64", "arm64"].includes(architecture)) throw new Error("Unsupported managed image architecture");
// The manager remains native; binfmt executes foreign package builders.
const platform = `linux/${process.arch === "x64" ? "amd64" : "arm64"}`;
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
    await scope.run(process.execPath, [join(distribution, "bin/workbench.mjs"), "image-roots"], {
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
  const result = process.env.WORKBENCH_PREPARATION_RESULT;
  let pin: ManagedStorePin | undefined;
  writeFileSync(join(temporary, "roots.json"), JSON.stringify(roots));
  mkdirSync(join(temporary, "profiles"));
  if (store === PreparationStore.System) {
    console.log(
      `Preparing ${builder} image using the host store at ${builder === "nix" ? "/nix/store" : "/gnu/store"}`,
    );
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
    const channels =
      builder === "guix" ? guixChannelFile(root, join(root, required(roots[0], "Missing managed root"))) : undefined;
    scope.defer(async () => {
      if (await run(["image", "ls", "--quiet", "--filter", `reference=${bootstrap}`], true, true))
        await run(["image", "rm", bootstrap], false, true);
    });
    await run([
      "build",
      ...(builder === "guix" ? ["--no-cache-filter", "base"] : []),
      "--platform",
      platform,
      "--network=host",
      "--ulimit=nofile=65536:65536",
      "--target",
      "base",
      "--file",
      join(root, ".devcontainer", builder, "Dockerfile"),
      "--tag",
      bootstrap,
      ...(channels ? ["--build-arg", `WORKBENCH_GUIX_CHANNELS=${relative(root, channels).replaceAll("\\", "/")}`] : []),
      root,
    ]);
    const identity = await run(["image", "inspect", "--format", "{{.Id}}", bootstrap], true);
    const managed = record(
      JSON.parse(
        await run(
          [join(distribution, "bin/workbench.mjs"), "managed-builder-store", builder, identity],
          true,
          false,
          process.execPath,
        ),
      ),
      "Invalid managed builder store",
    );
    const { key, directory } = managed;
    if (typeof key !== "string" || typeof directory !== "string") throw new Error("Invalid managed builder identity");
    console.log(`Preparing ${builder} image using the managed Docker store at ${directory}`);
    const volumes = records(managed.volumes, "Invalid managed builder volumes");
    const mounts = volumes.flatMap(({ name, destination }) => {
      if (typeof name !== "string" || typeof destination !== "string") throw new Error("Invalid managed builder mount");
      return ["--mount", `type=volume,src=${name},dst=${destination}`];
    });
    scope.defer(async () => {
      if (await run(["container", "ls", "--all", "--quiet", "--filter", `name=^/${container}$`], true, true))
        await run(["rm", container], false, true);
    });
    scope.defer(async () => {
      if (await run(["container", "ls", "--all", "--quiet", "--filter", `name=^/${container}$`], true, true))
        await run(["stop", container], false, true);
    }, "shutdown");
    await run([
      "create",
      "--platform",
      platform,
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
      "--env",
      `WORKBENCH_IMAGE_ARCHITECTURE=${architecture}`,
      "--env",
      `WORKBENCH_PRIVATE_BUILDER=${key}`,
      "--env",
      `WORKBENCH_PREPARATION_OWNER=${process.env.WORKBENCH_PREPARATION_OWNER ?? builderOwner(root)}`,
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
    if (result) {
      pin = managedStorePin(JSON.parse(readFileSync(join(temporary, "store-pin.json"), "utf8")));
      if (pin.builder !== builder || pin.key !== key) throw new Error("Builder reported a different store pin");
    }
    await importManagedImage(scope, archive, image, container);
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
  if (result && pin) writeAtomic(result, JSON.stringify(pin) + "\n", 0o600);
});
