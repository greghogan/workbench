// Generated from prepare-managed-development.mts; edit the TypeScript source.
import { required, isStringArray } from "./values.mjs";
import { guixImageDefinition } from "./pack-guix-image.mjs";
import { withManagedProcesses } from "./managed-process.mjs";
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
    await run(
      [join(distribution, "bin/workbench.mjs"), "managed-builder-record", builder, cache],
      false,
      false,
      process.execPath
    );
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
    const loaded = await run(
      [
        "-o",
        "pipefail",
        "-c",
        'docker cp "$1:$2" - | tar -xO | docker load',
        "workbench-image-import",
        container,
        archive
      ],
      true,
      false,
      "bash"
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
        ...materialize.length ? ["--materialize", ...materialize] : []
      ],
      false,
      false,
      process.execPath
    );
  }
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtbWFuYWdlZC1kZXZlbG9wbWVudC5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVxdWlyZWQsIGlzU3RyaW5nQXJyYXkgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBndWl4SW1hZ2VEZWZpbml0aW9uIH0gZnJvbSBcIi4vcGFjay1ndWl4LWltYWdlLm1qc1wiO1xuaW1wb3J0IHsgd2l0aE1hbmFnZWRQcm9jZXNzZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLXByb2Nlc3MubWpzXCI7XG5pbXBvcnQgeyBidWlsZGVyVm9sdW1lcywgYnVpbGRlckNhY2hlS2V5LCBndWl4Q2hhbm5lbEZpbGUgfSBmcm9tIFwiLi9tYW5hZ2VkLWNvbnRyYWN0Lm1qc1wiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4sIHJlc29sdmUsIHJlbGF0aXZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG4vLyBCdWlsZGVyIHJlY2lwZXMgYXNzZW1ibGUgb25seSBkZWNsYXJlZCBjbG9zdXJlcy4gVmVyaWZpY2F0aW9uIGlzIGEgc2VwYXJhdGUgZnJlc2gtc291cmNlIGludm9jYXRpb24uXG5jb25zdCBbYnVpbGRlciwgaW1hZ2VdID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpO1xuaWYgKChidWlsZGVyICE9PSBcIm5peFwiICYmIGJ1aWxkZXIgIT09IFwiZ3VpeFwiKSB8fCAhaW1hZ2UpXG4gIHRocm93IG5ldyBFcnJvcihcIlVzZSBwcmVwYXJlLW1hbmFnZWQtZGV2ZWxvcG1lbnQubWpzIG5peHxndWl4IElNQUdFXCIpO1xuY29uc3Qgcm9vdCA9IHByb2Nlc3MuY3dkKCk7XG5jb25zdCBpbnB1dHMgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfSU1BR0VfSU5QVVRTO1xuaWYgKCEvXlthLWYwLTldezY0fSQvLnRlc3QoaW5wdXRzID8/IFwiXCIpKVxuICB0aHJvdyBuZXcgRXJyb3IoXCJVc2Ugd29ya2JlbmNoIGRldmVsb3BtZW50IHByZXBhcmUgdG8gc2VsZWN0IHRoZSBpbWFnZSBpbnB1dHNcIik7XG5jb25zdCBkaXN0cmlidXRpb24gPSByZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiLi5cIik7XG5hd2FpdCB3aXRoTWFuYWdlZFByb2Nlc3Nlcyhhc3luYyAoc2NvcGUpID0+IHtcbiAgY29uc3QgcnVuID0gKGFyZ3M6IHN0cmluZ1tdLCBjYXB0dXJlID0gZmFsc2UsIGNsZWFudXAgPSBmYWxzZSwgZXhlY3V0YWJsZSA9IFwiZG9ja2VyXCIpID0+XG4gICAgZXhlY3V0YWJsZSA9PT0gXCJkb2NrZXJcIiAmJiBhcmdzWzBdID09PSBcImJ1aWxkXCJcbiAgICAgID8gc2NvcGUucnVuKFxuICAgICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgICAgW2pvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLCBcImJ1aWxka2l0LWJ1aWxkXCIsIFwiLS1cIiwgLi4uYXJncy5zbGljZSgxKV0sXG4gICAgICAgICAgeyBjYXB0dXJlLCBjbGVhbnVwIH0sXG4gICAgICAgIClcbiAgICAgIDogc2NvcGUucnVuKGV4ZWN1dGFibGUsIGFyZ3MsIHsgY2FwdHVyZSwgY2xlYW51cCB9KTtcbiAgY29uc3Qgcm9vdHM6IHVua25vd24gPSBKU09OLnBhcnNlKFxuICAgIGF3YWl0IHNjb3BlLnJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIFwibWFuYWdlZC1pbWFnZS1yb290c1wiXSwge1xuICAgICAgY2FwdHVyZTogdHJ1ZSxcbiAgICAgIGN3ZDogcm9vdCxcbiAgICB9KSxcbiAgKTtcbiAgaWYgKCFpc1N0cmluZ0FycmF5KHJvb3RzKSB8fCAhcm9vdHMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJQcmVwYXJlZCBtYW5hZ2VkIGltYWdlcyBuZWVkIGNvbmZpZ3VyZWQgbGFuZ3VhZ2Ugcm9vdHNcIik7XG4gIGNvbnN0IHRlbXBvcmFyeSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid29ya2JlbmNoLW1hbmFnZWQtaW1hZ2UtXCIpKTtcbiAgc2NvcGUuZGVmZXIoKCkgPT4ge1xuICAgIHJtU3luYyh0ZW1wb3JhcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG4gIGNvbnN0IGJvb3RzdHJhcCA9IGB3b3JrYmVuY2gtYnVpbGRlcjoke3JhbmRvbVVVSUQoKX1gO1xuICBjb25zdCBjb250YWluZXIgPSBgd29ya2JlbmNoLWJ1aWxkZXItJHtyYW5kb21VVUlEKCl9YDtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBvcmFyeSwgXCJyb290cy5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShyb290cykpO1xuICBta2RpclN5bmMoam9pbih0ZW1wb3JhcnksIFwicHJvZmlsZXNcIikpO1xuICBjb25zdCBpbnN0YWxsZWQgPSBhd2FpdCBzY29wZS5ydW4oYnVpbGRlciwgW1wiLS12ZXJzaW9uXCJdLCB7IGNhcHR1cmU6IHRydWUsIG1pc3Npbmc6IHRydWUgfSk7XG4gIGlmIChpbnN0YWxsZWQgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnNvbGUubG9nKGBQcmVwYXJpbmcgJHtidWlsZGVyfSBpbWFnZSB1c2luZyB0aGUgaG9zdCBzdG9yZWApO1xuICAgIGF3YWl0IHJ1bihcbiAgICAgIFtcbiAgICAgICAgam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwibWFuYWdlZC1pbWFnZS1wcmVwYXJlXCIsXG4gICAgICAgIGJ1aWxkZXIsXG4gICAgICAgIGltYWdlLFxuICAgICAgICBqb2luKHRlbXBvcmFyeSwgXCJyb290cy5qc29uXCIpLFxuICAgICAgICB0ZW1wb3JhcnksXG4gICAgICBdLFxuICAgICAgZmFsc2UsXG4gICAgICBmYWxzZSxcbiAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZyhgUHJlcGFyaW5nICR7YnVpbGRlcn0gaW1hZ2UgdXNpbmcgYSBEb2NrZXIgYnVpbGRlciAoJHtidWlsZGVyfSBpcyBub3QgaW5zdGFsbGVkKWApO1xuICAgIHNjb3BlLmRlZmVyKGFzeW5jICgpID0+IHtcbiAgICAgIGlmIChhd2FpdCBydW4oW1wiaW1hZ2VcIiwgXCJsc1wiLCBcIi0tcXVpZXRcIiwgXCItLWZpbHRlclwiLCBgcmVmZXJlbmNlPSR7Ym9vdHN0cmFwfWBdLCB0cnVlLCB0cnVlKSlcbiAgICAgICAgYXdhaXQgcnVuKFtcImltYWdlXCIsIFwicm1cIiwgYm9vdHN0cmFwXSwgZmFsc2UsIHRydWUpO1xuICAgIH0pO1xuICAgIGF3YWl0IHJ1bihbXG4gICAgICBcImJ1aWxkXCIsXG4gICAgICBcIi0tbmV0d29yaz1ob3N0XCIsXG4gICAgICBcIi0tdWxpbWl0PW5vZmlsZT02NTUzNjo2NTUzNlwiLFxuICAgICAgXCItLXRhcmdldFwiLFxuICAgICAgXCJiYXNlXCIsXG4gICAgICBcIi0tZmlsZVwiLFxuICAgICAgam9pbihyb290LCBcIi5kZXZjb250YWluZXJcIiwgYnVpbGRlciwgXCJEb2NrZXJmaWxlXCIpLFxuICAgICAgXCItLXRhZ1wiLFxuICAgICAgYm9vdHN0cmFwLFxuICAgICAgLi4uKGJ1aWxkZXIgPT09IFwiZ3VpeFwiXG4gICAgICAgID8gW1xuICAgICAgICAgICAgXCItLWJ1aWxkLWFyZ1wiLFxuICAgICAgICAgICAgYFdPUktCRU5DSF9HVUlYX0NIQU5ORUxTPSR7cmVsYXRpdmUocm9vdCwgZ3VpeENoYW5uZWxGaWxlKHJvb3QsIGpvaW4ocm9vdCwgcmVxdWlyZWQocm9vdHNbMF0sIFwiTWlzc2luZyBtYW5hZ2VkIHJvb3RcIikpKSkucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpfWAsXG4gICAgICAgICAgXVxuICAgICAgICA6IFtdKSxcbiAgICAgIHJvb3QsXG4gICAgXSk7XG4gICAgY29uc3QgaWRlbnRpdHkgPSBhd2FpdCBydW4oW1wiaW1hZ2VcIiwgXCJpbnNwZWN0XCIsIFwiLS1mb3JtYXRcIiwgXCJ7ey5JZH19XCIsIGJvb3RzdHJhcF0sIHRydWUpO1xuICAgIGNvbnN0IGNhY2hlID0gYnVpbGRlckNhY2hlS2V5KHByb2Nlc3MuZW52LldPUktCRU5DSF9QUkVQQVJBVElPTl9PV05FUiA/PyByb290LCBidWlsZGVyLCBwcm9jZXNzLmFyY2gsIGlkZW50aXR5KTtcbiAgICBjb25zdCB2b2x1bWVzID0gYnVpbGRlclZvbHVtZXMoYnVpbGRlciwgY2FjaGUpO1xuICAgIGZvciAoY29uc3Qgdm9sdW1lIG9mIHZvbHVtZXMpIGF3YWl0IHJ1bihbXCJ2b2x1bWVcIiwgXCJjcmVhdGVcIiwgdm9sdW1lLm5hbWVdKTtcbiAgICBhd2FpdCBydW4oXG4gICAgICBbam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksIFwibWFuYWdlZC1idWlsZGVyLXJlY29yZFwiLCBidWlsZGVyLCBjYWNoZV0sXG4gICAgICBmYWxzZSxcbiAgICAgIGZhbHNlLFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICApO1xuICAgIGNvbnN0IG1vdW50cyA9IHZvbHVtZXMuZmxhdE1hcCgoeyBuYW1lLCBkZXN0aW5hdGlvbiB9KSA9PiBbXG4gICAgICBcIi0tbW91bnRcIixcbiAgICAgIGB0eXBlPXZvbHVtZSxzcmM9JHtuYW1lfSxkc3Q9JHtkZXN0aW5hdGlvbn1gLFxuICAgIF0pO1xuICAgIHNjb3BlLmRlZmVyKGFzeW5jICgpID0+IHtcbiAgICAgIGlmIChhd2FpdCBydW4oW1wiY29udGFpbmVyXCIsIFwibHNcIiwgXCItLWFsbFwiLCBcIi0tcXVpZXRcIiwgXCItLWZpbHRlclwiLCBgbmFtZT1eLyR7Y29udGFpbmVyfSRgXSwgdHJ1ZSwgdHJ1ZSkpXG4gICAgICAgIGF3YWl0IHJ1bihbXCJybVwiLCBcIi0tZm9yY2VcIiwgY29udGFpbmVyXSwgZmFsc2UsIHRydWUpO1xuICAgIH0pO1xuICAgIGF3YWl0IHJ1bihbXG4gICAgICBcImNyZWF0ZVwiLFxuICAgICAgXCItLW5hbWVcIixcbiAgICAgIGNvbnRhaW5lcixcbiAgICAgIFwiLS1jYXAtYWRkPVNZU19BRE1JTlwiLFxuICAgICAgXCItLWNhcC1hZGQ9TkVUX0FETUlOXCIsXG4gICAgICBcIi0tc2VjdXJpdHktb3B0PXNlY2NvbXA9dW5jb25maW5lZFwiLFxuICAgICAgXCItLXVsaW1pdD1ub2ZpbGU9NjU1MzY6NjU1MzZcIixcbiAgICAgIC4uLm1vdW50cyxcbiAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgYHR5cGU9YmluZCxzcmM9JHtyb290fSxkc3Q9L3ByZXBhcmF0aW9uLHJlYWRvbmx5YCxcbiAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgYHR5cGU9YmluZCxzcmM9JHt0ZW1wb3Jhcnl9LGRzdD0vb3V0cHV0YCxcbiAgICAgIFwiLS1tb3VudFwiLFxuICAgICAgYHR5cGU9YmluZCxzcmM9JHtkaXN0cmlidXRpb259LGRzdD0vd29ya2JlbmNoLHJlYWRvbmx5YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIFwiV09SS0JFTkNIX1BSRVBBUkFUSU9OX0RJU1RSSUJVVElPTj0vd29ya2JlbmNoXCIsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX01BTkFHRURfQ09SRVM9JHtTdHJpbmcocHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfQ09SRVMgPz8gMSl9YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIGBXT1JLQkVOQ0hfTUFOQUdFRF9KT0JTPSR7U3RyaW5nKHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0pPQlMgPz8gMSl9YCxcbiAgICAgIFwiLS1lbnZcIixcbiAgICAgIFwiV09SS0JFTkNIX1JPT1RTX0ZJTEU9L291dHB1dC9yb290cy5qc29uXCIsXG4gICAgICBcIi0tZW52XCIsXG4gICAgICBgV09SS0JFTkNIX0lNQUdFX0lOUFVUUz0ke1N0cmluZyhpbnB1dHMpfWAsXG4gICAgICBcIi0td29ya2RpclwiLFxuICAgICAgXCIvcHJlcGFyYXRpb25cIixcbiAgICAgIFwiLS1lbnRyeXBvaW50XCIsXG4gICAgICBcIi9iaW4vc2hcIixcbiAgICAgIGJvb3RzdHJhcCxcbiAgICAgIFwiL3ByZXBhcmF0aW9uLy5kZXZjb250YWluZXIvbWFuYWdlZC1idWlsZC5zaFwiLFxuICAgICAgYnVpbGRlcixcbiAgICBdKTtcbiAgICBhd2FpdCBydW4oW1wic3RhcnRcIiwgXCItLWF0dGFjaFwiLCBjb250YWluZXJdKTtcbiAgICBjb25zdCBzdGF0dXMgPSBhd2FpdCBydW4oW1wiaW5zcGVjdFwiLCBcIi0tZm9ybWF0XCIsIFwie3suU3RhdGUuRXhpdENvZGV9fVwiLCBjb250YWluZXJdLCB0cnVlKTtcbiAgICBpZiAoc3RhdHVzICE9PSBcIjBcIikgdGhyb3cgbmV3IEVycm9yKGAke2J1aWxkZXJ9IGltYWdlIGFzc2VtYmx5IGZhaWxlZDogZXhpdCAke3N0YXR1c31gKTtcbiAgICAvLyBUaGUgYnVpbGRlciBwcm9kdWNlcyBhIERvY2tlciBhcmNoaXZlOyBEb2NrZXIgb3ducyBpbXBvcnRpbmcgaXRzIGxheWVycyBhbmQgbWV0YWRhdGEuXG4gICAgY29uc3QgYXJjaGl2ZSA9IHJlYWRGaWxlU3luYyhqb2luKHRlbXBvcmFyeSwgXCJpbWFnZS1wYXRoXCIpLCBcInV0ZjhcIikudHJpbSgpO1xuICAgIGlmICghYXJjaGl2ZS5zdGFydHNXaXRoKGJ1aWxkZXIgPT09IFwiZ3VpeFwiID8gXCIvZ251L3N0b3JlL1wiIDogXCIvbml4L3N0b3JlL1wiKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkJ1aWxkZXIgcmV0dXJuZWQgYW4gaW52YWxpZCBpbWFnZSBzdG9yZSBwYXRoXCIpO1xuICAgIC8vIERvY2tlciBjcCBhZGRzIGEgdGFyIHdyYXBwZXIuIFN0cmVhbSBpdHMgc2luZ2xlIGFyY2hpdmUgZW50cnkgdG8gRG9ja2VyLCB3aXRob3V0IGEgc2Vjb25kIGRpc2sgY29weS5cbiAgICBjb25zdCBsb2FkZWQgPSBhd2FpdCBydW4oXG4gICAgICBbXG4gICAgICAgIFwiLW9cIixcbiAgICAgICAgXCJwaXBlZmFpbFwiLFxuICAgICAgICBcIi1jXCIsXG4gICAgICAgICdkb2NrZXIgY3AgXCIkMTokMlwiIC0gfCB0YXIgLXhPIHwgZG9ja2VyIGxvYWQnLFxuICAgICAgICBcIndvcmtiZW5jaC1pbWFnZS1pbXBvcnRcIixcbiAgICAgICAgY29udGFpbmVyLFxuICAgICAgICBhcmNoaXZlLFxuICAgICAgXSxcbiAgICAgIHRydWUsXG4gICAgICBmYWxzZSxcbiAgICAgIFwiYmFzaFwiLFxuICAgICk7XG4gICAgY29uc3QgaWQgPSAvTG9hZGVkIGltYWdlKD86IElEKT86ICguKykvLmV4ZWMobG9hZGVkKT8uWzFdO1xuICAgIGlmICghaWQpIHRocm93IG5ldyBFcnJvcihcIkRvY2tlciBkaWQgbm90IHJlcG9ydCB0aGUgaW1wb3J0ZWQgaW1hZ2UgaWRlbnRpdHlcIik7XG4gICAgYXdhaXQgcnVuKFtcInRhZ1wiLCBpZCwgaW1hZ2VdKTtcbiAgfVxuICBpZiAoYnVpbGRlciA9PT0gXCJndWl4XCIpIHtcbiAgICBjb25zdCB7IG1hdGVyaWFsaXplIH0gPSBndWl4SW1hZ2VEZWZpbml0aW9uKHJvb3QpO1xuICAgIGF3YWl0IHJ1bihcbiAgICAgIFtcbiAgICAgICAgam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwiaW1hZ2UtZmluYWxpemVcIixcbiAgICAgICAgaW1hZ2UsXG4gICAgICAgIGltYWdlLFxuICAgICAgICAuLi4obWF0ZXJpYWxpemUubGVuZ3RoID8gW1wiLS1tYXRlcmlhbGl6ZVwiLCAuLi5tYXRlcmlhbGl6ZV0gOiBbXSksXG4gICAgICBdLFxuICAgICAgZmFsc2UsXG4g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QSxNQUNuQjtBQUFBLFFBQ0U7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUNBLFVBQU0sS0FBSyw2QkFBNkIsS0FBSyxNQUFNLElBQUksQ0FBQztBQUN4RCxRQUFJLENBQUMsR0FBSSxPQUFNLElBQUksTUFBTSxtREFBbUQ7QUFDNUUsVUFBTSxJQUFJLENBQUMsT0FBTyxJQUFJLEtBQUssQ0FBQztBQUFBLEVBQzlCO0FBQ0EsTUFBSSxZQUFZLFFBQVE7QUFDdEIsVUFBTSxFQUFFLFlBQVksSUFBSSxvQkFBb0IsSUFBSTtBQUNoRCxVQUFNO0FBQUEsTUFDSjtBQUFBLFFBQ0UsS0FBSyxjQUFjLG1CQUFtQjtBQUFBLFFBQ3RDO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBLEdBQUksWUFBWSxTQUFTLENBQUMsaUJBQWlCLEdBQUcsV0FBVyxJQUFJLENBQUM7QUFBQSxNQUNoRTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxRQUFRO0FBQUEsSUFDVjtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvcHJlcGFyZS1tYW5hZ2VkLWRldmVsb3BtZW50Lm1qcyJ9
