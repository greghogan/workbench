import { required, isStringArray, record, records } from "../app/src/core/runtime/values.mjs";
import { guixImageDefinition } from "./pack-guix-image.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { importManagedImage } from "./managed-image-import.mjs";
import { guixBootstrapContract, guixBootstrapDockerfile, guixBootstrapProgram } from "./managed-files.mjs";
import {
  PreparationStore,
  builderOwner,
  guixChannelFile,
  managedStorePin,
  mountFields,
  type ManagedStorePin,
} from "../app/src/core/execution/environments/managed/managed-contract.mjs";
import { writeAtomic } from "../app/src/core/runtime/file-publication.mjs";
import { managedProfileArchive } from "../app/src/core/execution/environments/managed/profile-transfer.mjs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";

// Builder recipes assemble only declared closures. Verification is a separate fresh-source invocation.
const exporting = process.env.WORKBENCH_MANAGED_PROFILE_EXPORT === "1";
const [builder, destination] = process.argv.slice(2);
if ((builder !== "nix" && builder !== "guix") || !destination)
  throw new Error("Use prepare-managed-development.mjs nix|guix DESTINATION");
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
declare const __workbenchGuixBootstrapContract: string;

function guixBootstrapContext(root: string, channels: string, context: string) {
  const dockerfilePath = join(root, guixBootstrapDockerfile),
    bootstrapPath = join(root, guixBootstrapProgram);
  if (!existsSync(dockerfilePath) || !existsSync(bootstrapPath)) return;
  const dockerfile = readFileSync(dockerfilePath);
  const bootstrap = readFileSync(bootstrapPath);
  const contract = guixBootstrapContract(dockerfile, bootstrap);
  // Only the standard, reviewed recipe can build from these three files. Custom recipes keep the full build context.
  if (typeof __workbenchGuixBootstrapContract !== "string" || contract !== __workbenchGuixBootstrapContract) return;
  const definition = readFileSync(channels);
  mkdirSync(join(context, "scripts"), { recursive: true });
  writeFileSync(join(context, "Dockerfile"), dockerfile);
  writeFileSync(join(context, "channels.scm"), definition);
  writeFileSync(join(context, guixBootstrapProgram), bootstrap);
  const channelDigest = createHash("sha256").update(definition).digest("hex");
  const recipe = createHash("sha256")
    .update(JSON.stringify([platform, contract, channelDigest]))
    .digest("hex");
  return { recipe, channelDigest };
}

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
  const temporary = mkdtempSync(join(exporting ? dirname(resolve(destination)) : tmpdir(), ".workbench-managed-"));
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
      `Preparing ${builder} ${exporting ? "profile archive" : "image"} using the host store at ${builder === "nix" ? "/nix/store" : "/gnu/store"}`,
    );
    await run(
      [
        join(distribution, "bin/workbench.mjs"),
        "managed-image-prepare",
        builder,
        destination,
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
    const context = join(temporary, "guix-bootstrap");
    const standard = channels ? guixBootstrapContext(root, channels, context) : undefined;
    const recipe = standard?.recipe;
    const resolveStore = async (identity?: string): Promise<unknown> =>
      JSON.parse(
        await run(
          [
            join(distribution, "bin/workbench.mjs"),
            "managed-builder-store",
            builder,
            ...(identity ? [identity] : []),
            ...(recipe ? ["--recipe", recipe] : []),
          ],
          true,
          false,
          process.execPath,
        ),
      );
    const reused = recipe && process.env.WORKBENCH_REFRESH_GUIX_BOOTSTRAP !== "1" ? await resolveStore() : null;
    let bootstrapImage = bootstrap;
    let selected = reused;
    if (reused !== null) {
      const reusedStore = record(reused, "Invalid reused Guix bootstrap");
      if (typeof reusedStore.image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(reusedStore.image))
        throw new Error("Managed Guix reuse requires an immutable bootstrap image");
      bootstrapImage = reusedStore.image;
      console.log(`Reusing the verified Guix bootstrap ${bootstrapImage}`);
    } else {
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
        recipe ? join(context, "Dockerfile") : join(root, ".devcontainer", builder, "Dockerfile"),
        "--tag",
        bootstrap,
        ...(recipe ? ["--label", `org.workbench.guix-bootstrap=${recipe}`] : []),
        ...(channels && !recipe
          ? ["--build-arg", `WORKBENCH_GUIX_CHANNELS=${relative(root, channels).replaceAll("\\", "/")}`]
          : []),
        recipe ? context : root,
      ]);
      selected = await resolveStore(await run(["image", "inspect", "--format", "{{.Id}}", bootstrap], true));
    }
    const managed = record(selected, "Invalid managed builder store");
    const { key, directory } = managed;
    if (typeof key !== "string" || typeof directory !== "string") throw new Error("Invalid managed builder identity");
    console.log(
      `Preparing ${builder} ${exporting ? "profile archive" : "image"} using the managed Docker store at ${directory}`,
    );
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
      mountFields("type=bind", `src=${root}`, "dst=/preparation", "readonly"),
      "--mount",
      mountFields("type=bind", `src=${temporary}`, "dst=/output"),
      "--mount",
      mountFields("type=bind", `src=${distribution}`, "dst=/workbench", "readonly"),
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
      `WORKBENCH_ARTIFACT_KIND=${process.env.WORKBENCH_ARTIFACT_KIND ?? "development"}`,
      ...(exporting ? ["--env", "WORKBENCH_MANAGED_PROFILE_EXPORT=1"] : []),
      "--env",
      `WORKBENCH_PRIVATE_BUILDER=${key}`,
      ...(standard ? ["--env", `WORKBENCH_GUIX_BOOTSTRAP_CHANNELS=${standard.channelDigest}`] : []),
      "--env",
      `WORKBENCH_PREPARATION_OWNER=${process.env.WORKBENCH_PREPARATION_OWNER ?? builderOwner(root)}`,
      "--workdir",
      "/preparation",
      "--entrypoint",
      "/bin/sh",
      bootstrapImage,
      "/preparation/.devcontainer/managed-build.sh",
      builder,
    ]);
    await run(["start", "--attach", container]);
    const status = await run(["inspect", "--format", "{{.State.ExitCode}}", container], true);
    if (status !== "0") throw new Error(`${builder} preparation failed: exit ${status}`);
    if (!exporting) {
      // The builder produces a Docker archive; Docker owns importing its layers and metadata.
      const archive = readFileSync(join(temporary, "image-path"), "utf8").trim();
      if (!archive.startsWith(builder === "guix" ? "/gnu/store/" : "/nix/store/"))
        throw new Error("Builder returned an invalid image store path");
      if (result) {
        pin = managedStorePin(JSON.parse(readFileSync(join(temporary, "store-pin.json"), "utf8")));
        if (pin.builder !== builder || pin.key !== key) throw new Error("Builder reported a different store pin");
      }
      await importManagedImage(scope, archive, destination, container);
    }
  }
  if (exporting) {
    linkSync(join(temporary, managedProfileArchive), destination);
    return;
  }
  if (builder === "guix") {
    const { materialize } = guixImageDefinition(root);
    await run(
      [
        join(distribution, "bin/workbench.mjs"),
        "image-finalize",
        destination,
        destination,
        ...(materialize.length ? ["--materialize", ...materialize] : []),
      ],
      false,
      false,
      process.execPath,
    );
  }
  if (result && pin) writeAtomic(result, JSON.stringify(pin) + "\n", 0o600);
});
