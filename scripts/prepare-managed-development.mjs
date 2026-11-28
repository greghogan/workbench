// Generated from prepare-managed-development.mts; edit the TypeScript source.
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
  mountFields
} from "../app/src/core/execution/environments/managed/managed-contract.mjs";
import { writeAtomic } from "../app/src/core/runtime/file-publication.mjs";
import { managedProfileArchive } from "../app/src/core/execution/environments/managed/profile-transfer.mjs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
const exporting = process.env.WORKBENCH_MANAGED_PROFILE_EXPORT === "1";
const [builder, destination] = process.argv.slice(2);
if (builder !== "nix" && builder !== "guix" || !destination)
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
const platform = `linux/${process.arch === "x64" ? "amd64" : "arm64"}`;
function guixBootstrapContext(root2, channels, context) {
  const dockerfilePath = join(root2, guixBootstrapDockerfile), bootstrapPath = join(root2, guixBootstrapProgram);
  if (!existsSync(dockerfilePath) || !existsSync(bootstrapPath)) return;
  const dockerfile = readFileSync(dockerfilePath);
  const bootstrap = readFileSync(bootstrapPath);
  const contract = guixBootstrapContract(dockerfile, bootstrap);
  if (contract !== "ff2aadfbb952e1942a81ae77b244810a930fef26d207a22baa5c282bb04131dc") return;
  const definition = readFileSync(channels);
  mkdirSync(join(context, "scripts"), { recursive: true });
  writeFileSync(join(context, "Dockerfile"), dockerfile);
  writeFileSync(join(context, "channels.scm"), definition);
  writeFileSync(join(context, guixBootstrapProgram), bootstrap);
  const channelDigest = createHash("sha256").update(definition).digest("hex");
  const recipe = createHash("sha256").update(JSON.stringify([platform, contract, channelDigest])).digest("hex");
  return { recipe, channelDigest };
}
await withManagedProcesses(async (scope) => {
  const run = (args, capture = false, cleanup = false, executable = "docker") => executable === "docker" && args[0] === "build" ? scope.run(
    process.execPath,
    [join(distribution, "bin/workbench.mjs"), "buildkit-build", "--", ...args.slice(1)],
    { capture, cleanup }
  ) : scope.run(executable, args, { capture, cleanup });
  const roots = JSON.parse(
    await scope.run(process.execPath, [join(distribution, "bin/workbench.mjs"), "image-roots"], {
      capture: true,
      cwd: root
    })
  );
  if (!isStringArray(roots) || !roots.length) throw new Error("Prepared managed images need configured language roots");
  const temporary = mkdtempSync(join(exporting ? dirname(resolve(destination)) : tmpdir(), ".workbench-managed-"));
  scope.defer(() => {
    rmSync(temporary, { recursive: true, force: true });
  });
  const bootstrap = `workbench-builder:${randomUUID()}`;
  const container = `workbench-builder-${randomUUID()}`;
  const result = process.env.WORKBENCH_PREPARATION_RESULT;
  let pin;
  writeFileSync(join(temporary, "roots.json"), JSON.stringify(roots));
  mkdirSync(join(temporary, "profiles"));
  if (store === PreparationStore.System) {
    console.log(
      `Preparing ${builder} ${exporting ? "profile archive" : "image"} using the host store at ${builder === "nix" ? "/nix/store" : "/gnu/store"}`
    );
    await run(
      [
        join(distribution, "bin/workbench.mjs"),
        "managed-image-prepare",
        builder,
        destination,
        join(temporary, "roots.json"),
        temporary
      ],
      false,
      false,
      process.execPath
    );
  } else {
    const channels = builder === "guix" ? guixChannelFile(root, join(root, required(roots[0], "Missing managed root"))) : void 0;
    const context = join(temporary, "guix-bootstrap");
    const standard = channels ? guixBootstrapContext(root, channels, context) : void 0;
    const recipe = standard?.recipe;
    const resolveStore = async (identity) => JSON.parse(
      await run(
        [
          join(distribution, "bin/workbench.mjs"),
          "managed-builder-store",
          builder,
          ...identity ? [identity] : [],
          ...recipe ? ["--recipe", recipe] : []
        ],
        true,
        false,
        process.execPath
      )
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
        ...builder === "guix" ? ["--no-cache-filter", "base"] : [],
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
        ...recipe ? ["--label", `org.workbench.guix-bootstrap=${recipe}`] : [],
        ...channels && !recipe ? ["--build-arg", `WORKBENCH_GUIX_CHANNELS=${relative(root, channels).replaceAll("\\", "/")}`] : [],
        recipe ? context : root
      ]);
      selected = await resolveStore(await run(["image", "inspect", "--format", "{{.Id}}", bootstrap], true));
    }
    const managed = record(selected, "Invalid managed builder store");
    const { key, directory } = managed;
    if (typeof key !== "string" || typeof directory !== "string") throw new Error("Invalid managed builder identity");
    console.log(
      `Preparing ${builder} ${exporting ? "profile archive" : "image"} using the managed Docker store at ${directory}`
    );
    const volumes = records(managed.volumes, "Invalid managed builder volumes");
    const mounts = volumes.flatMap(({ name, destination: destination2 }) => {
      if (typeof name !== "string" || typeof destination2 !== "string") throw new Error("Invalid managed builder mount");
      return ["--mount", `type=volume,src=${name},dst=${destination2}`];
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
      ...exporting ? ["--env", "WORKBENCH_MANAGED_PROFILE_EXPORT=1"] : [],
      "--env",
      `WORKBENCH_PRIVATE_BUILDER=${key}`,
      ...standard ? ["--env", `WORKBENCH_GUIX_BOOTSTRAP_CHANNELS=${standard.channelDigest}`] : [],
      "--env",
      `WORKBENCH_PREPARATION_OWNER=${process.env.WORKBENCH_PREPARATION_OWNER ?? builderOwner(root)}`,
      "--workdir",
      "/preparation",
      "--entrypoint",
      "/bin/sh",
      bootstrapImage,
      "/preparation/.devcontainer/managed-build.sh",
      builder
    ]);
    await run(["start", "--attach", container]);
    const status = await run(["inspect", "--format", "{{.State.ExitCode}}", container], true);
    if (status !== "0") throw new Error(`${builder} preparation failed: exit ${status}`);
    if (!exporting) {
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
        ...materialize.length ? ["--materialize", ...materialize] : []
      ],
      false,
      false,
      process.execPath
    );
  }
  if (result && pin) writeAtomic(result, JSON.stringify(pin) + "\n", 384);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVxdWlyZWQsIGlzU3RyaW5nQXJyYXksIHJlY29yZCwgcmVjb3JkcyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBndWl4SW1hZ2VEZWZpbml0aW9uIH0gZnJvbSBcIi4vcGFjay1ndWl4LWltYWdlLm1qc1wiO1xuaW1wb3J0IHsgd2l0aE1hbmFnZWRQcm9jZXNzZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLXByb2Nlc3MubWpzXCI7XG5pbXBvcnQgeyBpbXBvcnRNYW5hZ2VkSW1hZ2UgfSBmcm9tIFwiLi9tYW5hZ2VkLWltYWdlLWltcG9ydC5tanNcIjtcbmltcG9ydCB7IGd1aXhCb290c3RyYXBDb250cmFjdCwgZ3VpeEJvb3RzdHJhcERvY2tlcmZpbGUsIGd1aXhCb290c3RyYXBQcm9ncmFtIH0gZnJvbSBcIi4vbWFuYWdlZC1maWxlcy5tanNcIjtcbmltcG9ydCB7XG4gIFByZXBhcmF0aW9uU3RvcmUsXG4gIGJ1aWxkZXJPd25lcixcbiAgZ3VpeENoYW5uZWxGaWxlLFxuICBtYW5hZ2VkU3RvcmVQaW4sXG4gIG1vdW50RmllbGRzLFxuICB0eXBlIE1hbmFnZWRTdG9yZVBpbixcbn0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vZW52aXJvbm1lbnRzL21hbmFnZWQvbWFuYWdlZC1jb250cmFjdC5tanNcIjtcbmltcG9ydCB7IHdyaXRlQXRvbWljIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL2ZpbGUtcHVibGljYXRpb24ubWpzXCI7XG5pbXBvcnQgeyBtYW5hZ2VkUHJvZmlsZUFyY2hpdmUgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9lbnZpcm9ubWVudHMvbWFuYWdlZC9wcm9maWxlLXRyYW5zZmVyLm1qc1wiO1xuaW1wb3J0IHsgY3JlYXRlSGFzaCwgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbGlua1N5bmMsIG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luLCByZXNvbHZlLCByZWxhdGl2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLy8gQnVpbGRlciByZWNpcGVzIGFzc2VtYmxlIG9ubHkgZGVjbGFyZWQgY2xvc3VyZXMuIFZlcmlmaWNhdGlvbiBpcyBhIHNlcGFyYXRlIGZyZXNoLXNvdXJjZSBpbnZvY2F0aW9uLlxuY29uc3QgZXhwb3J0aW5nID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfUFJPRklMRV9FWFBPUlQgPT09IFwiMVwiO1xuY29uc3QgW2J1aWxkZXIsIGRlc3RpbmF0aW9uXSA9IHByb2Nlc3MuYXJndi5zbGljZSgyKTtcbmlmICgoYnVpbGRlciAhPT0gXCJuaXhcIiAmJiBidWlsZGVyICE9PSBcImd1aXhcIikgfHwgIWRlc3RpbmF0aW9uKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJVc2UgcHJlcGFyZS1tYW5hZ2VkLWRldmVsb3BtZW50Lm1qcyBuaXh8Z3VpeCBERVNUSU5BVElPTlwiKTtcbmNvbnN0IHJvb3QgPSBwcm9jZXNzLmN3ZCgpO1xuY29uc3QgaW5wdXRzID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0lNQUdFX0lOUFVUUztcbmlmICghL15bYS1mMC05XXs2NH0kLy50ZXN0KGlucHV0cyA/PyBcIlwiKSlcbiAgdGhyb3cgbmV3IEVycm9yKFwiVXNlIHdvcmtiZW5jaCBkZXZlbG9wbWVudCBwcmVwYXJlIHRvIHNlbGVjdCB0aGUgaW1hZ2UgaW5wdXRzXCIpO1xuY29uc3Qgc3RvcmUgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUFJFUEFSQVRJT05fU1RPUkU7XG5pZiAoc3RvcmUgIT09IFByZXBhcmF0aW9uU3RvcmUuU3lzdGVtICYmIHN0b3JlICE9PSBQcmVwYXJhdGlvblN0b3JlLk1hbmFnZWQpXG4gIHRocm93IG5ldyBFcnJvcihcIlVzZSB3b3JrYmVuY2ggZGV2ZWxvcG1lbnQgcHJlcGFyZSB0byBzZWxlY3QgdGhlIHByZXBhcmF0aW9uIHN0b3JlXCIpO1xuaWYgKGJ1aWxkZXIgPT09IFwibml4XCIgJiYgc3RvcmUgPT09IFByZXBhcmF0aW9uU3RvcmUuU3lzdGVtKSBwcm9jZXNzLmVudi5OSVhfUkVNT1RFID0gXCJkYWVtb25cIjtcbmNvbnN0IGRpc3RyaWJ1dGlvbiA9IHJlc29sdmUoaW1wb3J0Lm1ldGEuZGlybmFtZSwgXCIuLlwiKTtcbmNvbnN0IGFyY2hpdGVjdHVyZSA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9JTUFHRV9BUkNISVRFQ1RVUkUgPz8gcHJvY2Vzcy5hcmNoO1xuaWYgKCFbXCJ4NjRcIiwgXCJhcm02NFwiXS5pbmNsdWRlcyhhcmNoaXRlY3R1cmUpKSB0aHJvdyBuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBtYW5hZ2VkIGltYWdlIGFyY2hpdGVjdHVyZVwiKTtcbi8vIFRoZSBtYW5hZ2VyIHJlbWFpbnMgbmF0aXZlOyBiaW5mbXQgZXhlY3V0ZXMgZm9yZWlnbiBwYWNrYWdlIGJ1aWxkZXJzLlxuY29uc3QgcGxhdGZvcm0gPSBgbGludXgvJHtwcm9jZXNzLmFyY2ggPT09IFwieDY0XCIgPyBcImFtZDY0XCIgOiBcImFybTY0XCJ9YDtcbmRlY2xhcmUgY29uc3QgX193b3JrYmVuY2hHdWl4Qm9vdHN0cmFwQ29udHJhY3Q6IHN0cmluZztcblxuZnVuY3Rpb24gZ3VpeEJvb3RzdHJhcENvbnRleHQocm9vdDogc3RyaW5nLCBjaGFubmVsczogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcpIHtcbiAgY29uc3QgZG9ja2VyZmlsZVBhdGggPSBqb2luKHJvb3QsIGd1aXhCb290c3RyYXBEb2NrZXJmaWxlKSxcbiAgICBib290c3RyYXBQYXRoID0gam9pbihyb290LCBndWl4Qm9vdHN0cmFwUHJvZ3JhbSk7XG4gIGlmICghZXhpc3RzU3luYyhkb2NrZXJmaWxlUGF0aCkgfHwgIWV4aXN0c1N5bmMoYm9vdHN0cmFwUGF0aCkpIHJldHVybjtcbiAgY29uc3QgZG9ja2VyZmlsZSA9IHJlYWRGaWxlU3luYyhkb2NrZXJmaWxlUGF0aCk7XG4gIGNvbnN0IGJvb3RzdHJhcCA9IHJlYWRGaWxlU3luYyhib290c3RyYXBQYXRoKTtcbiAgY29uc3QgY29udHJhY3QgPSBndWl4Qm9vdHN0cmFwQ29udHJhY3QoZG9ja2VyZmlsZSwgYm9vdHN0cmFwKTtcbiAgLy8gT25seSB0aGUgc3RhbmRhcmQsIHJldmlld2VkIHJlY2lwZSBjYW4gYnVpbGQgZnJvbSB0aGVzZSB0aHJlZSBmaWxlcy4gQ3VzdG9tIHJlY2lwZXMga2VlcCB0aGUgZnVsbCBidWlsZCBjb250ZXh0LlxuICBpZiAodHlwZW9mIF9fd29ya2JlbmNoR3VpeEJvb3RzdHJhcENvbnRyYWN0ICE9PSBcInN0cmluZ1wiIHx8IGNvbnRyYWN0ICE9PSBfX3dvcmtiZW5jaEd1aXhCb290c3RyYXBDb250cmFjdCkgcmV0dXJuO1xuICBjb25zdCBkZWZpbml0aW9uID0gcmVhZEZpbGVTeW5jKGNoYW5uZWxzKTtcbiAgbWtkaXJTeW5jKGpvaW4oY29udGV4dCwgXCJzY3JpcHRzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGNvbnRleHQsIFwiRG9ja2VyZmlsZVwiKSwgZG9ja2VyZmlsZSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihjb250ZXh0LCBcImNoYW5uZWxzLnNjbVwiKSwgZGVmaW5pdGlvbik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihjb250ZXh0LCBndWl4Qm9vdHN0cmFwUHJvZ3JhbSksIGJvb3RzdHJhcCk7XG4gIGNvbnN0IGNoYW5uZWxEaWdlc3QgPSBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShkZWZpbml0aW9uKS5kaWdlc3QoXCJoZXhcIik7XG4gIGNvbnN0IHJlY2lwZSA9IGNyZWF0ZUhhc2goXCJzaGEyNTZcIilcbiAgICAudXBkYXRlKEpTT04uc3RyaW5naWZ5KFtwbGF0Zm9ybSwgY29udHJhY3QsIGNoYW5uZWxEaWdlc3RdKSlcbiAgICAuZGlnZXN0KFwiaGV4XCIpO1xuICByZXR1cm4geyByZWNpcGUsIGNoYW5uZWxEaWdlc3QgfTtcbn1cblxuYXdhaXQgd2l0aE1hbmFnZWRQcm9jZXNzZXMoYXN5bmMgKHNjb3BlKSA9PiB7XG4gIGNvbnN0IHJ1biA9IChhcmdzOiBzdHJpbmdbXSwgY2FwdHVyZSA9IGZhbHNlLCBjbGVhbnVwID0gZmFsc2UsIGV4ZWN1dGFibGUgPSBcImRvY2tlclwiKSA9PlxuICAgIGV4ZWN1dGFibGUgPT09IFwiZG9ja2VyXCIgJiYgYXJnc1swXSA9PT0gXCJidWlsZFwiXG4gICAgICA/IHNjb3BlLnJ1bihcbiAgICAgICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICAgIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJidWlsZGtpdC1idWlsZFwiLCBcIi0tXCIsIC4uLmFyZ3Muc2xpY2UoMSldLFxuICAgICAgICAgIHsgY2FwdHVyZSwgY2xlYW51cCB9LFxuICAgICAgICApXG4gICAgICA6IHNjb3BlLnJ1bihleGVjdXRhYmxlLCBhcmdzLCB7IGNhcHR1cmUsIGNsZWFudXAgfSk7XG4gIGNvbnN0IHJvb3RzOiB1bmtub3duID0gSlNPTi5wYXJzZShcbiAgICBhd2FpdCBzY29wZS5ydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLCBcImltYWdlLXJvb3RzXCJdLCB7XG4gICAgICBjYXB0dXJlOiB0cnVlLFxuICAgICAgY3dkOiByb290LFxuICAgIH0pLFxuICApO1xuICBpZiAoIWlzU3RyaW5nQXJyYXkocm9vdHMpIHx8ICFyb290cy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcIlByZXBhcmVkIG1hbmFnZWQgaW1hZ2VzIG5lZWQgY29uZmlndXJlZCBsYW5ndWFnZSByb290c1wiKTtcbiAgY29uc3QgdGVtcG9yYXJ5ID0gbWtkdGVtcFN5bmMoam9pbihleHBvcnRpbmcgPyBkaXJuYW1lKHJlc29sdmUoZGVzdGluYXRpb24pKSA6IHRtcGRpcigpLCBcIi53b3JrYmVuY2gtbWFuYWdlZC1cIikpO1xuICBzY29wZS5kZWZlcigoKSA9PiB7XG4gICAgcm1TeW5jKHRlbXBvcmFyeSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbiAgY29uc3QgYm9vdHN0cmFwID0gYHdvcmtiZW5jaC1idWlsZGVyOiR7cmFuZG9tVVVJRCgpfWA7XG4gIGNvbnN0IGNvbnRhaW5lciA9IGB3b3JrYmVuY2gtYnVpbGRlci0ke3JhbmRvbVVVSUQoKX1gO1xuICBjb25zdCByZXN1bHQgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUFJFUEFSQVRJT05fUkVTVUxUO1xuICBsZXQgcGluOiBNYW5hZ2VkU3RvcmVQaW4gfCB1bmRlZmluZWQ7XG4gIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wb3JhcnksIFwicm9vdHMuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkocm9vdHMpKTtcbiAgbWtkaXJTeW5jKGpvaW4odGVtcG9yYXJ5LCBcInByb2ZpbGVzXCIpKTtcbiAgaWYgKHN0b3JlID09PSBQcmVwYXJhdGlvblN0b3JlLlN5c3RlbSkge1xuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFByZXBhcmluZyAke2J1aWxkZXJ9ICR7ZXhwb3J0aW5nID8gXCJwcm9maWxlIGFyY2hpdmVcIiA6IFwiaW1hZ2VcIn0gdXNpbmcgdGhlIGhvc3Qgc3RvcmUgYXQgJHtidWlsZGVyID09PSBcIm5peFwiID8gXCIvbml4L3N0b3JlXCIgOiBcIi9nbnUvc3RvcmVcIn1gLFxuICAgICk7XG4gICAgYXdhaXQgcnVuKFxuICAgICAgW1xuICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgXCJtYW5hZ2VkLWltYWdlLXByZXBhcmVcIixcbiAgICAgICAgYnVpbGRlcixcbiAgICAgICAgZGVzdGluYXRpb24sXG4gICAgICAgIGpvaW4odGVtcG9yYXJ5LCBcInJvb3RzLmpzb25cIiksXG4gICAgICAgIHRlbXBvcmFyeSxcbiAgICAgIF0sXG4gICAgICBmYWxzZSxcbiAgICAgIGZhbHNlLFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICApO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IGNoYW5uZWxzID1cbiAgICAgIGJ1aWxkZXIgPT09IFwiZ3VpeFwiID8gZ3VpeENoYW5uZWxGaWxlKHJvb3QsIGpvaW4ocm9vdCwgcmVxdWlyZWQocm9vdHNbMF0sIFwiTWlzc2luZyBtYW5hZ2VkIHJvb3RcIikpKSA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjb250ZXh0ID0gam9pbih0ZW1wb3JhcnksIFwiZ3VpeC1ib290c3RyYXBcIik7XG4gICAgY29uc3Qgc3RhbmRhcmQgPSBjaGFubmVscyA/IGd1aXhCb290c3RyYXBDb250ZXh0KHJvb3QsIGNoYW5uZWxzLCBjb250ZXh0KSA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCByZWNpcGUgPSBzdGFuZGFyZD8ucmVjaXBlO1xuICAgIGNvbnN0IHJlc29sdmVTdG9yZSA9IGFzeW5jIChpZGVudGl0eT86IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT5cbiAgICAgIEpTT04ucGFyc2UoXG4gICAgICAgIGF3YWl0IHJ1bihcbiAgICAgICAgICBbXG4gICAgICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgICAgIFwibWFuYWdlZC1idWlsZGVyLXN0b3JlXCIsXG4gICAgICAgICAgICBidWlsZGVyLFxuICAgICAgICAgICAgLi4uKGlkZW50aXR5ID8gW2lkZW50aXR5XSA6IFtdKSxcbiAgICAgICAgICAgIC4uLihyZWNpcGUgPyBbXCItLXJlY2lwZVwiLCByZWNpcGVdIDogW10pLFxuICAgICAgICAgIF0sXG4gICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICApLFxuICAgICAgKTtcbiAgICBjb25zdCByZXVzZWQgPSByZWNpcGUgJiYgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX1JFRlJFU0hfR1VJWF9CT09UU1RSQVAgIT09IFwiMVwiID8gYXdhaXQgcmVzb2x2ZVN0b3JlKCkgOiBudWxsO1xuICAgIGxldCBib290c3RyYXBJbWFnZSA9IGJvb3RzdHJhcDtcbiAgICBsZXQgc2VsZWN0ZWQgPSByZXVzZWQ7XG4gICAgaWYgKHJldXNlZCAhPT0gbnVsbCkge1xuICAgICAgY29uc3QgcmV1c2VkU3RvcmUgPSByZWNvcmQocmV1c2VkLCBcIkludmFsaWQgcmV1c2VkIEd1aXggYm9vdHN0cmFwXCIpO1xuICAgICAgaWYgKHR5cGVvZiByZXVzZWRTdG9yZS5pbWFnZSAhPT0gXCJzdHJpbmdcIiB8fCAhL15zaGEyNTY6W2EtZjAtOV17NjR9JC8udGVzdChyZXVzZWRTdG9yZS5pbWFnZSkpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIk1hbmFnZWQgR3VpeCByZXVzZSByZXF1aXJlcyBhbiBpbW11dGFibGUgYm9vdHN0cmFwIGltYWdlXCIpO1xuICAgICAgYm9vdHN0cmFwSW1hZ2UgPSByZXVzZWRTdG9yZS5pbWFnZTtcbiAgICAgIGNvbnNvbGUubG9nKGBSZXVzaW5nIHRoZSB2ZXJpZmllZCBHdWl4IGJvb3RzdHJhcCAke2Jvb3RzdHJhcEltYWdlfWApO1xuICAgIH0gZWxzZSB7XG4gICAgICBzY29wZS5kZWZlcihhc3luYyAoKSA9PiB7XG4gICAgICAgIGlmIChhd2FpdCBydW4oW1wiaW1hZ2VcIiwgXCJsc1wiLCBcIi0tcXVpZXRcIiwgXCItLWZpbHRlclwiLCBgcmVmZXJlbmNlPSR7Ym9vdHN0cmFwfWBdLCB0cnVlLCB0cnVlKSlcbiAgICAgICAgICBhd2FpdCBydW4oW1wiaW1hZ2VcIiwgXCJybVwiLCBib290c3RyYXBdLCBmYWxzZSwgdHJ1ZSk7XG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHJ1bihbXG4gICAgICAgIFwiYnVpbGRcIixcbiAgICAgICAgLi4uKGJ1aWxkZXIgPT09IFwiZ3VpeFwiID8gW1wiLS1uby1jYWNoZS1maWx0ZXJcIiwgXCJiYXNlXCJdIDogW10pLFxuICAgICAgICBcIi0tcGxhdGZvcm1cIixcbiAgICAgICAgcGxhdGZvcm0sXG4gICAgICAgIFwiLS1uZXR3b3JrPWhvc3RcIixcbiAgICAgICAgXCItLXVsaW1pdD1ub2ZpbGU9NjU1MzY6NjU1MzZcIixcbiAgICAgICAgXCItLXRhcmdldFwiLFxuICAgICAgICBcImJhc2VcIixcbiAgICAgICAgXCItLWZpbGVcIixcbiAgICAgICAgcmVjaXBlID8gam9pbihjb250ZXh0LCBcIkRvY2tlcmZpbGVcIikgOiBqb2luKHJvb3QsIFwiLmRldmNvbnRhaW5lclwiLCBidWlsZGVyLCBcIkRvY2tlcmZpbGVcIiksXG4gICAgICAgIFwiLS10YWdcIixcbiAgICAgICAgYm9vdHN0cmFwLFxuICAgICAgICAuLi4ocmVjaXBlID8gW1wiLS1sYWJlbFwiLCBgb3JnLndvcmtiZW5jaC5ndWl4LWJvb3RzdHJhcD0ke3JlY2lwZX1gXSA6IFtdKSxcbiAgICAgICAgLi4uKGNoYW5uZWxzICYmICFyZWNpcGVcbiAgICAgICAgICA/IFtcIi0tYnVpbGQtYXJnXCIsIGBXT1JLQkVOQ0hfR1VJWF9DSEFOTkVMUz0ke3JlbGF0aXZlKHJvb3QsIGNoYW5uZWxzKS5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIil9YF1cbiAgICAgICAgICA6IFtdKSxcbiAgICAgICAgcmVjaXBlID8gY29udGV4dCA6IHJvb3QsXG4gICAgICBdKTtcbiAgICAgIHNlbGVjdGVkID0gYXdhaXQgcmVzb2x2ZVN0b3JlKGF3YWl0IHJ1bihbXCJpbWFnZVwiLCBcImluc3BlY3RcIiwgXCItLWZvcm1hdFwiLCBcInt7LklkfX1cIiwgYm9vdHN0cmFwXSwgdHJ1ZSkpO1xuICAgIH1cbiAgICBjb25zdCBtYW5hZ2VkID0gcmVjb3JkKHNlbGVjdGVkLCBcIkludmFsaWQgbWFuYWdlZCBidWlsZGVyIHN0b3JlXCIpO1xuICAgIGNvbnN0IHsga2V5LCBkaXJlY3RvcnkgfSA9IG1hbmFnZWQ7XG4gICAgaWYgKHR5cGVvZiBrZXkgIT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIGRpcmVjdG9yeSAhPT0gXCJzdHJpbmdcIikgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBtYW5hZ2VkIGJ1aWxkZXIgaWRlbnRpdHlcIik7XG4gICAgY29uc29sZS5sb2coXG4gICAgICBgUHJlcGFyaW5nICR7YnVpbGRlcn0gJHtleHBvcnRpbmcgPyBcInByb2ZpbGUgYXJjaGl2ZVwiIDogXCJpbWFnZVwifSB1c2luZyB0aGUgbWFuYWdlZCBEb2NrZXIgc3RvcmUgYXQgJHtkaXJlY3Rvcnl9YCxcbiAgICApO1xuICAgIGNvbnN0IHZvbHVtZXMgPSByZWNvcmRzKG1hbmFnZWQudm9sdW1lcywgXCJJbnZhbGlkIG1hbmFnZWQgYnVpbGRlciB2b2x1bWVzXCIpO1xuICAgIGNvbnN0IG1vdW50cyA9IHZvbHVtZXMuZmxhdE1hcCgoeyBuYW1lLCBkZXN0aW5hdGlvbiB9KSA9PiB7XG4gICAgICBpZiAodHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIGRlc3RpbmF0aW9uICE9PSBcInN0cmluZ1wiKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIG1hbmFnZWQgYnVpbGRlciBtb3VudFwiKTtcbiAgICAgIHJldHVybiBbXCItLW1vdW50XCIsIGB0eXBlPXZvbHVtZSxzcmM9JHtuYW1lfSxkc3Q9JHtkZXN0aW5hdGlvbn1gXTtcbiAgICB9KTtcbiAgICBzY29wZS5kZWZlcihhc3luYyAoKSA9PiB7XG4gICAgICBpZiAoYXdhaXQgcnVuKFtcImNvbnRhaW5lclwiLCBcImxzXCIsIFwiLS1hbGxcIiwgXCItLXF1aWV0XCIsIFwiLS1maWx0ZXJcIiwgYG5hbWU9Xi8ke2NvbnRhaW5lcn0kYF0sIHRydWUsIHRydWUpKVxuICAgICAgICBhd2FpdCBydW4oW1wicm1cIiwgY29udGFpbmVyXSwgZmFsc2UsIHRydWUpO1xuICAgIH0pO1xuICAgIHNjb3BlLmRlZmVyKGFzeW5jICgpID0+IHtcbiAgICAgIGlmIChhd2FpdCBydW4oW1wiY29udGFpbmVyXCIsIFwibHNcIiwgXCItLWFsbFwiLCBcIi0tcXVpZXRcIiwgXCItLWZpbHRlclwiLCBgbmFtZT1eLyR7Y29udGFpbmVyfSRgXSwgdHJ1ZSwgdHJ1ZSkpXG4gICAgICAgIGF3YWl0IHJ1bihbXCJzdG9wXCIsIGNvbnRhaW5lcl0sIGZhbHNlLCB0cnVlKTtcbiAgICB9LCBcInNodXRkb3duXCIpO1xuICAgIGF3YWl0IHJ1bihbXG4gICAgICBcImNyZWF0ZVwiLFxuICAgICAgXCItLXBsYXRmb3JtXCIsXG4gICAgICBwbGF0Zm9ybSxcbiAgICAgIFwiLS1uYW1lXCIsXG4gICAgICBjb250YWluZXIsXG4gICAgICBcIi0tY2FwLWFkZD1TWVNfQURNSU5cIixcbiAgICAgIFwiLS1jYXAtYWRkPU5FVF9BRE1JTlwiLFxuICAgICAgXCItLXNlY3VyaXR5LW9wdD1zZWNjb21wPXVuY29uZmluZWRcIixcbiAgICAgIFwiLS11bGltaXQ9bm9maWxlPTY1NTM2OjY1NTM2XCIsXG4gICAgICAuLi5tb3VudHMsXG4gICAgICBcIi0tbW91bnRcIixcbiAgICAgIG1vdW50RmllbGRzKFwidHlwZT1iaW5kXCIsIGBzcmM9JHtyb290fWAsIFwiZHN0PS9wcmVwYXJhdGlvblwiLCBcInJlYWRvbmx5XCIpLFxuICAgICAgXCItLW1vdW50XCIsXG4gICAgICBtb3VudEZpZWxkcyhcInR5cGU9YmluZFwiLCBgc3JjPSR7dGVtcG9yYXJ5fWAsIFwiZHN0PS9vdXRwdXRcIiksXG4gICAgICBcIi0tbW91bnRcIixcbiAgICAgIG1vdW50RmllbGRzKFwidHlwZT1iaW5kXCIsIGBzcmM9JHtkaXN0cmlidXRpb259YCwgXCJkc3Q9L3dvcmtiZW5jaFwiLCBcInJlYWRvbmx5XCIpLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgXCJXT1JLQkVOQ0hfUFJFUEFSQVRJT05fRElTVFJJQlVUSU9OPS93b3JrYmVuY2hcIixcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIGBXT1JLQkVOQ0hfTUFOQUdFRF9DT1JFUz0ke1N0cmluZyhwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9DT1JFUyA/PyAxKX1gLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgYFdPUktCRU5DSF9NQU5BR0VEX0pPQlM9JHtTdHJpbmcocHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfSk9CUyA/PyAxKX1gLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgXCJXT1JLQkVOQ0hfUk9PVFNfRklMRT0vb3V0cHV0L3Jvb3RzLmpzb25cIixcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIGBXT1JLQkVOQ0hfSU1BR0VfSU5QVVRTPSR7U3RyaW5nKGlucHV0cyl9YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIGBXT1JLQkVOQ0hfSU1BR0VfQVJDSElURUNUVVJFPSR7YXJjaGl0ZWN0dXJlfWAsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX0FSVElGQUNUX0tJTkQ9JHtwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQVJUSUZBQ1RfS0lORCA/PyBcImRldmVsb3BtZW50XCJ9YCxcbiAgICAgIC4uLihleHBvcnRpbmcgPyBbXCItLWVudlwiLCBcIldPUktCRU5DSF9NQU5BR0VEX1BST0ZJTEVfRVhQT1JUPTFcIl0gOiBbXSksXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX1BSSVZBVEVfQlVJTERFUj0ke2tleX1gLFxuICAgICAgLi4uKHN0YW5kYXJkID8gW1wiLS1lbnZcIiwgYFdPUktCRU5DSF9HVUlYX0JPT1RTVFJBUF9DSEFOTkVMUz0ke3N0YW5kYXJkLmNoYW5uZWxEaWdlc3R9YF0gOiBbXSksXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX1BSRVBBUkFUSU9OX09XTkVSPSR7cHJvY2Vzcy5lbnYuV09SS0JFTkNIX1BSRVBBUkFUSU9OX09XTkVSID8/IGJ1aWxkZXJPd25lcihyb290KX1gLFxuICAgICAgXCItLXdvcmtkaXJcIixcbiAgICAgIFwiL3ByZXBhcmF0aW9uXCIsXG4gICAgICBcIi0tZW50cnlwb2ludFwiLFxuICAgICAgXCIvYmluL3NoXCIsXG4gICAgICBib290c3RyYXBJbWFnZSxcbiAgICAgIFwiL3ByZXBhcmF0aW9uLy5kZXZjb250YWluZXIvbWFuYWdlZC1idWlsZC5zaFwiLFxuICAgICAgYnVpbGRlcixcbiAgICBdKTtcbiAgICBhd2FpdCBydW4oW1wic3RhcnRcIiwgXCItLWF0dGFjaFwiLCBjb250YWluZXJdKTtcbiAgICBjb25zdCBzdGF0dXMgPSBhd2FpdCBydW4oW1wiaW5zcGVjdFwiLCBcIi0tZm9ybWF0XCIsIFwie3suU3RhdGUuRXhpdENvZGV9fVwiLCBjb250YWluZXJdLCB0cnVlKTtcbiAgICBpZiAoc3RhdHVzICE9PSBcIjBcIikgdGhyb3cgbmV3IEVycm9yKGAke2J1aWxkZXJ9IHByZXBhcmF0aW9uIGZhaWxlZDogZXhpdCAke3N0YXR1c31gKTtcbiAgICBpZiAoIWV4cG9ydGluZykge1xuICAgICAgLy8gVGhlIGJ1aWxkZXIgcHJvZHVjZXMgYSBEb2NrZXIgYXJjaGl2ZTsgRG9ja2VyIG93bnMgaW1wb3J0aW5nIGl0cyBsYXllcnMgYW5kIG1ldGFkYXRhLlxuICAgICAgY29uc3QgYXJjaGl2ZSA9IHJlYWRGaWxlU3luYyhqb2luKHRlbXBvcmFyeSwgXCJpbWFnZS1wYXRoXCIpLCBcInV0ZjhcIikudHJpbSgpO1xuICAgICAgaWYgKCFhcmNoaXZlLnN0YXJ0c1dpdGgoYnVpbGRlciA9PT0gXCJndWl4XCIgPyBcIi9nbnUvc3RvcmUvXCIgOiBcIi9uaXgvc3RvcmUvXCIpKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJCdWlsZGVyIHJldHVybmVkIGFuIGludmFsaWQgaW1hZ2Ugc3RvcmUgcGF0aFwiKTtcbiAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgcGluID0gbWFuYWdlZFN0b3JlUGluKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4odGVtcG9yYXJ5LCBcInN0b3JlLXBpbi5qc29uXCIpLCBcInV0ZjhcIikpKTtcbiAgICAgICAgaWYgKHBpbi5idWlsZGVyICE9PSBidWlsZGVyIHx8IHBpbi5rZXkgIT09IGtleSkgdGhyb3cgbmV3IEVycm9yKFwiQnVpbGRlciByZXBvcnRlZCBhIGRpZmZlcmVudCBzdG9yZSBwaW5cIik7XG4gICAgICB9XG4gICAgICBhd2FpdCBpbXBvcnRNYW5hZ2VkSW1hZ2Uoc2NvcGUsIGFyY2hpdmUsIGRlc3RpbmF0aW9uLCBjb250YWluZXIpO1xuICAgIH1cbiAgfVxuICBpZiAoZXhwb3J0aW5nKSB7XG4gICAgbGlua1N5bmMoam9pbih0ZW1wb3JhcnksIG1hbmFnZWRQcm9maWxlQXJjaGl2ZSksIGRlc3RpbmF0aW9uKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGJ1aWxkZXIgPT09IFwiZ3VpeFwiKSB7XG4gICAgY29uc3QgeyBtYXRlcmlhbGl6ZSB9ID0gZ3VpeEltYWdlRGVmaW5pdGlvbihyb290KTtcbiAgICBhd2FpdCBydW4oXG4gICAgICBbXG4gICAgICAgIGpvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLFxuICAgICAgICBcImltYWdlLWZpbmFsaXplXCIsXG4gICAgICAgIGRlc3RpbmF0aW9uLFxuICAgICAgICBkZXN0aW5hdGlvbixcbiAgICAgICAgLi4uKG1hdGVyaWFsaXplLmxlbmd0aCA/IFtcIi0tbWF0ZXJpYWxpemVcIiwgLi4ubWF0ZXJpYWxpemVdIDogW10pLFxuICAgICAgXSxcbiAgICAgIGZhbHNlLFxuICAgICAgZmFsc2UsXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICk7XG4gIH1cbiAgaWYgKHJlc3VsdCAmJiBwaW4pIHdyaXRlQXRvbWljKHJlc3VsdCwgSlNPTi5zdHJpbmdpZnkocGluKSArIFwiXFxuXCIsIDBvNjAwKTtcbn0pO1xuIl0sIm1h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QUFTO0FBQUEsSUFDakU7QUFBQSxFQUNGO0FBQ0EsTUFBSSxXQUFXO0FBQ2IsYUFBUyxLQUFLLFdBQVcscUJBQXFCLEdBQUcsV0FBVztBQUM1RDtBQUFBLEVBQ0Y7QUFDQSxNQUFJLFlBQVksUUFBUTtBQUN0QixVQUFNLEVBQUUsWUFBWSxJQUFJLG9CQUFvQixJQUFJO0FBQ2hELFVBQU07QUFBQSxNQUNKO0FBQUEsUUFDRSxLQUFLLGNBQWMsbUJBQW1CO0FBQUEsUUFDdEM7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0EsR0FBSSxZQUFZLFNBQVMsQ0FBQyxpQkFBaUIsR0FBRyxXQUFXLElBQUksQ0FBQztBQUFBLE1BQ2hFO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLFFBQVE7QUFBQSxJQUNWO0FBQUEsRUFDRjtBQUNBLE1BQUksVUFBVSxJQUFLLGFBQVksUUFBUSxLQUFLLFVBQVUsR0FBRyxJQUFJLE1BQU0sR0FBSztBQUMxRSxDQUFDOyIsIm5hbWVzIjpbInJvb3QiLCJkZXN0aW5hdGlvbiJdLCJmaWxlIjoic2NyaXB0cy9wcmVwYXJlLW1hbmFnZWQtZGV2ZWxvcG1lbnQubWpzIn0=
