// Generated from prepare-managed-development.mts; edit the TypeScript source.
import { required, isStringArray } from "./values.mjs";
import { guixImageDefinition } from "./pack-guix-image.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
import { importManagedImage } from "./managed-image-import.mjs";
import { builderVolumes, builderCacheKey, guixChannelFile } from "./managed-contract.mjs";
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
  writeFileSync(join(temporary, "roots.json"), JSON.stringify(roots));
  mkdirSync(join(temporary, "profiles"));
  const installed = await scope.run(builder, ["--version"], { capture: true, missing: true });
  if (installed !== void 0) {
    console.log(`Preparing ${builder} image using the host store`);
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
    console.log(`Preparing ${builder} image using a Docker builder (${builder} is not installed)`);
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
      ...builder === "guix" ? [
        "--build-arg",
        `WORKBENCH_GUIX_CHANNELS=${relative(root, guixChannelFile(root, join(root, required(roots[0], "Missing managed root")))).replaceAll("\\", "/")}`
      ] : [],
      root
    ]);
    const identity = await run(["image", "inspect", "--format", "{{.Id}}", bootstrap], true);
    const cache = builderCacheKey(process.env.WORKBENCH_PREPARATION_OWNER ?? root, builder, architecture, identity);
    const volumes = builderVolumes(builder, cache);
    for (const volume of volumes) await run(["volume", "create", volume.name]);
    const maintenance = JSON.parse(
      await run(
        [join(distribution, "bin/workbench.mjs"), "managed-builder-record", builder, cache],
        true,
        false,
        process.execPath
      )
    );
    if (!maintenance || typeof maintenance !== "object" || !("collect" in maintenance) || typeof maintenance.collect !== "boolean")
      throw new Error("Invalid private builder maintenance selection");
    const mounts = volumes.flatMap(({ name, destination }) => [
      "--mount",
      `type=volume,src=${name},dst=${destination}`
    ]);
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
      `WORKBENCH_PRIVATE_BUILDER=${cache}`,
      "--env",
      `WORKBENCH_BUILDER_GC=${String(maintenance.collect)}`,
      ...process.env.WORKBENCH_BUILDER_RETAIN_INPUTS === void 0 ? [] : ["--env", `WORKBENCH_BUILDER_RETAIN_INPUTS=${process.env.WORKBENCH_BUILDER_RETAIN_INPUTS}`],
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
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVxdWlyZWQsIGlzU3RyaW5nQXJyYXkgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBndWl4SW1hZ2VEZWZpbml0aW9uIH0gZnJvbSBcIi4vcGFjay1ndWl4LWltYWdlLm1qc1wiO1xuaW1wb3J0IHsgd2l0aE1hbmFnZWRQcm9jZXNzZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLXByb2Nlc3MubWpzXCI7XG5pbXBvcnQgeyBpbXBvcnRNYW5hZ2VkSW1hZ2UgfSBmcm9tIFwiLi9tYW5hZ2VkLWltYWdlLWltcG9ydC5tanNcIjtcbmltcG9ydCB7IGJ1aWxkZXJWb2x1bWVzLCBidWlsZGVyQ2FjaGVLZXksIGd1aXhDaGFubmVsRmlsZSB9IGZyb20gXCIuL21hbmFnZWQtY29udHJhY3QubWpzXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSwgcmVsYXRpdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8vIEJ1aWxkZXIgcmVjaXBlcyBhc3NlbWJsZSBvbmx5IGRlY2xhcmVkIGNsb3N1cmVzLiBWZXJpZmljYXRpb24gaXMgYSBzZXBhcmF0ZSBmcmVzaC1zb3VyY2UgaW52b2NhdGlvbi5cbmNvbnN0IFtidWlsZGVyLCBpbWFnZV0gPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMik7XG5pZiAoKGJ1aWxkZXIgIT09IFwibml4XCIgJiYgYnVpbGRlciAhPT0gXCJndWl4XCIpIHx8ICFpbWFnZSlcbiAgdGhyb3cgbmV3IEVycm9yKFwiVXNlIHByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tanMgbml4fGd1aXggSU1BR0VcIik7XG5jb25zdCByb290ID0gcHJvY2Vzcy5jd2QoKTtcbmNvbnN0IGlucHV0cyA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9JTUFHRV9JTlBVVFM7XG5pZiAoIS9eW2EtZjAtOV17NjR9JC8udGVzdChpbnB1dHMgPz8gXCJcIikpXG4gIHRocm93IG5ldyBFcnJvcihcIlVzZSB3b3JrYmVuY2ggZGV2ZWxvcG1lbnQgcHJlcGFyZSB0byBzZWxlY3QgdGhlIGltYWdlIGlucHV0c1wiKTtcbmNvbnN0IGRpc3RyaWJ1dGlvbiA9IHJlc29sdmUoaW1wb3J0Lm1ldGEuZGlybmFtZSwgXCIuLlwiKTtcbmNvbnN0IGFyY2hpdGVjdHVyZSA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9JTUFHRV9BUkNISVRFQ1RVUkUgPz8gcHJvY2Vzcy5hcmNoO1xuaWYgKCFbXCJ4NjRcIiwgXCJhcm02NFwiXS5pbmNsdWRlcyhhcmNoaXRlY3R1cmUpKSB0aHJvdyBuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBtYW5hZ2VkIGltYWdlIGFyY2hpdGVjdHVyZVwiKTtcbi8vIFRoZSBtYW5hZ2VyIHJlbWFpbnMgbmF0aXZlOyBiaW5mbXQgZXhlY3V0ZXMgZm9yZWlnbiBwYWNrYWdlIGJ1aWxkZXJzLlxuY29uc3QgcGxhdGZvcm0gPSBgbGludXgvJHtwcm9jZXNzLmFyY2ggPT09IFwieDY0XCIgPyBcImFtZDY0XCIgOiBcImFybTY0XCJ9YDtcbmF3YWl0IHdpdGhNYW5hZ2VkUHJvY2Vzc2VzKGFzeW5jIChzY29wZSkgPT4ge1xuICBjb25zdCBydW4gPSAoYXJnczogc3RyaW5nW10sIGNhcHR1cmUgPSBmYWxzZSwgY2xlYW51cCA9IGZhbHNlLCBleGVjdXRhYmxlID0gXCJkb2NrZXJcIikgPT5cbiAgICBleGVjdXRhYmxlID09PSBcImRvY2tlclwiICYmIGFyZ3NbMF0gPT09IFwiYnVpbGRcIlxuICAgICAgPyBzY29wZS5ydW4oXG4gICAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgICBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIFwiYnVpbGRraXQtYnVpbGRcIiwgXCItLVwiLCAuLi5hcmdzLnNsaWNlKDEpXSxcbiAgICAgICAgICB7IGNhcHR1cmUsIGNsZWFudXAgfSxcbiAgICAgICAgKVxuICAgICAgOiBzY29wZS5ydW4oZXhlY3V0YWJsZSwgYXJncywgeyBjYXB0dXJlLCBjbGVhbnVwIH0pO1xuICBjb25zdCByb290czogdW5rbm93biA9IEpTT04ucGFyc2UoXG4gICAgYXdhaXQgc2NvcGUucnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJpbWFnZS1yb290c1wiXSwge1xuICAgICAgY2FwdHVyZTogdHJ1ZSxcbiAgICAgIGN3ZDogcm9vdCxcbiAgICB9KSxcbiAgKTtcbiAgaWYgKCFpc1N0cmluZ0FycmF5KHJvb3RzKSB8fCAhcm9vdHMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJQcmVwYXJlZCBtYW5hZ2VkIGltYWdlcyBuZWVkIGNvbmZpZ3VyZWQgbGFuZ3VhZ2Ugcm9vdHNcIik7XG4gIGNvbnN0IHRlbXBvcmFyeSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid29ya2JlbmNoLW1hbmFnZWQtaW1hZ2UtXCIpKTtcbiAgc2NvcGUuZGVmZXIoKCkgPT4ge1xuICAgIHJtU3luYyh0ZW1wb3JhcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG4gIGNvbnN0IGJvb3RzdHJhcCA9IGB3b3JrYmVuY2gtYnVpbGRlcjoke3JhbmRvbVVVSUQoKX1gO1xuICBjb25zdCBjb250YWluZXIgPSBgd29ya2JlbmNoLWJ1aWxkZXItJHtyYW5kb21VVUlEKCl9YDtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBvcmFyeSwgXCJyb290cy5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShyb290cykpO1xuICBta2RpclN5bmMoam9pbih0ZW1wb3JhcnksIFwicHJvZmlsZXNcIikpO1xuICBjb25zdCBpbnN0YWxsZWQgPSBhd2FpdCBzY29wZS5ydW4oYnVpbGRlciwgW1wiLS12ZXJzaW9uXCJdLCB7IGNhcHR1cmU6IHRydWUsIG1pc3Npbmc6IHRydWUgfSk7XG4gIGlmIChpbnN0YWxsZWQgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnNvbGUubG9nKGBQcmVwYXJpbmcgJHtidWlsZGVyfSBpbWFnZSB1c2luZyB0aGUgaG9zdCBzdG9yZWApO1xuICAgIGF3YWl0IHJ1bihcbiAgICAgIFtcbiAgICAgICAgam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwibWFuYWdlZC1pbWFnZS1wcmVwYXJlXCIsXG4gICAgICAgIGJ1aWxkZXIsXG4gICAgICAgIGltYWdlLFxuICAgICAgICBqb2luKHRlbXBvcmFyeSwgXCJyb290cy5qc29uXCIpLFxuICAgICAgICB0ZW1wb3JhcnksXG4gICAgICBdLFxuICAgICAgZmFsc2UsXG4gICAgICBmYWxzZSxcbiAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZyhgUHJlcGFyaW5nICR7YnVpbGRlcn0gaW1hZ2UgdXNpbmcgYSBEb2NrZXIgYnVpbGRlciAoJHtidWlsZGVyfSBpcyBub3QgaW5zdGFsbGVkKWApO1xuICAgIHNjb3BlLmRlZmVyKGFzeW5jICgpID0+IHtcbiAgICAgIGlmIChhd2FpdCBydW4oW1wiaW1hZ2VcIiwgXCJsc1wiLCBcIi0tcXVpZXRcIiwgXCItLWZpbHRlclwiLCBgcmVmZXJlbmNlPSR7Ym9vdHN0cmFwfWBdLCB0cnVlLCB0cnVlKSlcbiAgICAgICAgYXdhaXQgcnVuKFtcImltYWdlXCIsIFwicm1cIiwgYm9vdHN0cmFwXSwgZmFsc2UsIHRydWUpO1xuICAgIH0pO1xuICAgIGF3YWl0IHJ1bihbXG4gICAgICBcImJ1aWxkXCIsXG4gICAgICAuLi4oYnVpbGRlciA9PT0gXCJndWl4XCIgPyBbXCItLW5vLWNhY2hlLWZpbHRlclwiLCBcImJhc2VcIl0gOiBbXSksXG4gICAgICBcIi0tcGxhdGZvcm1cIixcbiAgICAgIHBsYXRmb3JtLFxuICAgICAgXCItLW5ldHdvcms9aG9zdFwiLFxuICAgICAgXCItLXVsaW1pdD1ub2ZpbGU9NjU1MzY6NjU1MzZcIixcbiAgICAgIFwiLS10YXJnZXRcIixcbiAgICAgIFwiYmFzZVwiLFxuICAgICAgXCItLWZpbGVcIixcbiAgICAgIGpvaW4ocm9vdCwgXCIuZGV2Y29udGFpbmVyXCIsIGJ1aWxkZXIsIFwiRG9ja2VyZmlsZVwiKSxcbiAgICAgIFwiLS10YWdcIixcbiAgICAgIGJvb3RzdHJhcCxcbiAgICAgIC4uLihidWlsZGVyID09PSBcImd1aXhcIlxuICAgICAgICA/IFtcbiAgICAgICAgICAgIFwiLS1idWlsZC1hcmdcIixcbiAgICAgICAgICAgIGBXT1JLQkVOQ0hfR1VJWF9DSEFOTkVMUz0ke3JlbGF0aXZlKHJvb3QsIGd1aXhDaGFubmVsRmlsZShyb290LCBqb2luKHJvb3QsIHJlcXVpcmVkKHJvb3RzWzBdLCBcIk1pc3NpbmcgbWFuYWdlZCByb290XCIpKSkpLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKX1gLFxuICAgICAgICAgIF1cbiAgICAgICAgOiBbXSksXG4gICAgICByb290LFxuICAgIF0pO1xuICAgIGNvbnN0IGlkZW50aXR5ID0gYXdhaXQgcnVuKFtcImltYWdlXCIsIFwiaW5zcGVjdFwiLCBcIi0tZm9ybWF0XCIsIFwie3suSWR9fVwiLCBib290c3RyYXBdLCB0cnVlKTtcbiAgICBjb25zdCBjYWNoZSA9IGJ1aWxkZXJDYWNoZUtleShwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUFJFUEFSQVRJT05fT1dORVIgPz8gcm9vdCwgYnVpbGRlciwgYXJjaGl0ZWN0dXJlLCBpZGVudGl0eSk7XG4gICAgY29uc3Qgdm9sdW1lcyA9IGJ1aWxkZXJWb2x1bWVzKGJ1aWxkZXIsIGNhY2hlKTtcbiAgICBmb3IgKGNvbnN0IHZvbHVtZSBvZiB2b2x1bWVzKSBhd2FpdCBydW4oW1widm9sdW1lXCIsIFwiY3JlYXRlXCIsIHZvbHVtZS5uYW1lXSk7XG4gICAgY29uc3QgbWFpbnRlbmFuY2U6IHVua25vd24gPSBKU09OLnBhcnNlKFxuICAgICAgYXdhaXQgcnVuKFxuICAgICAgICBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIFwibWFuYWdlZC1idWlsZGVyLXJlY29yZFwiLCBidWlsZGVyLCBjYWNoZV0sXG4gICAgICAgIHRydWUsXG4gICAgICAgIGZhbHNlLFxuICAgICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgKSxcbiAgICApO1xuICAgIGlmIChcbiAgICAgICFtYWludGVuYW5jZSB8fFxuICAgICAgdHlwZW9mIG1haW50ZW5hbmNlICE9PSBcIm9iamVjdFwiIHx8XG4gICAgICAhKFwiY29sbGVjdFwiIGluIG1haW50ZW5hbmNlKSB8fFxuICAgICAgdHlwZW9mIG1haW50ZW5hbmNlLmNvbGxlY3QgIT09IFwiYm9vbGVhblwiXG4gICAgKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBwcml2YXRlIGJ1aWxkZXIgbWFpbnRlbmFuY2Ugc2VsZWN0aW9uXCIpO1xuICAgIGNvbnN0IG1vdW50cyA9IHZvbHVtZXMuZmxhdE1hcCgoeyBuYW1lLCBkZXN0aW5hdGlvbiB9KSA9PiBbXG4gICAgICBcIi0tbW91bnRcIixcbiAgICAgIGB0eXBlPXZvbHVtZSxzcmM9JHtuYW1lfSxkc3Q9JHtkZXN0aW5hdGlvbn1gLFxuICAgIF0pO1xuICAgIHNjb3BlLmRlZmVyKGFzeW5jICgpID0+IHtcbiAgICAgIGlmIChhd2FpdCBydW4oW1wiY29udGFpbmVyXCIsIFwibHNcIiwgXCItLWFsbFwiLCBcIi0tcXVpZXRcIiwgXCItLWZpbHRlclwiLCBgbmFtZT1eLyR7Y29udGFpbmVyfSRgXSwgdHJ1ZSwgdHJ1ZSkpXG4gICAgICAgIGF3YWl0IHJ1bihbXCJybVwiLCBjb250YWluZXJdLCBmYWxzZSwgdHJ1ZSk7XG4gICAgfSk7XG4gICAgc2NvcGUuZGVmZXIoYXN5bmMgKCkgPT4ge1xuICAgICAgaWYgKGF3YWl0IHJ1bihbXCJjb250YWluZXJcIiwgXCJsc1wiLCBcIi0tYWxsXCIsIFwiLS1xdWlldFwiLCBcIi0tZmlsdGVyXCIsIGBuYW1lPV4vJHtjb250YWluZXJ9JGBdLCB0cnVlLCB0cnVlKSlcbiAgICAgICAgYXdhaXQgcnVuKFtcInN0b3BcIiwgY29udGFpbmVyXSwgZmFsc2UsIHRydWUpO1xuICAgIH0sIFwic2h1dGRvd25cIik7XG4gICAgYXdhaXQgcnVuKFtcbiAgICAgIFwiY3JlYXRlXCIsXG4gICAgICBcIi0tcGxhdGZvcm1cIixcbiAgICAgIHBsYXRmb3JtLFxuICAgICAgXCItLW5hbWVcIixcbiAgICAgIGNvbnRhaW5lcixcbiAgICAgIFwiLS1jYXAtYWRkPVNZU19BRE1JTlwiLFxuICAgICAgXCItLWNhcC1hZGQ9TkVUX0FETUlOXCIsXG4gICAgICBcIi0tc2VjdXJpdHktb3B0PXNlY2NvbXA9dW5jb25maW5lZFwiLFxuICAgICAgXCItLXVsaW1pdD1ub2ZpbGU9NjU1MzY6NjU1MzZcIixcbiAgICAgIC4uLm1vdW50cyxcbiAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgYHR5cGU9YmluZCxzcmM9JHtyb290fSxkc3Q9L3ByZXBhcmF0aW9uLHJlYWRvbmx5YCxcbiAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgYHR5cGU9YmluZCxzcmM9JHt0ZW1wb3Jhcnl9LGRzdD0vb3V0cHV0YCxcbiAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgYHR5cGU9YmluZCxzcmM9JHtkaXN0cmlidXRpb259LGRzdD0vd29ya2JlbmNoLHJlYWRvbmx5YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIFwiV09SS0JFTkNIX1BSRVBBUkFUSU9OX0RJU1RSSUJVVElPTj0vd29ya2JlbmNoXCIsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX01BTkFHRURfQ09SRVM9JHtTdHJpbmcocHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfQ09SRVMgPz8gMSl9YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIGBXT1JLQkVOQ0hfTUFOQUdFRF9KT0JTPSR7U3RyaW5nKHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0pPQlMgPz8gMSl9YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIFwiV09SS0JFTkNIX1JPT1RTX0ZJTEU9L291dHB1dC9yb290cy5qc29uXCIsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX0lNQUdFX0lOUFVUUz0ke1N0cmluZyhpbnB1dHMpfWAsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX0lNQUdFX0FSQ0hJVEVDVFVSRT0ke2FyY2hpdGVjdHVyZX1gLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgYFdPUktCRU5DSF9QUklWQVRFX0JVSUxERVI9JHtjYWNoZX1gLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgYFdPUktCRU5DSF9CVUlMREVSX0dDPSR7U3RyaW5nKG1haW50ZW5hbmNlLmNvbGxlY3QpfWAsXG4gICAgICAuLi4ocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0JVSUxERVJfUkVUQUlOX0lOUFVUUyA9PT0gdW5kZWZpbmVkXG4gICAgICAgID8gW11cbiAgICAgICAgOiBbXCItLWVudlwiLCBgV09SS0JFTkNIX0JVSUxERVJfUkVUQUlOX0lOUFVUUz0ke3Byb2Nlc3MuZW52LldPUktCRU5DSF9CVUlMREVSX1JFVEFJTl9JTlBVVFN9YF0pLFxuICAgICAgXCItLXdvcmtkaXJcIixcbiAgICAgIFwiL3ByZXBhcmF0aW9uXCIsXG4gICAgICBcIi0tZW50cnlwb2ludFwiLFxuICAgICAgXCIvYmluL3NoXCIsXG4gICAgICBib290c3RyYXAsXG4gICAgICBcIi9wcmVwYXJhdGlvbi8uZGV2Y29udGFpbmVyL21hbmFnZWQtYnVpbGQuc2hcIixcbiAgICAgIGJ1aWxkZXIsXG4gICAgXSk7XG4gICAgYXdhaXQgcnVuKFtcInN0YXJ0XCIsIFwiLS1hdHRhY2hcIiwgY29udGFpbmVyXSk7XG4gICAgY29uc3Qgc3RhdHVzID0gYXdhaXQgcnVuKFtcImluc3BlY3RcIiwgXCItLWZvcm1hdFwiLCBcInt7LlN0YXRlLkV4aXRDb2RlfX1cIiwgY29udGFpbmVyXSwgdHJ1ZSk7XG4gICAgaWYgKHN0YXR1cyAhPT0gXCIwXCIpIHRocm93IG5ldyBFcnJvcihgJHtidWlsZGVyfSBpbWFnZSBhc3NlbWJseSBmYWlsZWQ6IGV4aXQgJHtzdGF0dXN9YCk7XG4gICAgLy8gVGhlIGJ1aWxkZXIgcHJvZHVjZXMgYSBEb2NrZXIgYXJjaGl2ZTsgRG9ja2VyIG93bnMgaW1wb3J0aW5nIGl0cyBsYXllcnMgYW5kIG1ldGFkYXRhLlxuICAgIGNvbnN0IGFyY2hpdmUgPSByZWFkRmlsZVN5bmMoam9pbih0ZW1wb3JhcnksIFwiaW1hZ2UtcGF0aFwiKSwgXCJ1dGY4XCIpLnRyaW0oKTtcbiAgICBpZiAoIWFyY2hpdmUuc3RhcnRzV2l0aChidWlsZGVyID09PSBcImd1aXhcIiA/IFwiL2dudS9zdG9yZS9cIiA6IFwiL25peC9zdG9yZS9cIikpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJCdWlsZGVyIHJldHVybmVkIGFuIGludmFsaWQgaW1hZ2Ugc3RvcmUgcGF0aFwiKTtcbiAgICBhd2FpdCBpbXBvcnRNYW5hZ2VkSW1hZ2Uoc2NvcGUsIGFyY2hpdmUsIGltYWdlLCBjb250YWluZXIpO1xuICB9XG4gIGlmIChidWlsZGVyID09PSBcImd1aXhcIikge1xuICAgIGNvbnN0IHsgbWF0ZXJpYWxpemUgfSA9IGd1aXhJbWFnZURlZmluaXRpb24ocm9vdCk7XG4gICAgYXdhaXQgcnVuKFxuICAgICAgW1xuICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgXCJpbWFnZS1maW5hbGl6ZVwiLFxuICAgICAgICBpbWFnZSxcbiAgICAgICAgaW1hZ2UsXG4gICAgICAgIC4uLihtYXRlcmlhbGl6ZS5sZW5ndGggPyBbXCItLW1hdGVyaWFsaXplXCIsIC4uLm1hdGVyaWFsaXplXSA6IFtdKSxcbiAgICAgIF0sXG4gICAgICBmYWxzZSxcbiAgICAgIGZhbHNlLFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICApO1xuICB9XG59KTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsVUFBVSxxQkFBcUI7QUFDeEMsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyw0QkFBNEI7QUFDckMsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyxnQkFBZ0IsaUJBQWlCLHVCQUF1QjtBQUNqRSxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFdBQVcsYUFBYSxjQUFjLFFBQVEscUJBQXFCO0FBQzVFLFNBQVMsY0FBYztBQUN2QixTQUFTLE1BQU0sU0FBUyxnQkFBZ0I7QUFHeEMsTUFBTSxDQUFDLFNBQVMsS0FBSyxJQUFJLFFBQVEsS0FBSyxNQUFNLENBQUM7QUFDN0MsSUFBSyxZQUFZLFNBQVMsWUFBWSxVQUFXLENBQUM7QUFDaEQsUUFBTSxJQUFJLE1BQU0sb0RBQW9EO0FBQ3RFLE1BQU0sT0FBTyxRQUFRLElBQUk7QUFDekIsTUFBTSxTQUFTLFFBQVEsSUFBSTtBQUMzQixJQUFJLENBQUMsaUJBQWlCLEtBQUssVUFBVSxFQUFFO0FBQ3JDLFFBQU0sSUFBSSxNQUFNLDhEQUE4RDtBQUNoRixNQUFNLGVBQWUsUUFBUSxZQUFZLFNBQVMsSUFBSTtBQUN0RCxNQUFNLGVBQWUsUUFBUSxJQUFJLGdDQUFnQyxRQUFRO0FBQ3pFLElBQUksQ0FBQyxDQUFDLE9BQU8sT0FBTyxFQUFFLFNBQVMsWUFBWSxFQUFHLE9BQU0sSUFBSSxNQUFNLHdDQUF3QztBQUV0RyxNQUFNLFdBQVcsU0FBUyxRQUFRLFNBQVMsUUFBUSxVQUFVLE9BQU87QUFDcEUsTUFBTSxxQkFBcUIsT0FBTyxVQUFVO0FBQzFDLFFBQU0sTUFBTSxDQUFDLE1BQWdCLFVBQVUsT0FBTyxVQUFVLE9BQU8sYUFBYSxhQUMxRSxlQUFlLFlBQVksS0FBSyxDQUFDLE1BQU0sVUFDbkMsTUFB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QUFBQSxNQUNBLGlCQUFpQixZQUFZO0FBQUEsTUFDN0I7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0EsMkJBQTJCLE9BQU8sUUFBUSxJQUFJLDJCQUEyQixDQUFDLENBQUM7QUFBQSxNQUMzRTtBQUFBLE1BQ0EsMEJBQTBCLE9BQU8sUUFBUSxJQUFJLDBCQUEwQixDQUFDLENBQUM7QUFBQSxNQUN6RTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSwwQkFBMEIsT0FBTyxNQUFNLENBQUM7QUFBQSxNQUN4QztBQUFBLE1BQ0EsZ0NBQWdDLFlBQVk7QUFBQSxNQUM1QztBQUFBLE1BQ0EsNkJBQTZCLEtBQUs7QUFBQSxNQUNsQztBQUFBLE1BQ0Esd0JBQXdCLE9BQU8sWUFBWSxPQUFPLENBQUM7QUFBQSxNQUNuRCxHQUFJLFFBQVEsSUFBSSxvQ0FBb0MsU0FDaEQsQ0FBQyxJQUNELENBQUMsU0FBUyxtQ0FBbUMsUUFBUSxJQUFJLCtCQUErQixFQUFFO0FBQUEsTUFDOUY7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLENBQUM7QUFDRCxVQUFNLElBQUksQ0FBQyxTQUFTLFlBQVksU0FBUyxDQUFDO0FBQzFDLFVBQU0sU0FBUyxNQUFNLElBQUksQ0FBQyxXQUFXLFlBQVksdUJBQXVCLFNBQVMsR0FBRyxJQUFJO0FBQ3hGLFFBQUksV0FBVyxJQUFLLE9BQU0sSUFBSSxNQUFNLEdBQUcsT0FBTyxnQ0FBZ0MsTUFBTSxFQUFFO0FBRXRGLFVBQU0sVUFBVSxhQUFhLEtBQUssV0FBVyxZQUFZLEdBQUcsTUFBTSxFQUFFLEtBQUs7QUFDekUsUUFBSSxDQUFDLFFBQVEsV0FBVyxZQUFZLFNBQVMsZ0JBQWdCLGFBQWE7QUFDeEUsWUFBTSxJQUFJLE1BQU0sOENBQThDO0FBQ2hFLFVBQU0sbUJBQW1CLE9BQU8sU0FBUyxPQUFPLFNBQVM7QUFBQSxFQUMzRDtBQUNBLE1BQUksWUFBWSxRQUFRO0FBQ3RCLFVBQU0sRUFBRSxZQUFZLElBQUksb0JBQW9CLElBQUk7QUFDaEQsVUFBTTtBQUFBLE1BQ0o7QUFBQSxRQUNFLEtBQUssY0FBYyxtQkFBbUI7QUFBQSxRQUN0QztBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQSxHQUFJLFlBQVksU0FBUyxDQUFDLGlCQUFpQixHQUFHLFdBQVcsSUFBSSxDQUFDO0FBQUEsTUFDaEU7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0EsUUFBUTtBQUFBLElBQ1Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL3ByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tanMifQ==
