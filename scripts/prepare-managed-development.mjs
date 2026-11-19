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
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
const [builder, image] = process.argv.slice(2);
if (builder !== "nix" && builder !== "guix" || !image)
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
const platform = `linux/${process.arch === "x64" ? "amd64" : "arm64"}`;
function guixBootstrapContext(root2, channels, context) {
  const dockerfilePath = join(root2, guixBootstrapDockerfile), bootstrapPath = join(root2, guixBootstrapProgram);
  if (!existsSync(dockerfilePath) || !existsSync(bootstrapPath)) return;
  const dockerfile = readFileSync(dockerfilePath);
  const bootstrap = readFileSync(bootstrapPath);
  const contract = guixBootstrapContract(dockerfile, bootstrap);
  if (contract !== "95ad45aedb24d505d5760a4a69b669841d2710f2c74a4c5df3bdfb76efa4e512") return;
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
  const temporary = mkdtempSync(join(tmpdir(), "workbench-managed-image-"));
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
      `Preparing ${builder} image using the host store at ${builder === "nix" ? "/nix/store" : "/gnu/store"}`
    );
    await run(
      [
        join(distribution, "bin/workbench.mjs"),
        "managed-image-prepare",
        builder,
        image,
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
    if (status !== "0") throw new Error(`${builder} image assembly failed: exit ${status}`);
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
        ...materialize.length ? ["--materialize", ...materialize] : []
      ],
      false,
      false,
      process.execPath
    );
  }
  if (result && pin) writeAtomic(result, JSON.stringify(pin) + "\n", 384);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVxdWlyZWQsIGlzU3RyaW5nQXJyYXksIHJlY29yZCwgcmVjb3JkcyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBndWl4SW1hZ2VEZWZpbml0aW9uIH0gZnJvbSBcIi4vcGFjay1ndWl4LWltYWdlLm1qc1wiO1xuaW1wb3J0IHsgd2l0aE1hbmFnZWRQcm9jZXNzZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLXByb2Nlc3MubWpzXCI7XG5pbXBvcnQgeyBpbXBvcnRNYW5hZ2VkSW1hZ2UgfSBmcm9tIFwiLi9tYW5hZ2VkLWltYWdlLWltcG9ydC5tanNcIjtcbmltcG9ydCB7IGd1aXhCb290c3RyYXBDb250cmFjdCwgZ3VpeEJvb3RzdHJhcERvY2tlcmZpbGUsIGd1aXhCb290c3RyYXBQcm9ncmFtIH0gZnJvbSBcIi4vbWFuYWdlZC1maWxlcy5tanNcIjtcbmltcG9ydCB7XG4gIFByZXBhcmF0aW9uU3RvcmUsXG4gIGJ1aWxkZXJPd25lcixcbiAgZ3VpeENoYW5uZWxGaWxlLFxuICBtYW5hZ2VkU3RvcmVQaW4sXG4gIG1vdW50RmllbGRzLFxuICB0eXBlIE1hbmFnZWRTdG9yZVBpbixcbn0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9leGVjdXRpb24vZW52aXJvbm1lbnRzL21hbmFnZWQvbWFuYWdlZC1jb250cmFjdC5tanNcIjtcbmltcG9ydCB7IHdyaXRlQXRvbWljIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL2ZpbGUtcHVibGljYXRpb24ubWpzXCI7XG5pbXBvcnQgeyBjcmVhdGVIYXNoLCByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSwgcmVsYXRpdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8vIEJ1aWxkZXIgcmVjaXBlcyBhc3NlbWJsZSBvbmx5IGRlY2xhcmVkIGNsb3N1cmVzLiBWZXJpZmljYXRpb24gaXMgYSBzZXBhcmF0ZSBmcmVzaC1zb3VyY2UgaW52b2NhdGlvbi5cbmNvbnN0IFtidWlsZGVyLCBpbWFnZV0gPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMik7XG5pZiAoKGJ1aWxkZXIgIT09IFwibml4XCIgJiYgYnVpbGRlciAhPT0gXCJndWl4XCIpIHx8ICFpbWFnZSlcbiAgdGhyb3cgbmV3IEVycm9yKFwiVXNlIHByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tanMgbml4fGd1aXggSU1BR0VcIik7XG5jb25zdCByb290ID0gcHJvY2Vzcy5jd2QoKTtcbmNvbnN0IGlucHV0cyA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9JTUFHRV9JTlBVVFM7XG5pZiAoIS9eW2EtZjAtOV17NjR9JC8udGVzdChpbnB1dHMgPz8gXCJcIikpXG4gIHRocm93IG5ldyBFcnJvcihcIlVzZSB3b3JrYmVuY2ggZGV2ZWxvcG1lbnQgcHJlcGFyZSB0byBzZWxlY3QgdGhlIGltYWdlIGlucHV0c1wiKTtcbmNvbnN0IHN0b3JlID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX1BSRVBBUkFUSU9OX1NUT1JFO1xuaWYgKHN0b3JlICE9PSBQcmVwYXJhdGlvblN0b3JlLlN5c3RlbSAmJiBzdG9yZSAhPT0gUHJlcGFyYXRpb25TdG9yZS5NYW5hZ2VkKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJVc2Ugd29ya2JlbmNoIGRldmVsb3BtZW50IHByZXBhcmUgdG8gc2VsZWN0IHRoZSBwcmVwYXJhdGlvbiBzdG9yZVwiKTtcbmlmIChidWlsZGVyID09PSBcIm5peFwiICYmIHN0b3JlID09PSBQcmVwYXJhdGlvblN0b3JlLlN5c3RlbSkgcHJvY2Vzcy5lbnYuTklYX1JFTU9URSA9IFwiZGFlbW9uXCI7XG5jb25zdCBkaXN0cmlidXRpb24gPSByZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiLi5cIik7XG5jb25zdCBhcmNoaXRlY3R1cmUgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfSU1BR0VfQVJDSElURUNUVVJFID8/IHByb2Nlc3MuYXJjaDtcbmlmICghW1wieDY0XCIsIFwiYXJtNjRcIl0uaW5jbHVkZXMoYXJjaGl0ZWN0dXJlKSkgdGhyb3cgbmV3IEVycm9yKFwiVW5zdXBwb3J0ZWQgbWFuYWdlZCBpbWFnZSBhcmNoaXRlY3R1cmVcIik7XG4vLyBUaGUgbWFuYWdlciByZW1haW5zIG5hdGl2ZTsgYmluZm10IGV4ZWN1dGVzIGZvcmVpZ24gcGFja2FnZSBidWlsZGVycy5cbmNvbnN0IHBsYXRmb3JtID0gYGxpbnV4LyR7cHJvY2Vzcy5hcmNoID09PSBcIng2NFwiID8gXCJhbWQ2NFwiIDogXCJhcm02NFwifWA7XG5kZWNsYXJlIGNvbnN0IF9fd29ya2JlbmNoR3VpeEJvb3RzdHJhcENvbnRyYWN0OiBzdHJpbmc7XG5cbmZ1bmN0aW9uIGd1aXhCb290c3RyYXBDb250ZXh0KHJvb3Q6IHN0cmluZywgY2hhbm5lbHM6IHN0cmluZywgY29udGV4dDogc3RyaW5nKSB7XG4gIGNvbnN0IGRvY2tlcmZpbGVQYXRoID0gam9pbihyb290LCBndWl4Qm9vdHN0cmFwRG9ja2VyZmlsZSksXG4gICAgYm9vdHN0cmFwUGF0aCA9IGpvaW4ocm9vdCwgZ3VpeEJvb3RzdHJhcFByb2dyYW0pO1xuICBpZiAoIWV4aXN0c1N5bmMoZG9ja2VyZmlsZVBhdGgpIHx8ICFleGlzdHNTeW5jKGJvb3RzdHJhcFBhdGgpKSByZXR1cm47XG4gIGNvbnN0IGRvY2tlcmZpbGUgPSByZWFkRmlsZVN5bmMoZG9ja2VyZmlsZVBhdGgpO1xuICBjb25zdCBib290c3RyYXAgPSByZWFkRmlsZVN5bmMoYm9vdHN0cmFwUGF0aCk7XG4gIGNvbnN0IGNvbnRyYWN0ID0gZ3VpeEJvb3RzdHJhcENvbnRyYWN0KGRvY2tlcmZpbGUsIGJvb3RzdHJhcCk7XG4gIC8vIE9ubHkgdGhlIHN0YW5kYXJkLCByZXZpZXdlZCByZWNpcGUgY2FuIGJ1aWxkIGZyb20gdGhlc2UgdGhyZWUgZmlsZXMuIEN1c3RvbSByZWNpcGVzIGtlZXAgdGhlIGZ1bGwgYnVpbGQgY29udGV4dC5cbiAgaWYgKHR5cGVvZiBfX3dvcmtiZW5jaEd1aXhCb290c3RyYXBDb250cmFjdCAhPT0gXCJzdHJpbmdcIiB8fCBjb250cmFjdCAhPT0gX193b3JrYmVuY2hHdWl4Qm9vdHN0cmFwQ29udHJhY3QpIHJldHVybjtcbiAgY29uc3QgZGVmaW5pdGlvbiA9IHJlYWRGaWxlU3luYyhjaGFubmVscyk7XG4gIG1rZGlyU3luYyhqb2luKGNvbnRleHQsIFwic2NyaXB0c1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihjb250ZXh0LCBcIkRvY2tlcmZpbGVcIiksIGRvY2tlcmZpbGUpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oY29udGV4dCwgXCJjaGFubmVscy5zY21cIiksIGRlZmluaXRpb24pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oY29udGV4dCwgZ3VpeEJvb3RzdHJhcFByb2dyYW0pLCBib290c3RyYXApO1xuICBjb25zdCBjaGFubmVsRGlnZXN0ID0gY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUoZGVmaW5pdGlvbikuZGlnZXN0KFwiaGV4XCIpO1xuICBjb25zdCByZWNpcGUgPSBjcmVhdGVIYXNoKFwic2hhMjU2XCIpXG4gICAgLnVwZGF0ZShKU09OLnN0cmluZ2lmeShbcGxhdGZvcm0sIGNvbnRyYWN0LCBjaGFubmVsRGlnZXN0XSkpXG4gICAgLmRpZ2VzdChcImhleFwiKTtcbiAgcmV0dXJuIHsgcmVjaXBlLCBjaGFubmVsRGlnZXN0IH07XG59XG5cbmF3YWl0IHdpdGhNYW5hZ2VkUHJvY2Vzc2VzKGFzeW5jIChzY29wZSkgPT4ge1xuICBjb25zdCBydW4gPSAoYXJnczogc3RyaW5nW10sIGNhcHR1cmUgPSBmYWxzZSwgY2xlYW51cCA9IGZhbHNlLCBleGVjdXRhYmxlID0gXCJkb2NrZXJcIikgPT5cbiAgICBleGVjdXRhYmxlID09PSBcImRvY2tlclwiICYmIGFyZ3NbMF0gPT09IFwiYnVpbGRcIlxuICAgICAgPyBzY29wZS5ydW4oXG4gICAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgICBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIFwiYnVpbGRraXQtYnVpbGRcIiwgXCItLVwiLCAuLi5hcmdzLnNsaWNlKDEpXSxcbiAgICAgICAgICB7IGNhcHR1cmUsIGNsZWFudXAgfSxcbiAgICAgICAgKVxuICAgICAgOiBzY29wZS5ydW4oZXhlY3V0YWJsZSwgYXJncywgeyBjYXB0dXJlLCBjbGVhbnVwIH0pO1xuICBjb25zdCByb290czogdW5rbm93biA9IEpTT04ucGFyc2UoXG4gICAgYXdhaXQgc2NvcGUucnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJpbWFnZS1yb290c1wiXSwge1xuICAgICAgY2FwdHVyZTogdHJ1ZSxcbiAgICAgIGN3ZDogcm9vdCxcbiAgICB9KSxcbiAgKTtcbiAgaWYgKCFpc1N0cmluZ0FycmF5KHJvb3RzKSB8fCAhcm9vdHMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJQcmVwYXJlZCBtYW5hZ2VkIGltYWdlcyBuZWVkIGNvbmZpZ3VyZWQgbGFuZ3VhZ2Ugcm9vdHNcIik7XG4gIGNvbnN0IHRlbXBvcmFyeSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid29ya2JlbmNoLW1hbmFnZWQtaW1hZ2UtXCIpKTtcbiAgc2NvcGUuZGVmZXIoKCkgPT4ge1xuICAgIHJtU3luYyh0ZW1wb3JhcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG4gIGNvbnN0IGJvb3RzdHJhcCA9IGB3b3JrYmVuY2gtYnVpbGRlcjoke3JhbmRvbVVVSUQoKX1gO1xuICBjb25zdCBjb250YWluZXIgPSBgd29ya2JlbmNoLWJ1aWxkZXItJHtyYW5kb21VVUlEKCl9YDtcbiAgY29uc3QgcmVzdWx0ID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX1BSRVBBUkFUSU9OX1JFU1VMVDtcbiAgbGV0IHBpbjogTWFuYWdlZFN0b3JlUGluIHwgdW5kZWZpbmVkO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcG9yYXJ5LCBcInJvb3RzLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHJvb3RzKSk7XG4gIG1rZGlyU3luYyhqb2luKHRlbXBvcmFyeSwgXCJwcm9maWxlc1wiKSk7XG4gIGlmIChzdG9yZSA9PT0gUHJlcGFyYXRpb25TdG9yZS5TeXN0ZW0pIHtcbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBQcmVwYXJpbmcgJHtidWlsZGVyfSBpbWFnZSB1c2luZyB0aGUgaG9zdCBzdG9yZSBhdCAke2J1aWxkZXIgPT09IFwibml4XCIgPyBcIi9uaXgvc3RvcmVcIiA6IFwiL2dudS9zdG9yZVwifWAsXG4gICAgKTtcbiAgICBhd2FpdCBydW4oXG4gICAgICBbXG4gICAgICAgIGpvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLFxuICAgICAgICBcIm1hbmFnZWQtaW1hZ2UtcHJlcGFyZVwiLFxuICAgICAgICBidWlsZGVyLFxuICAgICAgICBpbWFnZSxcbiAgICAgICAgam9pbih0ZW1wb3JhcnksIFwicm9vdHMuanNvblwiKSxcbiAgICAgICAgdGVtcG9yYXJ5LFxuICAgICAgXSxcbiAgICAgIGZhbHNlLFxuICAgICAgZmFsc2UsXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgY2hhbm5lbHMgPVxuICAgICAgYnVpbGRlciA9PT0gXCJndWl4XCIgPyBndWl4Q2hhbm5lbEZpbGUocm9vdCwgam9pbihyb290LCByZXF1aXJlZChyb290c1swXSwgXCJNaXNzaW5nIG1hbmFnZWQgcm9vdFwiKSkpIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGNvbnRleHQgPSBqb2luKHRlbXBvcmFyeSwgXCJndWl4LWJvb3RzdHJhcFwiKTtcbiAgICBjb25zdCBzdGFuZGFyZCA9IGNoYW5uZWxzID8gZ3VpeEJvb3RzdHJhcENvbnRleHQocm9vdCwgY2hhbm5lbHMsIGNvbnRleHQpIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IHJlY2lwZSA9IHN0YW5kYXJkPy5yZWNpcGU7XG4gICAgY29uc3QgcmVzb2x2ZVN0b3JlID0gYXN5bmMgKGlkZW50aXR5Pzogc3RyaW5nKTogUHJvbWlzZTx1bmtub3duPiA9PlxuICAgICAgSlNPTi5wYXJzZShcbiAgICAgICAgYXdhaXQgcnVuKFxuICAgICAgICAgIFtcbiAgICAgICAgICAgIGpvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLFxuICAgICAgICAgICAgXCJtYW5hZ2VkLWJ1aWxkZXItc3RvcmVcIixcbiAgICAgICAgICAgIGJ1aWxkZXIsXG4gICAgICAgICAgICAuLi4oaWRlbnRpdHkgPyBbaWRlbnRpdHldIDogW10pLFxuICAgICAgICAgICAgLi4uKHJlY2lwZSA/IFtcIi0tcmVjaXBlXCIsIHJlY2lwZV0gOiBbXSksXG4gICAgICAgICAgXSxcbiAgICAgICAgICB0cnVlLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgICksXG4gICAgICApO1xuICAgIGNvbnN0IHJldXNlZCA9IHJlY2lwZSAmJiBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUkVGUkVTSF9HVUlYX0JPT1RTVFJBUCAhPT0gXCIxXCIgPyBhd2FpdCByZXNvbHZlU3RvcmUoKSA6IG51bGw7XG4gICAgbGV0IGJvb3RzdHJhcEltYWdlID0gYm9vdHN0cmFwO1xuICAgIGxldCBzZWxlY3RlZCA9IHJldXNlZDtcbiAgICBpZiAocmV1c2VkICE9PSBudWxsKSB7XG4gICAgICBjb25zdCByZXVzZWRTdG9yZSA9IHJlY29yZChyZXVzZWQsIFwiSW52YWxpZCByZXVzZWQgR3VpeCBib290c3RyYXBcIik7XG4gICAgICBpZiAodHlwZW9mIHJldXNlZFN0b3JlLmltYWdlICE9PSBcInN0cmluZ1wiIHx8ICEvXnNoYTI1NjpbYS1mMC05XXs2NH0kLy50ZXN0KHJldXNlZFN0b3JlLmltYWdlKSlcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTWFuYWdlZCBHdWl4IHJldXNlIHJlcXVpcmVzIGFuIGltbXV0YWJsZSBib290c3RyYXAgaW1hZ2VcIik7XG4gICAgICBib290c3RyYXBJbWFnZSA9IHJldXNlZFN0b3JlLmltYWdlO1xuICAgICAgY29uc29sZS5sb2coYFJldXNpbmcgdGhlIHZlcmlmaWVkIEd1aXggYm9vdHN0cmFwICR7Ym9vdHN0cmFwSW1hZ2V9YCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNjb3BlLmRlZmVyKGFzeW5jICgpID0+IHtcbiAgICAgICAgaWYgKGF3YWl0IHJ1bihbXCJpbWFnZVwiLCBcImxzXCIsIFwiLS1xdWlldFwiLCBcIi0tZmlsdGVyXCIsIGByZWZlcmVuY2U9JHtib290c3RyYXB9YF0sIHRydWUsIHRydWUpKVxuICAgICAgICAgIGF3YWl0IHJ1bihbXCJpbWFnZVwiLCBcInJtXCIsIGJvb3RzdHJhcF0sIGZhbHNlLCB0cnVlKTtcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgcnVuKFtcbiAgICAgICAgXCJidWlsZFwiLFxuICAgICAgICAuLi4oYnVpbGRlciA9PT0gXCJndWl4XCIgPyBbXCItLW5vLWNhY2hlLWZpbHRlclwiLCBcImJhc2VcIl0gOiBbXSksXG4gICAgICAgIFwiLS1wbGF0Zm9ybVwiLFxuICAgICAgICBwbGF0Zm9ybSxcbiAgICAgICAgXCItLW5ldHdvcms9aG9zdFwiLFxuICAgICAgICBcIi0tdWxpbWl0PW5vZmlsZT02NTUzNjo2NTUzNlwiLFxuICAgICAgICBcIi0tdGFyZ2V0XCIsXG4gICAgICAgIFwiYmFzZVwiLFxuICAgICAgICBcIi0tZmlsZVwiLFxuICAgICAgICByZWNpcGUgPyBqb2luKGNvbnRleHQsIFwiRG9ja2VyZmlsZVwiKSA6IGpvaW4ocm9vdCwgXCIuZGV2Y29udGFpbmVyXCIsIGJ1aWxkZXIsIFwiRG9ja2VyZmlsZVwiKSxcbiAgICAgICAgXCItLXRhZ1wiLFxuICAgICAgICBib290c3RyYXAsXG4gICAgICAgIC4uLihyZWNpcGUgPyBbXCItLWxhYmVsXCIsIGBvcmcud29ya2JlbmNoLmd1aXgtYm9vdHN0cmFwPSR7cmVjaXBlfWBdIDogW10pLFxuICAgICAgICAuLi4oY2hhbm5lbHMgJiYgIXJlY2lwZVxuICAgICAgICAgID8gW1wiLS1idWlsZC1hcmdcIiwgYFdPUktCRU5DSF9HVUlYX0NIQU5ORUxTPSR7cmVsYXRpdmUocm9vdCwgY2hhbm5lbHMpLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKX1gXVxuICAgICAgICAgIDogW10pLFxuICAgICAgICByZWNpcGUgPyBjb250ZXh0IDogcm9vdCxcbiAgICAgIF0pO1xuICAgICAgc2VsZWN0ZWQgPSBhd2FpdCByZXNvbHZlU3RvcmUoYXdhaXQgcnVuKFtcImltYWdlXCIsIFwiaW5zcGVjdFwiLCBcIi0tZm9ybWF0XCIsIFwie3suSWR9fVwiLCBib290c3RyYXBdLCB0cnVlKSk7XG4gICAgfVxuICAgIGNvbnN0IG1hbmFnZWQgPSByZWNvcmQoc2VsZWN0ZWQsIFwiSW52YWxpZCBtYW5hZ2VkIGJ1aWxkZXIgc3RvcmVcIik7XG4gICAgY29uc3QgeyBrZXksIGRpcmVjdG9yeSB9ID0gbWFuYWdlZDtcbiAgICBpZiAodHlwZW9mIGtleSAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgZGlyZWN0b3J5ICE9PSBcInN0cmluZ1wiKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIG1hbmFnZWQgYnVpbGRlciBpZGVudGl0eVwiKTtcbiAgICBjb25zb2xlLmxvZyhgUHJlcGFyaW5nICR7YnVpbGRlcn0gaW1hZ2UgdXNpbmcgdGhlIG1hbmFnZWQgRG9ja2VyIHN0b3JlIGF0ICR7ZGlyZWN0b3J5fWApO1xuICAgIGNvbnN0IHZvbHVtZXMgPSByZWNvcmRzKG1hbmFnZWQudm9sdW1lcywgXCJJbnZhbGlkIG1hbmFnZWQgYnVpbGRlciB2b2x1bWVzXCIpO1xuICAgIGNvbnN0IG1vdW50cyA9IHZvbHVtZXMuZmxhdE1hcCgoeyBuYW1lLCBkZXN0aW5hdGlvbiB9KSA9PiB7XG4gICAgICBpZiAodHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIGRlc3RpbmF0aW9uICE9PSBcInN0cmluZ1wiKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIG1hbmFnZWQgYnVpbGRlciBtb3VudFwiKTtcbiAgICAgIHJldHVybiBbXCItLW1vdW50XCIsIGB0eXBlPXZvbHVtZSxzcmM9JHtuYW1lfSxkc3Q9JHtkZXN0aW5hdGlvbn1gXTtcbiAgICB9KTtcbiAgICBzY29wZS5kZWZlcihhc3luYyAoKSA9PiB7XG4gICAgICBpZiAoYXdhaXQgcnVuKFtcImNvbnRhaW5lclwiLCBcImxzXCIsIFwiLS1hbGxcIiwgXCItLXF1aWV0XCIsIFwiLS1maWx0ZXJcIiwgYG5hbWU9Xi8ke2NvbnRhaW5lcn0kYF0sIHRydWUsIHRydWUpKVxuICAgICAgICBhd2FpdCBydW4oW1wicm1cIiwgY29udGFpbmVyXSwgZmFsc2UsIHRydWUpO1xuICAgIH0pO1xuICAgIHNjb3BlLmRlZmVyKGFzeW5jICgpID0+IHtcbiAgICAgIGlmIChhd2FpdCBydW4oW1wiY29udGFpbmVyXCIsIFwibHNcIiwgXCItLWFsbFwiLCBcIi0tcXVpZXRcIiwgXCItLWZpbHRlclwiLCBgbmFtZT1eLyR7Y29udGFpbmVyfSRgXSwgdHJ1ZSwgdHJ1ZSkpXG4gICAgICAgIGF3YWl0IHJ1bihbXCJzdG9wXCIsIGNvbnRhaW5lcl0sIGZhbHNlLCB0cnVlKTtcbiAgICB9LCBcInNodXRkb3duXCIpO1xuICAgIGF3YWl0IHJ1bihbXG4gICAgICBcImNyZWF0ZVwiLFxuICAgICAgXCItLXBsYXRmb3JtXCIsXG4gICAgICBwbGF0Zm9ybSxcbiAgICAgIFwiLS1uYW1lXCIsXG4gICAgICBjb250YWluZXIsXG4gICAgICBcIi0tY2FwLWFkZD1TWVNfQURNSU5cIixcbiAgICAgIFwiLS1jYXAtYWRkPU5FVF9BRE1JTlwiLFxuICAgICAgXCItLXNlY3VyaXR5LW9wdD1zZWNjb21wPXVuY29uZmluZWRcIixcbiAgICAgIFwiLS11bGltaXQ9bm9maWxlPTY1NTM2OjY1NTM2XCIsXG4gICAgICAuLi5tb3VudHMsXG4gICAgICBcIi0tbW91bnRcIixcbiAgICAgIG1vdW50RmllbGRzKFwidHlwZT1iaW5kXCIsIGBzcmM9JHtyb290fWAsIFwiZHN0PS9wcmVwYXJhdGlvblwiLCBcInJlYWRvbmx5XCIpLFxuICAgICAgXCItLW1vdW50XCIsXG4gICAgICBtb3VudEZpZWxkcyhcInR5cGU9YmluZFwiLCBgc3JjPSR7dGVtcG9yYXJ5fWAsIFwiZHN0PS9vdXRwdXRcIiksXG4gICAgICBcIi0tbW91bnRcIixcbiAgICAgIG1vdW50RmllbGRzKFwidHlwZT1iaW5kXCIsIGBzcmM9JHtkaXN0cmlidXRpb259YCwgXCJkc3Q9L3dvcmtiZW5jaFwiLCBcInJlYWRvbmx5XCIpLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgXCJXT1JLQkVOQ0hfUFJFUEFSQVRJT05fRElTVFJJQlVUSU9OPS93b3JrYmVuY2hcIixcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIGBXT1JLQkVOQ0hfTUFOQUdFRF9DT1JFUz0ke1N0cmluZyhwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9DT1JFUyA/PyAxKX1gLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgYFdPUktCRU5DSF9NQU5BR0VEX0pPQlM9JHtTdHJpbmcocHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfSk9CUyA/PyAxKX1gLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgXCJXT1JLQkVOQ0hfUk9PVFNfRklMRT0vb3V0cHV0L3Jvb3RzLmpzb25cIixcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIGBXT1JLQkVOQ0hfSU1BR0VfSU5QVVRTPSR7U3RyaW5nKGlucHV0cyl9YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIGBXT1JLQkVOQ0hfSU1BR0VfQVJDSElURUNUVVJFPSR7YXJjaGl0ZWN0dXJlfWAsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX1BSSVZBVEVfQlVJTERFUj0ke2tleX1gLFxuICAgICAgLi4uKHN0YW5kYXJkID8gW1wiLS1lbnZcIiwgYFdPUktCRU5DSF9HVUlYX0JPT1RTVFJBUF9DSEFOTkVMUz0ke3N0YW5kYXJkLmNoYW5uZWxEaWdlc3R9YF0gOiBbXSksXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX1BSRVBBUkFUSU9OX09XTkVSPSR7cHJvY2Vzcy5lbnYuV09SS0JFTkNIX1BSRVBBUkFUSU9OX09XTkVSID8/IGJ1aWxkZXJPd25lcihyb290KX1gLFxuICAgICAgXCItLXdvcmtkaXJcIixcbiAgICAgIFwiL3ByZXBhcmF0aW9uXCIsXG4gICAgICBcIi0tZW50cnlwb2ludFwiLFxuICAgICAgXCIvYmluL3NoXCIsXG4gICAgICBib290c3RyYXBJbWFnZSxcbiAgICAgIFwiL3ByZXBhcmF0aW9uLy5kZXZjb250YWluZXIvbWFuYWdlZC1idWlsZC5zaFwiLFxuICAgICAgYnVpbGRlcixcbiAgICBdKTtcbiAgICBhd2FpdCBydW4oW1wic3RhcnRcIiwgXCItLWF0dGFjaFwiLCBjb250YWluZXJdKTtcbiAgICBjb25zdCBzdGF0dXMgPSBhd2FpdCBydW4oW1wiaW5zcGVjdFwiLCBcIi0tZm9ybWF0XCIsIFwie3suU3RhdGUuRXhpdENvZGV9fVwiLCBjb250YWluZXJdLCB0cnVlKTtcbiAgICBpZiAoc3RhdHVzICE9PSBcIjBcIikgdGhyb3cgbmV3IEVycm9yKGAke2J1aWxkZXJ9IGltYWdlIGFzc2VtYmx5IGZhaWxlZDogZXhpdCAke3N0YXR1c31gKTtcbiAgICAvLyBUaGUgYnVpbGRlciBwcm9kdWNlcyBhIERvY2tlciBhcmNoaXZlOyBEb2NrZXIgb3ducyBpbXBvcnRpbmcgaXRzIGxheWVycyBhbmQgbWV0YWRhdGEuXG4gICAgY29uc3QgYXJjaGl2ZSA9IHJlYWRGaWxlU3luYyhqb2luKHRlbXBvcmFyeSwgXCJpbWFnZS1wYXRoXCIpLCBcInV0ZjhcIikudHJpbSgpO1xuICAgIGlmICghYXJjaGl2ZS5zdGFydHNXaXRoKGJ1aWxkZXIgPT09IFwiZ3VpeFwiID8gXCIvZ251L3N0b3JlL1wiIDogXCIvbml4L3N0b3JlL1wiKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkJ1aWxkZXIgcmV0dXJuZWQgYW4gaW52YWxpZCBpbWFnZSBzdG9yZSBwYXRoXCIpO1xuICAgIGlmIChyZXN1bHQpIHtcbiAgICAgIHBpbiA9IG1hbmFnZWRTdG9yZVBpbihKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHRlbXBvcmFyeSwgXCJzdG9yZS1waW4uanNvblwiKSwgXCJ1dGY4XCIpKSk7XG4gICAgICBpZiAocGluLmJ1aWxkZXIgIT09IGJ1aWxkZXIgfHwgcGluLmtleSAhPT0ga2V5KSB0aHJvdyBuZXcgRXJyb3IoXCJCdWlsZGVyIHJlcG9ydGVkIGEgZGlmZmVyZW50IHN0b3JlIHBpblwiKTtcbiAgICB9XG4gICAgYXdhaXQgaW1wb3J0TWFuYWdlZEltYWdlKHNjb3BlLCBhcmNoaXZlLCBpbWFnZSwgY29udGFpbmVyKTtcbiAgfVxuICBpZiAoYnVpbGRlciA9PT0gXCJndWl4XCIpIHtcbiAgICBjb25zdCB7IG1hdGVyaWFsaXplIH0gPSBndWl4SW1hZ2VEZWZpbml0aW9uKHJvb3QpO1xuICAgIGF3YWl0IHJ1bihcbiAgICAgIFtcbiAgICAgICAgam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwiaW1hZ2UtZmluYWxpemVcIixcbiAgICAgICAgaW1hZ2UsXG4gICAgICAgIGltYWdlLFxuICAgICAgICAuLi4obWF0ZXJpYWxpemUubGVuZ3RoID8gW1wiLS1tYXRlcmlhbGl6ZVwiLCAuLi5tYXRlcmlhbGl6ZV0gOiBbXSksXG4gICAgICBdLFxuICAgICAgZmFsc2UsXG4gICAgICBmYWxzZSxcbiAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgKTtcbiAgfVxuICBpZiAocmVzdWx0ICYmIHBpbikgd3JpdGVBdG9taWMocmVzdWx0LCBKU09OLnN0cmluZ2lmeShwaW4pICsgXCJcXG5cIiwgMG82MDApO1xufSk7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLFVBQVUsZUFBZSxRQUFRLGVBQWU7QUFDekQsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyw0QkFBNEI7QUFDckMsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyx1QkFBdUIseUJBQXlCLDRCQUE0QjtBQUNyRjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FFSztBQUNQLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsWUFBWSxrQkFBa0I7QUFDdkMsU0FBUyxZQUFZLFdBQVcsYUFBYSxjQUFjLFFBQVEscUJBQXFCO0FBQ3hGLFNBQVMsY0FBYztBQUN2QixTQUFTLE1BQU0sU0FBUyxnQkFBZ0I7QUFHeEMsTUFBTSxDQUFDLFNBQVMsS0FBSyxJQUFJLFFBQVEsS0FBSyxNQUFNLENBQUM7QUFDN0MsSUFBSyxZQUFZLFNBQVMsWUFBWSxVQUFXLENBQUM7QUFDaEQsUUFBTSxJQUFJLE1BQU0sb0RBQW9EO0FBQ3RFLE1BQU0sT0FBTyxRQUFRLElBQUk7QUFDekIsTUFBTSxTQUFTLFFBQVEsSUFBSTtBQUMzQixJQUFJLENBQUMsaUJBQWlCLEtBQUssVUFBVSxFQUFFO0FBQ3JDLFFBQU0sSUFBSSxNQUFNLDhEQUE4RDtBQUNoRixNQUFNLFFBQVEsUUFBUSxJQUFJO0FBQzFCLElBQUksVUFBVSxpQkFBaUIsVUFBVSxVQUFVLGlCQUFpQjtBQUNsRSxRQUFNLElBQUksTUFBTSxtRUFBbUU7QUFDckYsSUFBSSxZQUFZLFNBQVMsVUFBVSxpQkFBaUIsT0FBUSxTQUFRLElBQUksYUFBYTtBQUNyRixNQUFNLGVBQWUsUUFBUSxZQUFZLFNB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TUFDQTtBQUFBLE1BQ0EsMEJBQTBCLE9BQU8sTUFBTSxDQUFDO0FBQUEsTUFDeEM7QUFBQSxNQUNBLGdDQUFnQyxZQUFZO0FBQUEsTUFDNUM7QUFBQSxNQUNBLDZCQUE2QixHQUFHO0FBQUEsTUFDaEMsR0FBSSxXQUFXLENBQUMsU0FBUyxxQ0FBcUMsU0FBUyxhQUFhLEVBQUUsSUFBSSxDQUFDO0FBQUEsTUFDM0Y7QUFBQSxNQUNBLCtCQUErQixRQUFRLElBQUksK0JBQStCLGFBQWEsSUFBSSxDQUFDO0FBQUEsTUFDNUY7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLENBQUM7QUFDRCxVQUFNLElBQUksQ0FBQyxTQUFTLFlBQVksU0FBUyxDQUFDO0FBQzFDLFVBQU0sU0FBUyxNQUFNLElBQUksQ0FBQyxXQUFXLFlBQVksdUJBQXVCLFNBQVMsR0FBRyxJQUFJO0FBQ3hGLFFBQUksV0FBVyxJQUFLLE9BQU0sSUFBSSxNQUFNLEdBQUcsT0FBTyxnQ0FBZ0MsTUFBTSxFQUFFO0FBRXRGLFVBQU0sVUFBVSxhQUFhLEtBQUssV0FBVyxZQUFZLEdBQUcsTUFBTSxFQUFFLEtBQUs7QUFDekUsUUFBSSxDQUFDLFFBQVEsV0FBVyxZQUFZLFNBQVMsZ0JBQWdCLGFBQWE7QUFDeEUsWUFBTSxJQUFJLE1BQU0sOENBQThDO0FBQ2hFLFFBQUksUUFBUTtBQUNWLFlBQU0sZ0JBQWdCLEtBQUssTUFBTSxhQUFhLEtBQUssV0FBVyxnQkFBZ0IsR0FBRyxNQUFNLENBQUMsQ0FBQztBQUN6RixVQUFJLElBQUksWUFBWSxXQUFXLElBQUksUUFBUSxJQUFLLE9BQU0sSUFBSSxNQUFNLHdDQUF3QztBQUFBLElBQzFHO0FBQ0EsVUFBTSxtQkFBbUIsT0FBTyxTQUFTLE9BQU8sU0FBUztBQUFBLEVBQzNEO0FBQ0EsTUFBSSxZQUFZLFFBQVE7QUFDdEIsVUFBTSxFQUFFLFlBQVksSUFBSSxvQkFBb0IsSUFBSTtBQUNoRCxVQUFNO0FBQUEsTUFDSjtBQUFBLFFBQ0UsS0FBSyxjQUFjLG1CQUFtQjtBQUFBLFFBQ3RDO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBLEdBQUksWUFBWSxTQUFTLENBQUMsaUJBQWlCLEdBQUcsV0FBVyxJQUFJLENBQUM7QUFBQSxNQUNoRTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxRQUFRO0FBQUEsSUFDVjtBQUFBLEVBQ0Y7QUFDQSxNQUFJLFVBQVUsSUFBSyxhQUFZLFFBQVEsS0FBSyxVQUFVLEdBQUcsSUFBSSxNQUFNLEdBQUs7QUFDMUUsQ0FBQzsiLCJuYW1lcyI6WyJyb290Il0sImZpbGUiOiJzY3JpcHRzL3ByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tanMifQ==
