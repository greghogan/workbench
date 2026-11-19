// Generated from prepare-managed-development.mts; edit the TypeScript source.
import { required, isStringArray, record, records } from "../app/src/core/runtime/values.mjs";
import { guixImageDefinition } from "./pack-guix-image.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { importManagedImage } from "./managed-image-import.mjs";
import {
  PreparationStore,
  builderOwner,
  guixChannelFile,
  managedStorePin
} from "../app/src/core/execution/environments/managed/managed-contract.mjs";
import { writeAtomic } from "../app/src/core/runtime/file-publication.mjs";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      join(root, ".devcontainer", builder, "Dockerfile"),
      "--tag",
      bootstrap,
      ...channels ? ["--build-arg", `WORKBENCH_GUIX_CHANNELS=${relative(root, channels).replaceAll("\\", "/")}`] : [],
      root
    ]);
    const identity = await run(["image", "inspect", "--format", "{{.Id}}", bootstrap], true);
    const managed = record(
      JSON.parse(
        await run(
          [join(distribution, "bin/workbench.mjs"), "managed-builder-store", builder, identity],
          true,
          false,
          process.execPath
        )
      ),
      "Invalid managed builder store"
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVxdWlyZWQsIGlzU3RyaW5nQXJyYXksIHJlY29yZCwgcmVjb3JkcyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBndWl4SW1hZ2VEZWZpbml0aW9uIH0gZnJvbSBcIi4vcGFjay1ndWl4LWltYWdlLm1qc1wiO1xuaW1wb3J0IHsgd2l0aE1hbmFnZWRQcm9jZXNzZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLXByb2Nlc3MubWpzXCI7XG5pbXBvcnQgeyBpbXBvcnRNYW5hZ2VkSW1hZ2UgfSBmcm9tIFwiLi9tYW5hZ2VkLWltYWdlLWltcG9ydC5tanNcIjtcbmltcG9ydCB7XG4gIFByZXBhcmF0aW9uU3RvcmUsXG4gIGJ1aWxkZXJPd25lcixcbiAgZ3VpeENoYW5uZWxGaWxlLFxuICBtYW5hZ2VkU3RvcmVQaW4sXG4gIHR5cGUgTWFuYWdlZFN0b3JlUGluLFxufSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9lbnZpcm9ubWVudHMvbWFuYWdlZC9tYW5hZ2VkLWNvbnRyYWN0Lm1qc1wiO1xuaW1wb3J0IHsgd3JpdGVBdG9taWMgfSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3J1bnRpbWUvZmlsZS1wdWJsaWNhdGlvbi5tanNcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlLCByZWxhdGl2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLy8gQnVpbGRlciByZWNpcGVzIGFzc2VtYmxlIG9ubHkgZGVjbGFyZWQgY2xvc3VyZXMuIFZlcmlmaWNhdGlvbiBpcyBhIHNlcGFyYXRlIGZyZXNoLXNvdXJjZSBpbnZvY2F0aW9uLlxuY29uc3QgW2J1aWxkZXIsIGltYWdlXSA9IHByb2Nlc3MuYXJndi5zbGljZSgyKTtcbmlmICgoYnVpbGRlciAhPT0gXCJuaXhcIiAmJiBidWlsZGVyICE9PSBcImd1aXhcIikgfHwgIWltYWdlKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJVc2UgcHJlcGFyZS1tYW5hZ2VkLWRldmVsb3BtZW50Lm1qcyBuaXh8Z3VpeCBJTUFHRVwiKTtcbmNvbnN0IHJvb3QgPSBwcm9jZXNzLmN3ZCgpO1xuY29uc3QgaW5wdXRzID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0lNQUdFX0lOUFVUUztcbmlmICghL15bYS1mMC05XXs2NH0kLy50ZXN0KGlucHV0cyA/PyBcIlwiKSlcbiAgdGhyb3cgbmV3IEVycm9yKFwiVXNlIHdvcmtiZW5jaCBkZXZlbG9wbWVudCBwcmVwYXJlIHRvIHNlbGVjdCB0aGUgaW1hZ2UgaW5wdXRzXCIpO1xuY29uc3Qgc3RvcmUgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUFJFUEFSQVRJT05fU1RPUkU7XG5pZiAoc3RvcmUgIT09IFByZXBhcmF0aW9uU3RvcmUuU3lzdGVtICYmIHN0b3JlICE9PSBQcmVwYXJhdGlvblN0b3JlLk1hbmFnZWQpXG4gIHRocm93IG5ldyBFcnJvcihcIlVzZSB3b3JrYmVuY2ggZGV2ZWxvcG1lbnQgcHJlcGFyZSB0byBzZWxlY3QgdGhlIHByZXBhcmF0aW9uIHN0b3JlXCIpO1xuaWYgKGJ1aWxkZXIgPT09IFwibml4XCIgJiYgc3RvcmUgPT09IFByZXBhcmF0aW9uU3RvcmUuU3lzdGVtKSBwcm9jZXNzLmVudi5OSVhfUkVNT1RFID0gXCJkYWVtb25cIjtcbmNvbnN0IGRpc3RyaWJ1dGlvbiA9IHJlc29sdmUoaW1wb3J0Lm1ldGEuZGlybmFtZSwgXCIuLlwiKTtcbmNvbnN0IGFyY2hpdGVjdHVyZSA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9JTUFHRV9BUkNISVRFQ1RVUkUgPz8gcHJvY2Vzcy5hcmNoO1xuaWYgKCFbXCJ4NjRcIiwgXCJhcm02NFwiXS5pbmNsdWRlcyhhcmNoaXRlY3R1cmUpKSB0aHJvdyBuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBtYW5hZ2VkIGltYWdlIGFyY2hpdGVjdHVyZVwiKTtcbi8vIFRoZSBtYW5hZ2VyIHJlbWFpbnMgbmF0aXZlOyBiaW5mbXQgZXhlY3V0ZXMgZm9yZWlnbiBwYWNrYWdlIGJ1aWxkZXJzLlxuY29uc3QgcGxhdGZvcm0gPSBgbGludXgvJHtwcm9jZXNzLmFyY2ggPT09IFwieDY0XCIgPyBcImFtZDY0XCIgOiBcImFybTY0XCJ9YDtcbmF3YWl0IHdpdGhNYW5hZ2VkUHJvY2Vzc2VzKGFzeW5jIChzY29wZSkgPT4ge1xuICBjb25zdCBydW4gPSAoYXJnczogc3RyaW5nW10sIGNhcHR1cmUgPSBmYWxzZSwgY2xlYW51cCA9IGZhbHNlLCBleGVjdXRhYmxlID0gXCJkb2NrZXJcIikgPT5cbiAgICBleGVjdXRhYmxlID09PSBcImRvY2tlclwiICYmIGFyZ3NbMF0gPT09IFwiYnVpbGRcIlxuICAgICAgPyBzY29wZS5ydW4oXG4gICAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgICBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIFwiYnVpbGRraXQtYnVpbGRcIiwgXCItLVwiLCAuLi5hcmdzLnNsaWNlKDEpXSxcbiAgICAgICAgICB7IGNhcHR1cmUsIGNsZWFudXAgfSxcbiAgICAgICAgKVxuICAgICAgOiBzY29wZS5ydW4oZXhlY3V0YWJsZSwgYXJncywgeyBjYXB0dXJlLCBjbGVhbnVwIH0pO1xuICBjb25zdCByb290czogdW5rbm93biA9IEpTT04ucGFyc2UoXG4gICAgYXdhaXQgc2NvcGUucnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJpbWFnZS1yb290c1wiXSwge1xuICAgICAgY2FwdHVyZTogdHJ1ZSxcbiAgICAgIGN3ZDogcm9vdCxcbiAgICB9KSxcbiAgKTtcbiAgaWYgKCFpc1N0cmluZ0FycmF5KHJvb3RzKSB8fCAhcm9vdHMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJQcmVwYXJlZCBtYW5hZ2VkIGltYWdlcyBuZWVkIGNvbmZpZ3VyZWQgbGFuZ3VhZ2Ugcm9vdHNcIik7XG4gIGNvbnN0IHRlbXBvcmFyeSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid29ya2JlbmNoLW1hbmFnZWQtaW1hZ2UtXCIpKTtcbiAgc2NvcGUuZGVmZXIoKCkgPT4ge1xuICAgIHJtU3luYyh0ZW1wb3JhcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG4gIGNvbnN0IGJvb3RzdHJhcCA9IGB3b3JrYmVuY2gtYnVpbGRlcjoke3JhbmRvbVVVSUQoKX1gO1xuICBjb25zdCBjb250YWluZXIgPSBgd29ya2JlbmNoLWJ1aWxkZXItJHtyYW5kb21VVUlEKCl9YDtcbiAgY29uc3QgcmVzdWx0ID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX1BSRVBBUkFUSU9OX1JFU1VMVDtcbiAgbGV0IHBpbjogTWFuYWdlZFN0b3JlUGluIHwgdW5kZWZpbmVkO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcG9yYXJ5LCBcInJvb3RzLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHJvb3RzKSk7XG4gIG1rZGlyU3luYyhqb2luKHRlbXBvcmFyeSwgXCJwcm9maWxlc1wiKSk7XG4gIGlmIChzdG9yZSA9PT0gUHJlcGFyYXRpb25TdG9yZS5TeXN0ZW0pIHtcbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBQcmVwYXJpbmcgJHtidWlsZGVyfSBpbWFnZSB1c2luZyB0aGUgaG9zdCBzdG9yZSBhdCAke2J1aWxkZXIgPT09IFwibml4XCIgPyBcIi9uaXgvc3RvcmVcIiA6IFwiL2dudS9zdG9yZVwifWAsXG4gICAgKTtcbiAgICBhd2FpdCBydW4oXG4gICAgICBbXG4gICAgICAgIGpvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLFxuICAgICAgICBcIm1hbmFnZWQtaW1hZ2UtcHJlcGFyZVwiLFxuICAgICAgICBidWlsZGVyLFxuICAgICAgICBpbWFnZSxcbiAgICAgICAgam9pbih0ZW1wb3JhcnksIFwicm9vdHMuanNvblwiKSxcbiAgICAgICAgdGVtcG9yYXJ5LFxuICAgICAgXSxcbiAgICAgIGZhbHNlLFxuICAgICAgZmFsc2UsXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgY2hhbm5lbHMgPVxuICAgICAgYnVpbGRlciA9PT0gXCJndWl4XCIgPyBndWl4Q2hhbm5lbEZpbGUocm9vdCwgam9pbihyb290LCByZXF1aXJlZChyb290c1swXSwgXCJNaXNzaW5nIG1hbmFnZWQgcm9vdFwiKSkpIDogdW5kZWZpbmVkO1xuICAgIHNjb3BlLmRlZmVyKGFzeW5jICgpID0+IHtcbiAgICAgIGlmIChhd2FpdCBydW4oW1wiaW1hZ2VcIiwgXCJsc1wiLCBcIi0tcXVpZXRcIiwgXCItLWZpbHRlclwiLCBgcmVmZXJlbmNlPSR7Ym9vdHN0cmFwfWBdLCB0cnVlLCB0cnVlKSlcbiAgICAgICAgYXdhaXQgcnVuKFtcImltYWdlXCIsIFwicm1cIiwgYm9vdHN0cmFwXSwgZmFsc2UsIHRydWUpO1xuICAgIH0pO1xuICAgIGF3YWl0IHJ1bihbXG4gICAgICBcImJ1aWxkXCIsXG4gICAgICAuLi4oYnVpbGRlciA9PT0gXCJndWl4XCIgPyBbXCItLW5vLWNhY2hlLWZpbHRlclwiLCBcImJhc2VcIl0gOiBbXSksXG4gICAgICBcIi0tcGxhdGZvcm1cIixcbiAgICAgIHBsYXRmb3JtLFxuICAgICAgXCItLW5ldHdvcms9aG9zdFwiLFxuICAgICAgXCItLXVsaW1pdD1ub2ZpbGU9NjU1MzY6NjU1MzZcIixcbiAgICAgIFwiLS10YXJnZXRcIixcbiAgICAgIFwiYmFzZVwiLFxuICAgICAgXCItLWZpbGVcIixcbiAgICAgIGpvaW4ocm9vdCwgXCIuZGV2Y29udGFpbmVyXCIsIGJ1aWxkZXIsIFwiRG9ja2VyZmlsZVwiKSxcbiAgICAgIFwiLS10YWdcIixcbiAgICAgIGJvb3RzdHJhcCxcbiAgICAgIC4uLihjaGFubmVscyA/IFtcIi0tYnVpbGQtYXJnXCIsIGBXT1JLQkVOQ0hfR1VJWF9DSEFOTkVMUz0ke3JlbGF0aXZlKHJvb3QsIGNoYW5uZWxzKS5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIil9YF0gOiBbXSksXG4gICAgICByb290LFxuICAgIF0pO1xuICAgIGNvbnN0IGlkZW50aXR5ID0gYXdhaXQgcnVuKFtcImltYWdlXCIsIFwiaW5zcGVjdFwiLCBcIi0tZm9ybWF0XCIsIFwie3suSWR9fVwiLCBib290c3RyYXBdLCB0cnVlKTtcbiAgICBjb25zdCBtYW5hZ2VkID0gcmVjb3JkKFxuICAgICAgSlNPTi5wYXJzZShcbiAgICAgICAgYXdhaXQgcnVuKFxuICAgICAgICAgIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJtYW5hZ2VkLWJ1aWxkZXItc3RvcmVcIiwgYnVpbGRlciwgaWRlbnRpdHldLFxuICAgICAgICAgIHRydWUsXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgKSxcbiAgICAgICksXG4gICAgICBcIkludmFsaWQgbWFuYWdlZCBidWlsZGVyIHN0b3JlXCIsXG4gICAgKTtcbiAgICBjb25zdCB7IGtleSwgZGlyZWN0b3J5IH0gPSBtYW5hZ2VkO1xuICAgIGlmICh0eXBlb2Yga2V5ICE9PSBcInN0cmluZ1wiIHx8IHR5cGVvZiBkaXJlY3RvcnkgIT09IFwic3RyaW5nXCIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbWFuYWdlZCBidWlsZGVyIGlkZW50aXR5XCIpO1xuICAgIGNvbnNvbGUubG9nKGBQcmVwYXJpbmcgJHtidWlsZGVyfSBpbWFnZSB1c2luZyB0aGUgbWFuYWdlZCBEb2NrZXIgc3RvcmUgYXQgJHtkaXJlY3Rvcnl9YCk7XG4gICAgY29uc3Qgdm9sdW1lcyA9IHJlY29yZHMobWFuYWdlZC52b2x1bWVzLCBcIkludmFsaWQgbWFuYWdlZCBidWlsZGVyIHZvbHVtZXNcIik7XG4gICAgY29uc3QgbW91bnRzID0gdm9sdW1lcy5mbGF0TWFwKCh7IG5hbWUsIGRlc3RpbmF0aW9uIH0pID0+IHtcbiAgICAgIGlmICh0eXBlb2YgbmFtZSAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgZGVzdGluYXRpb24gIT09IFwic3RyaW5nXCIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbWFuYWdlZCBidWlsZGVyIG1vdW50XCIpO1xuICAgICAgcmV0dXJuIFtcIi0tbW91bnRcIiwgYHR5cGU9dm9sdW1lLHNyYz0ke25hbWV9LGRzdD0ke2Rlc3RpbmF0aW9ufWBdO1xuICAgIH0pO1xuICAgIHNjb3BlLmRlZmVyKGFzeW5jICgpID0+IHtcbiAgICAgIGlmIChhd2FpdCBydW4oW1wiY29udGFpbmVyXCIsIFwibHNcIiwgXCItLWFsbFwiLCBcIi0tcXVpZXRcIiwgXCItLWZpbHRlclwiLCBgbmFtZT1eLyR7Y29udGFpbmVyfSRgXSwgdHJ1ZSwgdHJ1ZSkpXG4gICAgICAgIGF3YWl0IHJ1bihbXCJybVwiLCBjb250YWluZXJdLCBmYWxzZSwgdHJ1ZSk7XG4gICAgfSk7XG4gICAgc2NvcGUuZGVmZXIoYXN5bmMgKCkgPT4ge1xuICAgICAgaWYgKGF3YWl0IHJ1bihbXCJjb250YWluZXJcIiwgXCJsc1wiLCBcIi0tYWxsXCIsIFwiLS1xdWlldFwiLCBcIi0tZmlsdGVyXCIsIGBuYW1lPV4vJHtjb250YWluZXJ9JGBdLCB0cnVlLCB0cnVlKSlcbiAgICAgICAgYXdhaXQgcnVuKFtcInN0b3BcIiwgY29udGFpbmVyXSwgZmFsc2UsIHRydWUpO1xuICAgIH0sIFwic2h1dGRvd25cIik7XG4gICAgYXdhaXQgcnVuKFtcbiAgICAgIFwiY3JlYXRlXCIsXG4gICAgICBcIi0tcGxhdGZvcm1cIixcbiAgICAgIHBsYXRmb3JtLFxuICAgICAgXCItLW5hbWVcIixcbiAgICAgIGNvbnRhaW5lcixcbiAgICAgIFwiLS1jYXAtYWRkPVNZU19BRE1JTlwiLFxuICAgICAgXCItLWNhcC1hZGQ9TkVUX0FETUlOXCIsXG4gICAgICBcIi0tc2VjdXJpdHktb3B0PXNlY2NvbXA9dW5jb25maW5lZFwiLFxuICAgICAgXCItLXVsaW1pdD1ub2ZpbGU9NjU1MzY6NjU1MzZcIixcbiAgICAgIC4uLm1vdW50cyxcbiAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgYHR5cGU9YmluZCxzcmM9JHtyb290fSxkc3Q9L3ByZXBhcmF0aW9uLHJlYWRvbmx5YCxcbiAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgYHR5cGU9YmluZCxzcmM9JHt0ZW1wb3Jhcnl9LGRzdD0vb3V0cHV0YCxcbiAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgYHR5cGU9YmluZCxzcmM9JHtkaXN0cmlidXRpb259LGRzdD0vd29ya2JlbmNoLHJlYWRvbmx5YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIFwiV09SS0JFTkNIX1BSRVBBUkFUSU9OX0RJU1RSSUJVVElPTj0vd29ya2JlbmNoXCIsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX01BTkFHRURfQ09SRVM9JHtTdHJpbmcocHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfQ09SRVMgPz8gMSl9YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIGBXT1JLQkVOQ0hfTUFOQUdFRF9KT0JTPSR7U3RyaW5nKHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0pPQlMgPz8gMSl9YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIFwiV09SS0JFTkNIX1JPT1RTX0ZJTEU9L291dHB1dC9yb290cy5qc29uXCIsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX0lNQUdFX0lOUFVUUz0ke1N0cmluZyhpbnB1dHMpfWAsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX0lNQUdFX0FSQ0hJVEVDVFVSRT0ke2FyY2hpdGVjdHVyZX1gLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgYFdPUktCRU5DSF9QUklWQVRFX0JVSUxERVI9JHtrZXl9YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIGBXT1JLQkVOQ0hfUFJFUEFSQVRJT05fT1dORVI9JHtwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUFJFUEFSQVRJT05fT1dORVIgPz8gYnVpbGRlck93bmVyKHJvb3QpfWAsXG4gICAgICBcIi0td29ya2RpclwiLFxuICAgICAgXCIvcHJlcGFyYXRpb25cIixcbiAgICAgIFwiLS1lbnRyeXBvaW50XCIsXG4gICAgICBcIi9iaW4vc2hcIixcbiAgICAgIGJvb3RzdHJhcCxcbiAgICAgIFwiL3ByZXBhcmF0aW9uLy5kZXZjb250YWluZXIvbWFuYWdlZC1idWlsZC5zaFwiLFxuICAgICAgYnVpbGRlcixcbiAgICBdKTtcbiAgICBhd2FpdCBydW4oW1wic3RhcnRcIiwgXCItLWF0dGFjaFwiLCBjb250YWluZXJdKTtcbiAgICBjb25zdCBzdGF0dXMgPSBhd2FpdCBydW4oW1wiaW5zcGVjdFwiLCBcIi0tZm9ybWF0XCIsIFwie3suU3RhdGUuRXhpdENvZGV9fVwiLCBjb250YWluZXJdLCB0cnVlKTtcbiAgICBpZiAoc3RhdHVzICE9PSBcIjBcIikgdGhyb3cgbmV3IEVycm9yKGAke2J1aWxkZXJ9IGltYWdlIGFzc2VtYmx5IGZhaWxlZDogZXhpdCAke3N0YXR1c31gKTtcbiAgICAvLyBUaGUgYnVpbGRlciBwcm9kdWNlcyBhIERvY2tlciBhcmNoaXZlOyBEb2NrZXIgb3ducyBpbXBvcnRpbmcgaXRzIGxheWVycyBhbmQgbWV0YWRhdGEuXG4gICAgY29uc3QgYXJjaGl2ZSA9IHJlYWRGaWxlU3luYyhqb2luKHRlbXBvcmFyeSwgXCJpbWFnZS1wYXRoXCIpLCBcInV0ZjhcIikudHJpbSgpO1xuICAgIGlmICghYXJjaGl2ZS5zdGFydHNXaXRoKGJ1aWxkZXIgPT09IFwiZ3VpeFwiID8gXCIvZ251L3N0b3JlL1wiIDogXCIvbml4L3N0b3JlL1wiKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkJ1aWxkZXIgcmV0dXJuZWQgYW4gaW52YWxpZCBpbWFnZSBzdG9yZSBwYXRoXCIpO1xuICAgIGlmIChyZXN1bHQpIHtcbiAgICAgIHBpbiA9IG1hbmFnZWRTdG9yZVBpbihKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHRlbXBvcmFyeSwgXCJzdG9yZS1waW4uanNvblwiKSwgXCJ1dGY4XCIpKSk7XG4gICAgICBpZiAocGluLmJ1aWxkZXIgIT09IGJ1aWxkZXIgfHwgcGluLmtleSAhPT0ga2V5KSB0aHJvdyBuZXcgRXJyb3IoXCJCdWlsZGVyIHJlcG9ydGVkIGEgZGlmZmVyZW50IHN0b3JlIHBpblwiKTtcbiAgICB9XG4gICAgYXdhaXQgaW1wb3J0TWFuYWdlZEltYWdlKHNjb3BlLCBhcmNoaXZlLCBpbWFnZSwgY29udGFpbmVyKTtcbiAgfVxuICBpZiAoYnVpbGRlciA9PT0gXCJndWl4XCIpIHtcbiAgICBjb25zdCB7IG1hdGVyaWFsaXplIH0gPSBndWl4SW1hZ2VEZWZpbml0aW9uKHJvb3QpO1xuICAgIGF3YWl0IHJ1bihcbiAgICAgIFtcbiAgICAgICAgam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwiaW1hZ2UtZmluYWxpemVcIixcbiAgICAgICAgaW1hZ2UsXG4gICAgICAgIGltYWdlLFxuICAgICAgICAuLi4obWF0ZXJpYWxpemUubGVuZ3RoID8gW1wiLS1tYXRlcmlhbGl6ZVwiLCAuLi5tYXRlcmlhbGl6ZV0gOiBbXSksXG4gICAgICBdLFxuICAgICAgZmFsc2UsXG4gICAgICBmYWxzZSxcbiAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgKTtcbiAgfVxuICBpZiAocmVzdWx0ICYmIHBpbikgd3JpdGVBdG9taWMocmVzdWx0LCBKU09OLnN0cmluZ2lmeShwaW4pICsgXCJcXG5cIiwgMG82MDApO1xufSk7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxT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LE1BQU0sd0NBQXdDO0FBQUEsSUFDMUc7QUFDQSxVQUFNLG1CQUFtQixPQUFPLFNBQVMsT0FBTyxTQUFTO0FBQUEsRUFDM0Q7QUFDQSxNQUFJLFlBQVksUUFBUTtBQUN0QixVQUFNLEVBQUUsWUFBWSxJQUFJLG9CQUFvQixJQUFJO0FBQ2hELFVBQU07QUFBQSxNQUNKO0FBQUEsUUFDRSxLQUFLLGNBQWMsbUJBQW1CO0FBQUEsUUFDdEM7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0EsR0FBSSxZQUFZLFNBQVMsQ0FBQyxpQkFBaUIsR0FBRyxXQUFXLElBQUksQ0FBQztBQUFBLE1BQ2hFO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLFFBQVE7QUFBQSxJQUNWO0FBQUEsRUFDRjtBQUNBLE1BQUksVUFBVSxJQUFLLGFBQVksUUFBUSxLQUFLLFVBQVUsR0FBRyxJQUFJLE1BQU0sR0FBSztBQUMxRSxDQUFDOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvcHJlcGFyZS1tYW5hZ2VkLWRldmVsb3BtZW50Lm1qcyJ9
