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
await withManagedProcesses(async (scope) => {
  const run = (args, capture = false, cleanup = false, executable = "docker") => executable === "docker" && args[0] === "build" ? scope.run(
    process.execPath,
    [join(distribution, "bin/workbench.mjs"), "buildkit-build", "--", ...args.slice(1)],
    { capture, cleanup }
  ) : scope.run(executable, args, { capture, cleanup });
  const roots = JSON.parse(
    await scope.run(process.execPath, [join(distribution, "bin/workbench.mjs"), "managed-image-roots"], {
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
    const cache = builderCacheKey(process.env.WORKBENCH_PREPARATION_OWNER ?? root, builder, process.arch, identity);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVxdWlyZWQsIGlzU3RyaW5nQXJyYXkgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBndWl4SW1hZ2VEZWZpbml0aW9uIH0gZnJvbSBcIi4vcGFjay1ndWl4LWltYWdlLm1qc1wiO1xuaW1wb3J0IHsgd2l0aE1hbmFnZWRQcm9jZXNzZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLXByb2Nlc3MubWpzXCI7XG5pbXBvcnQgeyBpbXBvcnRNYW5hZ2VkSW1hZ2UgfSBmcm9tIFwiLi9tYW5hZ2VkLWltYWdlLWltcG9ydC5tanNcIjtcbmltcG9ydCB7IGJ1aWxkZXJWb2x1bWVzLCBidWlsZGVyQ2FjaGVLZXksIGd1aXhDaGFubmVsRmlsZSB9IGZyb20gXCIuL21hbmFnZWQtY29udHJhY3QubWpzXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSwgcmVsYXRpdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8vIEJ1aWxkZXIgcmVjaXBlcyBhc3NlbWJsZSBvbmx5IGRlY2xhcmVkIGNsb3N1cmVzLiBWZXJpZmljYXRpb24gaXMgYSBzZXBhcmF0ZSBmcmVzaC1zb3VyY2UgaW52b2NhdGlvbi5cbmNvbnN0IFtidWlsZGVyLCBpbWFnZV0gPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMik7XG5pZiAoKGJ1aWxkZXIgIT09IFwibml4XCIgJiYgYnVpbGRlciAhPT0gXCJndWl4XCIpIHx8ICFpbWFnZSlcbiAgdGhyb3cgbmV3IEVycm9yKFwiVXNlIHByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tanMgbml4fGd1aXggSU1BR0VcIik7XG5jb25zdCByb290ID0gcHJvY2Vzcy5jd2QoKTtcbmNvbnN0IGlucHV0cyA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9JTUFHRV9JTlBVVFM7XG5pZiAoIS9eW2EtZjAtOV17NjR9JC8udGVzdChpbnB1dHMgPz8gXCJcIikpXG4gIHRocm93IG5ldyBFcnJvcihcIlVzZSB3b3JrYmVuY2ggZGV2ZWxvcG1lbnQgcHJlcGFyZSB0byBzZWxlY3QgdGhlIGltYWdlIGlucHV0c1wiKTtcbmNvbnN0IGRpc3RyaWJ1dGlvbiA9IHJlc29sdmUoaW1wb3J0Lm1ldGEuZGlybmFtZSwgXCIuLlwiKTtcbmF3YWl0IHdpdGhNYW5hZ2VkUHJvY2Vzc2VzKGFzeW5jIChzY29wZSkgPT4ge1xuICBjb25zdCBydW4gPSAoYXJnczogc3RyaW5nW10sIGNhcHR1cmUgPSBmYWxzZSwgY2xlYW51cCA9IGZhbHNlLCBleGVjdXRhYmxlID0gXCJkb2NrZXJcIikgPT5cbiAgICBleGVjdXRhYmxlID09PSBcImRvY2tlclwiICYmIGFyZ3NbMF0gPT09IFwiYnVpbGRcIlxuICAgICAgPyBzY29wZS5ydW4oXG4gICAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgICBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIFwiYnVpbGRraXQtYnVpbGRcIiwgXCItLVwiLCAuLi5hcmdzLnNsaWNlKDEpXSxcbiAgICAgICAgICB7IGNhcHR1cmUsIGNsZWFudXAgfSxcbiAgICAgICAgKVxuICAgICAgOiBzY29wZS5ydW4oZXhlY3V0YWJsZSwgYXJncywgeyBjYXB0dXJlLCBjbGVhbnVwIH0pO1xuICBjb25zdCByb290czogdW5rbm93biA9IEpTT04ucGFyc2UoXG4gICAgYXdhaXQgc2NvcGUucnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJtYW5hZ2VkLWltYWdlLXJvb3RzXCJdLCB7XG4gICAgICBjYXB0dXJlOiB0cnVlLFxuICAgICAgY3dkOiByb290LFxuICAgIH0pLFxuICApO1xuICBpZiAoIWlzU3RyaW5nQXJyYXkocm9vdHMpIHx8ICFyb290cy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcIlByZXBhcmVkIG1hbmFnZWQgaW1hZ2VzIG5lZWQgY29uZmlndXJlZCBsYW5ndWFnZSByb290c1wiKTtcbiAgY29uc3QgdGVtcG9yYXJ5ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJ3b3JrYmVuY2gtbWFuYWdlZC1pbWFnZS1cIikpO1xuICBzY29wZS5kZWZlcigoKSA9PiB7XG4gICAgcm1TeW5jKHRlbXBvcmFyeSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbiAgY29uc3QgYm9vdHN0cmFwID0gYHdvcmtiZW5jaC1idWlsZGVyOiR7cmFuZG9tVVVJRCgpfWA7XG4gIGNvbnN0IGNvbnRhaW5lciA9IGB3b3JrYmVuY2gtYnVpbGRlci0ke3JhbmRvbVVVSUQoKX1gO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcG9yYXJ5LCBcInJvb3RzLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHJvb3RzKSk7XG4gIG1rZGlyU3luYyhqb2luKHRlbXBvcmFyeSwgXCJwcm9maWxlc1wiKSk7XG4gIGNvbnN0IGluc3RhbGxlZCA9IGF3YWl0IHNjb3BlLnJ1bihidWlsZGVyLCBbXCItLXZlcnNpb25cIl0sIHsgY2FwdHVyZTogdHJ1ZSwgbWlzc2luZzogdHJ1ZSB9KTtcbiAgaWYgKGluc3RhbGxlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc29sZS5sb2coYFByZXBhcmluZyAke2J1aWxkZXJ9IGltYWdlIHVzaW5nIHRoZSBob3N0IHN0b3JlYCk7XG4gICAgYXdhaXQgcnVuKFxuICAgICAgW1xuICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgXCJtYW5hZ2VkLWltYWdlLXByZXBhcmVcIixcbiAgICAgICAgYnVpbGRlcixcbiAgICAgICAgaW1hZ2UsXG4gICAgICAgIGpvaW4odGVtcG9yYXJ5LCBcInJvb3RzLmpzb25cIiksXG4gICAgICAgIHRlbXBvcmFyeSxcbiAgICAgIF0sXG4gICAgICBmYWxzZSxcbiAgICAgIGZhbHNlLFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICApO1xuICB9IGVsc2Uge1xuICAgIGNvbnNvbGUubG9nKGBQcmVwYXJpbmcgJHtidWlsZGVyfSBpbWFnZSB1c2luZyBhIERvY2tlciBidWlsZGVyICgke2J1aWxkZXJ9IGlzIG5vdCBpbnN0YWxsZWQpYCk7XG4gICAgc2NvcGUuZGVmZXIoYXN5bmMgKCkgPT4ge1xuICAgICAgaWYgKGF3YWl0IHJ1bihbXCJpbWFnZVwiLCBcImxzXCIsIFwiLS1xdWlldFwiLCBcIi0tZmlsdGVyXCIsIGByZWZlcmVuY2U9JHtib290c3RyYXB9YF0sIHRydWUsIHRydWUpKVxuICAgICAgICBhd2FpdCBydW4oW1wiaW1hZ2VcIiwgXCJybVwiLCBib290c3RyYXBdLCBmYWxzZSwgdHJ1ZSk7XG4gICAgfSk7XG4gICAgYXdhaXQgcnVuKFtcbiAgICAgIFwiYnVpbGRcIixcbiAgICAgIFwiLS1uZXR3b3JrPWhvc3RcIixcbiAgICAgIFwiLS11bGltaXQ9bm9maWxlPTY1NTM2OjY1NTM2XCIsXG4gICAgICBcIi0tdGFyZ2V0XCIsXG4gICAgICBcImJhc2VcIixcbiAgICAgIFwiLS1maWxlXCIsXG4gICAgICBqb2luKHJvb3QsIFwiLmRldmNvbnRhaW5lclwiLCBidWlsZGVyLCBcIkRvY2tlcmZpbGVcIiksXG4gICAgICBcIi0tdGFnXCIsXG4gICAgICBib290c3RyYXAsXG4gICAgICAuLi4oYnVpbGRlciA9PT0gXCJndWl4XCJcbiAgICAgICAgPyBbXG4gICAgICAgICAgICBcIi0tYnVpbGQtYXJnXCIsXG4gICAgICAgICAgICBgV09SS0JFTkNIX0dVSVhfQ0hBTk5FTFM9JHtyZWxhdGl2ZShyb290LCBndWl4Q2hhbm5lbEZpbGUocm9vdCwgam9pbihyb290LCByZXF1aXJlZChyb290c1swXSwgXCJNaXNzaW5nIG1hbmFnZWQgcm9vdFwiKSkpKS5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIil9YCxcbiAgICAgICAgICBdXG4gICAgICAgIDogW10pLFxuICAgICAgcm9vdCxcbiAgICBdKTtcbiAgICBjb25zdCBpZGVudGl0eSA9IGF3YWl0IHJ1bihbXCJpbWFnZVwiLCBcImluc3BlY3RcIiwgXCItLWZvcm1hdFwiLCBcInt7LklkfX1cIiwgYm9vdHN0cmFwXSwgdHJ1ZSk7XG4gICAgY29uc3QgY2FjaGUgPSBidWlsZGVyQ2FjaGVLZXkocHJvY2Vzcy5lbnYuV09SS0JFTkNIX1BSRVBBUkFUSU9OX09XTkVSID8/IHJvb3QsIGJ1aWxkZXIsIHByb2Nlc3MuYXJjaCwgaWRlbnRpdHkpO1xuICAgIGNvbnN0IHZvbHVtZXMgPSBidWlsZGVyVm9sdW1lcyhidWlsZGVyLCBjYWNoZSk7XG4gICAgZm9yIChjb25zdCB2b2x1bWUgb2Ygdm9sdW1lcykgYXdhaXQgcnVuKFtcInZvbHVtZVwiLCBcImNyZWF0ZVwiLCB2b2x1bWUubmFtZV0pO1xuICAgIGNvbnN0IG1haW50ZW5hbmNlOiB1bmtub3duID0gSlNPTi5wYXJzZShcbiAgICAgIGF3YWl0IHJ1bihcbiAgICAgICAgW2pvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLCBcIm1hbmFnZWQtYnVpbGRlci1yZWNvcmRcIiwgYnVpbGRlciwgY2FjaGVdLFxuICAgICAgICB0cnVlLFxuICAgICAgICBmYWxzZSxcbiAgICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICksXG4gICAgKTtcbiAgICBpZiAoXG4gICAgICAhbWFpbnRlbmFuY2UgfHxcbiAgICAgIHR5cGVvZiBtYWludGVuYW5jZSAhPT0gXCJvYmplY3RcIiB8fFxuICAgICAgIShcImNvbGxlY3RcIiBpbiBtYWludGVuYW5jZSkgfHxcbiAgICAgIHR5cGVvZiBtYWludGVuYW5jZS5jb2xsZWN0ICE9PSBcImJvb2xlYW5cIlxuICAgIClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgcHJpdmF0ZSBidWlsZGVyIG1haW50ZW5hbmNlIHNlbGVjdGlvblwiKTtcbiAgICBjb25zdCBtb3VudHMgPSB2b2x1bWVzLmZsYXRNYXAoKHsgbmFtZSwgZGVzdGluYXRpb24gfSkgPT4gW1xuICAgICAgXCItLW1vdW50XCIsXG4gICAgICBgdHlwZT12b2x1bWUsc3JjPSR7bmFtZX0sZHN0PSR7ZGVzdGluYXRpb259YCxcbiAgICBdKTtcbiAgICBzY29wZS5kZWZlcihhc3luYyAoKSA9PiB7XG4gICAgICBpZiAoYXdhaXQgcnVuKFtcImNvbnRhaW5lclwiLCBcImxzXCIsIFwiLS1hbGxcIiwgXCItLXF1aWV0XCIsIFwiLS1maWx0ZXJcIiwgYG5hbWU9Xi8ke2NvbnRhaW5lcn0kYF0sIHRydWUsIHRydWUpKVxuICAgICAgICBhd2FpdCBydW4oW1wicm1cIiwgXCItLWZvcmNlXCIsIGNvbnRhaW5lcl0sIGZhbHNlLCB0cnVlKTtcbiAgICB9KTtcbiAgICBhd2FpdCBydW4oW1xuICAgICAgXCJjcmVhdGVcIixcbiAgICAgIFwiLS1uYW1lXCIsXG4gICAgICBjb250YWluZXIsXG4gICAgICBcIi0tY2FwLWFkZD1TWVNfQURNSU5cIixcbiAgICAgIFwiLS1jYXAtYWRkPU5FVF9BRE1JTlwiLFxuICAgICAgXCItLXNlY3VyaXR5LW9wdD1zZWNjb21wPXVuY29uZmluZWRcIixcbiAgICAgIFwiLS11bGltaXQ9bm9maWxlPTY1NTM2OjY1NTM2XCIsXG4gICAgICAuLi5tb3VudHMsXG4gICAgICBcIi0tbW91bnRcIixcbiAgICAgIGB0eXBlPWJpbmQsc3JjPSR7cm9vdH0sZHN0PS9wcmVwYXJhdGlvbixyZWFkb25seWAsXG4gICAgICBcIi0tbW91bnRcIixcbiAgICAgIGB0eXBlPWJpbmQsc3JjPSR7dGVtcG9yYXJ5fSxkc3Q9L291dHB1dGAsXG4gICAgICBcIi0tbW91bnRcIixcbiAgICAgIGB0eXBlPWJpbmQsc3JjPSR7ZGlzdHJpYnV0aW9ufSxkc3Q9L3dvcmtiZW5jaCxyZWFkb25seWAsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBcIldPUktCRU5DSF9QUkVQQVJBVElPTl9ESVNUUklCVVRJT049L3dvcmtiZW5jaFwiLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgYFdPUktCRU5DSF9NQU5BR0VEX0NPUkVTPSR7U3RyaW5nKHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0NPUkVTID8/IDEpfWAsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX01BTkFHRURfSk9CUz0ke1N0cmluZyhwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9KT0JTID8/IDEpfWAsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBcIldPUktCRU5DSF9ST09UU19GSUxFPS9vdXRwdXQvcm9vdHMuanNvblwiLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgYFdPUktCRU5DSF9JTUFHRV9JTlBVVFM9JHtTdHJpbmcoaW5wdXRzKX1gLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgYFdPUktCRU5DSF9QUklWQVRFX0JVSUxERVI9JHtjYWNoZX1gLFxuICAgICAgXCItLWVudlwiLFxuICAgICAgYFdPUktCRU5DSF9CVUlMREVSX0dDPSR7U3RyaW5nKG1haW50ZW5hbmNlLmNvbGxlY3QpfWAsXG4gICAgICAuLi4ocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0JVSUxERVJfUkVUQUlOX0lOUFVUUyA9PT0gdW5kZWZpbmVkXG4gICAgICAgID8gW11cbiAgICAgICAgOiBbXCItLWVudlwiLCBgV09SS0JFTkNIX0JVSUxERVJfUkVUQUlOX0lOUFVUUz0ke3Byb2Nlc3MuZW52LldPUktCRU5DSF9CVUlMREVSX1JFVEFJTl9JTlBVVFN9YF0pLFxuICAgICAgXCItLXdvcmtkaXJcIixcbiAgICAgIFwiL3ByZXBhcmF0aW9uXCIsXG4gICAgICBcIi0tZW50cnlwb2ludFwiLFxuICAgICAgXCIvYmluL3NoXCIsXG4gICAgICBib290c3RyYXAsXG4gICAgICBcIi9wcmVwYXJhdGlvbi8uZGV2Y29udGFpbmVyL21hbmFnZWQtYnVpbGQuc2hcIixcbiAgICAgIGJ1aWxkZXIsXG4gICAgXSk7XG4gICAgYXdhaXQgcnVuKFtcInN0YXJ0XCIsIFwiLS1hdHRhY2hcIiwgY29udGFpbmVyXSk7XG4gICAgY29uc3Qgc3RhdHVzID0gYXdhaXQgcnVuKFtcImluc3BlY3RcIiwgXCItLWZvcm1hdFwiLCBcInt7LlN0YXRlLkV4aXRDb2RlfX1cIiwgY29udGFpbmVyXSwgdHJ1ZSk7XG4gICAgaWYgKHN0YXR1cyAhPT0gXCIwXCIpIHRocm93IG5ldyBFcnJvcihgJHtidWlsZGVyfSBpbWFnZSBhc3NlbWJseSBmYWlsZWQ6IGV4aXQgJHtzdGF0dXN9YCk7XG4gICAgLy8gVGhlIGJ1aWxkZXIgcHJvZHVjZXMgYSBEb2NrZXIgYXJjaGl2ZTsgRG9ja2VyIG93bnMgaW1wb3J0aW5nIGl0cyBsYXllcnMgYW5kIG1ldGFkYXRhLlxuICAgIGNvbnN0IGFyY2hpdmUgPSByZWFkRmlsZVN5bmMoam9pbih0ZW1wb3JhcnksIFwiaW1hZ2UtcGF0aFwiKSwgXCJ1dGY4XCIpLnRyaW0oKTtcbiAgICBpZiAoIWFyY2hpdmUuc3RhcnRzV2l0aChidWlsZGVyID09PSBcImd1aXhcIiA/IFwiL2dudS9zdG9yZS9cIiA6IFwiL25peC9zdG9yZS9cIikpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJCdWlsZGVyIHJldHVybmVkIGFuIGludmFsaWQgaW1hZ2Ugc3RvcmUgcGF0aFwiKTtcbiAgICBhd2FpdCBpbXBvcnRNYW5hZ2VkSW1hZ2Uoc2NvcGUsIGFyY2hpdmUsIGltYWdlLCBjb250YWluZXIpO1xuICB9XG4gIGlmIChidWlsZGVyID09PSBcImd1aXhcIikge1xuICAgIGNvbnN0IHsgbWF0ZXJpYWxpemUgfSA9IGd1aXhJbWFnZURlZmluaXRpb24ocm9vdCk7XG4gICAgYXdhaXQgcnVuKFxuICAgICAgW1xuICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgXCJpbWFnZS1maW5hbGl6ZVwiLFxuICAgICAgICBpbWFnZSxcbiAgICAgICAgaW1hZ2UsXG4gICAgICAgIC4uLihtYXRlcmlhbGl6ZS5sZW5ndGggPyBbXCItLW1hdGVyaWFsaXplXCIsIC4uLm1hdGVyaWFsaXplXSA6IFtdKSxcbiAgICAgIF0sXG4gICAgICBmYWxzZSxcbiAgICAgIGZhbHNlLFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICApO1xuICB9XG59KTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsVUFBVSxxQkFBcUI7QUFDeEMsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyw0QkFBNEI7QUFDckMsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyxnQkFBZ0IsaUJBQWlCLHVCQUF1QjtBQUNqRSxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFdBQVcsYUFBYSxjQUFjLFFBQVEscUJBQXFCO0FBQzVFLFNBQVMsY0FBYztBQUN2QixTQUFTLE1BQU0sU0FBUyxnQkFBZ0I7QUFHeEMsTUFBTSxDQUFDLFNBQVMsS0FBSyxJQUFJLFFBQVEsS0FBSyxNQUFNLENBQUM7QUFDN0MsSUFBSyxZQUFZLFNBQVMsWUFBWSxVQUFXLENBQUM7QUFDaEQsUUFBTSxJQUFJLE1BQU0sb0RBQW9EO0FBQ3RFLE1BQU0sT0FBTyxRQUFRLElBQUk7QUFDekIsTUFBTSxTQUFTLFFBQVEsSUFBSTtBQUMzQixJQUFJLENBQUMsaUJBQWlCLEtBQUssVUFBVSxFQUFFO0FBQ3JDLFFBQU0sSUFBSSxNQUFNLDhEQUE4RDtBQUNoRixNQUFNLGVBQWUsUUFBUSxZQUFZLFNBQVMsSUFBSTtBQUN0RCxNQUFNLHFCQUFxQixPQUFPLFVBQVU7QUFDMUMsUUFBTSxNQUFNLENBQUMsTUFBZ0IsVUFBVSxPQUFPLFVBQVUsT0FBTyxhQUFhLGFBQzFFLGVBQWUsWUFBWSxLQUFLLENBQUMsTUFBTSxVQUNuQyxNQUFNO0FBQUEsSUFDSixRQUFRO0FBQUEsSUFDUixDQUFDLEtBQUssY0FB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
