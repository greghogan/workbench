// Generated from verify-managed-preparation.mts; edit the TypeScript source.
import { isStringArray } from "./values.mjs";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { withManagedProcesses } from "./managed-process.mjs";
const [builder] = process.argv.slice(2);
const independent = process.argv.includes("--subproject-pin");
if (process.platform !== "linux" || builder !== "nix" && builder !== "guix")
  throw new Error("Use verify-managed-preparation.mjs nix|guix on Linux with that manager installed");
const distribution = resolve(import.meta.dirname, "..");
await withManagedProcesses(async (scope) => {
  await scope.run(builder, ["--version"], { capture: true });
  const base = mkdtempSync(join(tmpdir(), "workbench-managed-verification-"));
  scope.defer(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const root = join(base, "project");
  mkdirSync(join(root, "workbench"), { recursive: true });
  mkdirSync(join(root, "other"));
  const env = {
    ...process.env,
    GUIX_BUILD_OPTIONS: void 0,
    WORKBENCH_DISTRIBUTION_ROOT: distribution,
    WORKBENCH_PROJECT_ROOT: root,
    WORKBENCH_CONTAINER_CHECKOUT: root,
    WORKBENCH_LOCAL_CONFIG_ROOT: root,
    WORKBENCH_CONFIG_HOME: join(base, "config"),
    WORKBENCH_STATE_HOME: join(base, "state"),
    WORKBENCH_DATA_HOME: join(base, "data"),
    WORKBENCH_CACHE_HOME: join(base, "cache"),
    WORKBENCH_STORAGE_ROOT: join(base, "cache"),
    WORKBENCH_STORAGE_EXTERNAL: "true",
    WORKBENCH_MANAGED_CORES: String(availableParallelism()),
    WORKBENCH_MANAGED_JOBS: String(availableParallelism()),
    WORKBENCH_IMAGE_INPUTS: createHash("sha256").update(randomUUID()).digest("hex")
  };
  const run = (command, args, options = {}) => scope.run(command, args, { cwd: root, env, ...options });
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n"
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="verification"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="other"\n'
  );
  for (const directory of [root, join(root, "other")]) {
    if (builder === "guix") {
      if (directory === root) copyFileSync(join(distribution, "channels.scm"), join(root, "channels.scm"));
      else if (independent) {
        const { readFileSync } = await import("node:fs");
        writeFileSync(
          join(directory, "channels.scm"),
          readFileSync(join(distribution, "channels.scm"), "utf8") + "\n;; Independent subproject declaration.\n"
        );
      }
      writeFileSync(
        join(directory, "manifest.scm"),
        '(use-modules (gnu packages) (guix profiles))\n(specifications->manifest (list "hello"))\n'
      );
    } else {
      copyFileSync(join(distribution, "flake.lock"), join(directory, "flake.lock"));
      writeFileSync(
        join(directory, "flake.nix"),
        `{ inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable"; outputs = { nixpkgs, ... }: { devShells = nixpkgs.lib.genAttrs ["x86_64-linux" "aarch64-linux"] (system: { default = nixpkgs.legacyPackages.\${system}.mkShell { packages = [ nixpkgs.legacyPackages.\${system}.hello ]; }; }); }; }`
      );
    }
  }
  mkdirSync(join(root, ".devcontainer", builder), { recursive: true });
  for (const file of builder === "guix" ? ["environments.scm", "image.json", "image.scm", "prepare.sh"] : ["image.nix"])
    copyFileSync(join(distribution, ".devcontainer", builder, file), join(root, ".devcontainer", builder, file));
  scope.defer(
    () => run(
      process.execPath,
      [
        join(distribution, "bin/workbench.mjs"),
        "cache",
        "prune",
        "--checkout",
        root,
        "--dependencies",
        "--apply",
        "--json"
      ],
      { cleanup: true, capture: true }
    )
  );
  const image = `workbench-managed-verification:${randomUUID()}`;
  const before = new Set(
    (await run("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], { capture: true })).split("\n")
  );
  scope.defer(async () => {
    const found = await run("docker", ["image", "ls", "--quiet", "--filter", `reference=${image}`], {
      cleanup: true,
      capture: true
    });
    if (!found) return;
    const inspected = await run("docker", ["image", "inspect", image, "--format", "{{json .RepoTags}}"], {
      cleanup: true,
      capture: true
    });
    const tags = JSON.parse(inspected);
    if (!isStringArray(tags)) throw new Error("Invalid Docker image tags");
    for (const tag of tags)
      if (!before.has(tag) && (tag === image || tag.startsWith(`workbench-${builder}-prepared`)))
        await run("docker", ["image", "rm", tag], { cleanup: true, capture: true });
  });
  await run(process.execPath, [join(distribution, "scripts/prepare-managed-development.mjs"), builder, image]);
  const commands = ["mkdir -p /tmp /root; chmod 1777 /tmp"];
  if (builder === "guix")
    commands.push(
      "test -f /etc/passwd && test ! -L /etc/passwd && test -r /etc/passwd",
      "test -f /etc/group && test ! -L /etc/group && test -r /etc/group"
    );
  for (const index of [0, 1])
    commands.push(
      builder === "guix" ? `/opt/workbench-environments/runtimes/${String(index)}/bin/guix shell --profile=/opt/workbench-environments/${String(index)} -- hello` : `nix --extra-experimental-features 'nix-command flakes' --option flake-registry '' develop --offline /opt/workbench-environments/${String(index)} --command hello`
    );
  const output = await run(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--ulimit",
      "stack=67108864:67108864",
      "--entrypoint",
      "/bin/bash",
      image,
      "-ec",
      commands.join("\n")
    ],
    { capture: true }
  );
  if (output.split("\n").filter((line) => line.includes("Hello, world!")).length !== 2)
    throw new Error("Both retained profiles must execute in the offline image");
  console.log(`${builder}: both declared profiles executed successfully with networking disabled`);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInZlcmlmeS1tYW5hZ2VkLXByZXBhcmF0aW9uLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBpc1N0cmluZ0FycmF5IH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgY29weUZpbGVTeW5jLCBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYXZhaWxhYmxlUGFyYWxsZWxpc20sIHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCwgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgd2l0aE1hbmFnZWRQcm9jZXNzZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLXByb2Nlc3MubWpzXCI7XG5cbi8vIEV4cGxpY2l0IGludGVncmF0aW9uIHJlaGVhcnNhbDogcmVhbCBpbnN0YWxsZWQgbWFuYWdlciwgcmVhbCBzdG9yZSwgdHdvIHRpbnkgcHJvZmlsZXMsIGFuZCBEb2NrZXIgb2ZmbGluZSBleGVjdXRpb24uXG5jb25zdCBbYnVpbGRlcl0gPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMik7XG5jb25zdCBpbmRlcGVuZGVudCA9IHByb2Nlc3MuYXJndi5pbmNsdWRlcyhcIi0tc3VicHJvamVjdC1waW5cIik7XG5pZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJsaW51eFwiIHx8IChidWlsZGVyICE9PSBcIm5peFwiICYmIGJ1aWxkZXIgIT09IFwiZ3VpeFwiKSlcbiAgdGhyb3cgbmV3IEVycm9yKFwiVXNlIHZlcmlmeS1tYW5hZ2VkLXByZXBhcmF0aW9uLm1qcyBuaXh8Z3VpeCBvbiBMaW51eCB3aXRoIHRoYXQgbWFuYWdlciBpbnN0YWxsZWRcIik7XG5jb25zdCBkaXN0cmlidXRpb24gPSByZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiLi5cIik7XG5hd2FpdCB3aXRoTWFuYWdlZFByb2Nlc3Nlcyhhc3luYyAoc2NvcGUpID0+IHtcbiAgYXdhaXQgc2NvcGUucnVuKGJ1aWxkZXIsIFtcIi0tdmVyc2lvblwiXSwgeyBjYXB0dXJlOiB0cnVlIH0pO1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJ3b3JrYmVuY2gtbWFuYWdlZC12ZXJpZmljYXRpb24tXCIpKTtcbiAgc2NvcGUuZGVmZXIoKCkgPT4ge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuICBjb25zdCByb290ID0gam9pbihiYXNlLCBcInByb2plY3RcIik7XG4gIG1rZGlyU3luYyhqb2luKHJvb3QsIFwid29ya2JlbmNoXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4ocm9vdCwgXCJvdGhlclwiKSk7XG4gIGNvbnN0IGVudiA9IHtcbiAgICAuLi5wcm9jZXNzLmVudixcbiAgICBHVUlYX0JVSUxEX09QVElPTlM6IHVuZGVmaW5lZCxcbiAgICBXT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1Q6IGRpc3RyaWJ1dGlvbixcbiAgICBXT1JLQkVOQ0hfUFJPSkVDVF9ST09UOiByb290LFxuICAgIFdPUktCRU5DSF9DT05UQUlORVJfQ0hFQ0tPVVQ6IHJvb3QsXG4gICAgV09SS0JFTkNIX0xPQ0FMX0NPTkZJR19ST09UOiByb290LFxuICAgIFdPUktCRU5DSF9DT05GSUdfSE9NRTogam9pbihiYXNlLCBcImNvbmZpZ1wiKSxcbiAgICBXT1JLQkVOQ0hfU1RBVEVfSE9NRTogam9pbihiYXNlLCBcInN0YXRlXCIpLFxuICAgIFdPUktCRU5DSF9EQVRBX0hPTUU6IGpvaW4oYmFzZSwgXCJkYXRhXCIpLFxuICAgIFdPUktCRU5DSF9DQUNIRV9IT01FOiBqb2luKGJhc2UsIFwiY2FjaGVcIiksXG4gICAgV09SS0JFTkNIX1NUT1JBR0VfUk9PVDogam9pbihiYXNlLCBcImNhY2hlXCIpLFxuICAgIFdPUktCRU5DSF9TVE9SQUdFX0VYVEVSTkFMOiBcInRydWVcIixcbiAgICBXT1JLQkVOQ0hfTUFOQUdFRF9DT1JFUzogU3RyaW5nKGF2YWlsYWJsZVBhcmFsbGVsaXNtKCkpLFxuICAgIFdPUktCRU5DSF9NQU5BR0VEX0pPQlM6IFN0cmluZyhhdmFpbGFibGVQYXJhbGxlbGlzbSgpKSxcbiAgICBXT1JLQkVOQ0hfSU1BR0VfSU5QVVRTOiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShyYW5kb21VVUlEKCkpLmRpZ2VzdChcImhleFwiKSxcbiAgfTtcbiAgY29uc3QgcnVuID0gKGNvbW1hbmQ6IHN0cmluZywgYXJnczogc3RyaW5nW10sIG9wdGlvbnMgPSB7fSkgPT5cbiAgICBzY29wZS5ydW4oY29tbWFuZCwgYXJncywgeyBjd2Q6IHJvb3QsIGVudiwgLi4ub3B0aW9ucyB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHJvb3QsIFwid29ya2JlbmNoL2NvbmZpZy50b21sXCIpLFxuICAgIFwic2NoZW1hX3ZlcnNpb249MVxcblttYXJrZG93bl1cXG53cmFwX3dpZHRoPTEyMFxcbltjb21wYXRpYmlsaXR5XVxcbnJlcXVpcmVkPWZhbHNlXFxuXCIsXG4gICk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihyb290LCBcIndvcmtiZW5jaC9wcm9qZWN0cy50b21sXCIpLFxuICAgICdbW3Byb2plY3RdXVxcbmlkPVwidmVyaWZpY2F0aW9uXCJcXG5wYXRoPVwiLlwiXFxuW1tsYW5ndWFnZV9yb290XV1cXG5sYW5ndWFnZT1cInR5cGVzY3JpcHRcIlxcbnBhdGg9XCIuXCJcXG5bW2xhbmd1YWdlX3Jvb3RdXVxcbmxhbmd1YWdlPVwidHlwZXNjcmlwdFwiXFxucGF0aD1cIm90aGVyXCJcXG4nLFxuICApO1xuICBmb3IgKGNvbnN0IGRpcmVjdG9yeSBvZiBbcm9vdCwgam9pbihyb290LCBcIm90aGVyXCIpXSkge1xuICAgIGlmIChidWlsZGVyID09PSBcImd1aXhcIikge1xuICAgICAgaWYgKGRpcmVjdG9yeSA9PT0gcm9vdCkgY29weUZpbGVTeW5jKGpvaW4oZGlzdHJpYnV0aW9uLCBcImNoYW5uZWxzLnNjbVwiKSwgam9pbihyb290LCBcImNoYW5uZWxzLnNjbVwiKSk7XG4gICAgICBlbHNlIGlmIChpbmRlcGVuZGVudCkge1xuICAgICAgICBjb25zdCB7IHJlYWRGaWxlU3luYyB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTpmc1wiKTtcbiAgICAgICAgLy8gRXhlcmNpc2Ugc2VwYXJhdGUgZGVjbGFyYXRpb25zIHdpdGhvdXQgc2VsZWN0aW5nIGFuIHVucmVxdWVzdGVkIGNoYW5uZWwgcmV2aXNpb24uXG4gICAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgICAgam9pbihkaXJlY3RvcnksIFwiY2hhbm5lbHMuc2NtXCIpLFxuICAgICAgICAgIHJlYWRGaWxlU3luYyhqb2luKGRpc3RyaWJ1dGlvbiwgXCJjaGFubmVscy5zY21cIiksIFwidXRmOFwiKSArIFwiXFxuOzsgSW5kZXBlbmRlbnQgc3VicHJvamVjdCBkZWNsYXJhdGlvbi5cXG5cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgIGpvaW4oZGlyZWN0b3J5LCBcIm1hbmlmZXN0LnNjbVwiKSxcbiAgICAgICAgJyh1c2UtbW9kdWxlcyAoZ251IHBhY2thZ2VzKSAoZ3VpeCBwcm9maWxlcykpXFxuKHNwZWNpZmljYXRpb25zLT5tYW5pZmVzdCAobGlzdCBcImhlbGxvXCIpKVxcbicsXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb3B5RmlsZVN5bmMoam9pbihkaXN0cmlidXRpb24sIFwiZmxha2UubG9ja1wiKSwgam9pbihkaXJlY3RvcnksIFwiZmxha2UubG9ja1wiKSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKGRpcmVjdG9yeSwgXCJmbGFrZS5uaXhcIiksXG4gICAgICAgIGB7IGlucHV0cy5uaXhwa2dzLnVybCA9IFwiZ2l0aHViOk5peE9TL25peHBrZ3Mvbml4b3MtdW5zdGFibGVcIjsgb3V0cHV0cyA9IHsgbml4cGtncywgLi4uIH06IHsgZGV2U2hlbGxzID0gbml4cGtncy5saWIuZ2VuQXR0cnMgW1wieDg2XzY0LWxpbnV4XCIgXCJhYXJjaDY0LWxpbnV4XCJdIChzeXN0ZW06IHsgZGVmYXVsdCA9IG5peHBrZ3MubGVnYWN5UGFja2FnZXMuXFwke3N5c3RlbX0ubWtTaGVsbCB7IHBhY2thZ2VzID0gWyBuaXhwa2dzLmxlZ2FjeVBhY2thZ2VzLlxcJHtzeXN0ZW19LmhlbGxvIF07IH07IH0pOyB9OyB9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIG1rZGlyU3luYyhqb2luKHJvb3QsIFwiLmRldmNvbnRhaW5lclwiLCBidWlsZGVyKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGZvciAoY29uc3QgZmlsZSBvZiBidWlsZGVyID09PSBcImd1aXhcIiA/IFtcImVudmlyb25tZW50cy5zY21cIiwgXCJpbWFnZS5qc29uXCIsIFwiaW1hZ2Uuc2NtXCIsIFwicHJlcGFyZS5zaFwiXSA6IFtcImltYWdlLm5peFwiXSlcbiAgICBjb3B5RmlsZVN5bmMoam9pbihkaXN0cmlidXRpb24sIFwiLmRldmNvbnRhaW5lclwiLCBidWlsZGVyLCBmaWxlKSwgam9pbihyb290LCBcIi5kZXZjb250YWluZXJcIiwgYnVpbGRlciwgZmlsZSkpO1xuICAvLyBSZWNlaXB0cyByZWxlYXNlIGV2ZXJ5IHB1YmxpYyBHdWl4IHJvb3QgYW5kIHJldGFpbmVkIE5peCBwcm9maWxlIGJlZm9yZSB0aGUgZGlzcG9zYWJsZSBjaGVja291dCBkaXNhcHBlYXJzLlxuICBzY29wZS5kZWZlcigoKSA9PlxuICAgIHJ1bihcbiAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICBbXG4gICAgICAgIGpvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLFxuICAgICAgICBcImNhY2hlXCIsXG4gICAgICAgIFwicHJ1bmVcIixcbiAgICAgICAgXCItLWNoZWNrb3V0XCIsXG4gICAgICAgIHJvb3QsXG4gICAgICAgIFwiLS1kZXBlbmRlbmNpZXNcIixcbiAgICAgICAgXCItLWFwcGx5XCIsXG4gICAgICAgIFwiLS1qc29uXCIsXG4gICAgICBdLFxuICAgICAgeyBjbGVhbnVwOiB0cnVlLCBjYXB0dXJlOiB0cnVlIH0sXG4gICAgKSxcbiAgKTtcbiAgY29uc3QgaW1hZ2UgPSBgd29ya2JlbmNoLW1hbmFnZWQtdmVyaWZpY2F0aW9uOiR7cmFuZG9tVVVJRCgpfWA7XG4gIGNvbnN0IGJlZm9yZSA9IG5ldyBTZXQoXG4gICAgKGF3YWl0IHJ1bihcImRvY2tlclwiLCBbXCJpbWFnZVwiLCBcImxzXCIsIFwiLS1mb3JtYXRcIiwgXCJ7ey5SZXBvc2l0b3J5fX06e3suVGFnfX1cIl0sIHsgY2FwdHVyZTogdHJ1ZSB9KSkuc3BsaXQoXCJcXG5cIiksXG4gICk7XG4gIHNjb3BlLmRlZmVyKGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBmb3VuZCA9IGF3YWl0IHJ1bihcImRvY2tlclwiLCBbXCJpbWFnZVwiLCBcImxzXCIsIFwiLS1xdWlldFwiLCBcIi0tZmlsdGVyXCIsIGByZWZlcmVuY2U9JHtpbWFnZX1gXSwge1xuICAgICAgY2xlYW51cDogdHJ1ZSxcbiAgICAgIGNhcHR1cmU6IHRydWUsXG4gICAgfSk7XG4gICAgaWYgKCFmb3VuZCkgcmV0dXJuO1xuICAgIGNvbnN0IGluc3BlY3RlZCA9IGF3YWl0IHJ1bihcImRvY2tlclwiLCBbXCJpbWFnZVwiLCBcImluc3BlY3RcIiwgaW1hZ2UsIFwiLS1mb3JtYXRcIiwgXCJ7e2pzb24gLlJlcG9UYWdzfX1cIl0sIHtcbiAgICAgIGNsZWFudXA6IHRydWUsXG4gICAgICBjYXB0dXJlOiB0cnVlLFxuICAgIH0pO1xuICAgIGNvbnN0IHRhZ3M6IHVua25vd24gPSBKU09OLnBhcnNlKGluc3BlY3RlZCk7XG4gICAgaWYgKCFpc1N0cmluZ0FycmF5KHRhZ3MpKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIERvY2tlciBpbWFnZSB0YWdzXCIpO1xuICAgIGZvciAoY29uc3QgdGFnIG9mIHRhZ3MpXG4gICAgICBpZiAoIWJlZm9yZS5oYXModGFnKSAmJiAodGFnID09PSBpbWFnZSB8fCB0YWcuc3RhcnRzV2l0aChgd29ya2JlbmNoLSR7YnVpbGRlcn0tcHJlcGFyZWRgKSkpXG4gICAgICAgIGF3YWl0IHJ1bihcImRvY2tlclwiLCBbXCJpbWFnZVwiLCBcInJtXCIsIHRhZ10sIHsgY2xlYW51cDogdHJ1ZSwgY2FwdHVyZTogdHJ1ZSB9KTtcbiAgfSk7XG4gIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbam9pbihkaXN0cmlidXRpb24sIFwic2NyaXB0cy9wcmVwYXJlLW1hbmFnZWQtZGV2ZWxvcG1lbnQubWpzXCIpLCBidWlsZGVyLCBpbWFnZV0pO1xuICBjb25zdCBjb21tYW5kcyA9IFtcIm1rZGlyIC1wIC90bXAgL3Jvb3Q7IGNobW9kIDE3NzcgL3RtcFwiXTtcbiAgaWYgKGJ1aWxkZXIgPT09IFwiZ3VpeFwiKVxuICAgIGNvbW1hbmRzLnB1c2goXG4gICAgICBcInRlc3QgLWYgL2V0Yy9wYXNzd2QgJiYgdGVzdCAhIC1MIC9ldGMvcGFzc3dkICYmIHRlc3QgLXIgL2V0Yy9wYXNzd2RcIixcbiAgICAgIFwidGVzdCAtZiAvZXRjL2dyb3VwICYmIHRlc3QgISAtTCAvZXRjL2dyb3VwICYmIHRlc3QgLXIgL2V0Yy9ncm91cFwiLFxuICAgICk7XG4gIGZvciAoY29uc3QgaW5kZXggb2YgWzAsIDFdKVxuICAgIGNvbW1hbmRzLnB1c2goXG4gICAgICBidWlsZGVyID09PSBcImd1aXhcIlxuICAgICAgICA/IGAvb3B0L3dvcmtiZW5jaC1lbnZpcm9ubWVudHMvcnVudGltZXMvJHtTdHJpbmcoaW5kZXgpfS9iaW4vZ3VpeCBzaGVsbCAtLXByb2ZpbGU9L29wdC93b3JrYmVuY2gtZW52aXJvbm1lbnRzLyR7U3RyaW5nKGluZGV4KX0gLS0gaGVsbG9gXG4gICAgICAgIDogYG5peCAtLWV4dHJhLWV4cGVyaW1lbnRhbC1mZWF0dXJlcyAnbml4LWNvbW1hbmQgZmxha2VzJyAtLW9wdGlvbiBmbGFrZS1yZWdpc3RyeSAnJyBkZXZlbG9wIC0tb2ZmbGluZSAvb3B0L3dvcmtiZW5jaC1lbnZpcm9ubWVudHMvJHtTdHJpbmcoaW5kZXgpfSAtLWNvbW1hbmQgaGVsbG9gLFxuICAgICk7XG4gIGNvbnN0IG91dHB1dCA9IGF3YWl0IHJ1bihcbiAgICBcImRvY2tlclwiLFxuICAgIFtcbiAgICAgIFwicnVuXCIsXG4gICAgICBcIi0tcm1cIixcbiAgICAgIFwiLS1uZXR3b3JrPW5vbmVcIixcbiAgICAgIFwiLS11bGltaXRcIixcbiAgICAgIFwic3RhY2s9NjcxMDg4NjQ6NjcxMDg4NjRcIixcbiAgICAgIFwiLS1lbnRyeXBvaW50XCIsXG4gICAgICBcIi9iaW4vYmFzaFwiLFxuICAgICAgaW1hZ2UsXG4gICAgICBcIi1lY1wiLFxuICAgICAgY29tbWFuZHMuam9pbihcIlxcblwiKSxcbiAgICBdLFxuICAgIHsgY2FwdHVyZTogdHJ1ZSB9LFxuICApO1xuICBpZiAob3V0cHV0LnNwbGl0KFwiXFxuXCIpLmZpbHRlcigobGluZTogc3RyaW5nIHwgc3RyaW5nW10pID0+IGxpbmUuaW5jbHVkZXMoXCJIZWxsbywgd29ybGQhXCIpKS5sZW5ndGggIT09IDIpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQm90aCByZXRhaW5lZCBwcm9maWxlcyBtdXN0IGV4ZWN1dGUgaW4gdGhlIG9mZmxpbmUgaW1hZ2VcIik7XG4gIGNvbnNvbGUubG9nKGAke2J1aWxkZXJ9OiBib3RoIGRlY2xhcmVkIHByb2ZpbGVzIGV4ZWN1dGVkIHN1Y2Nlc3NmdWxseSB3aXRoIG5ldHdvcmtpbmcgZGlzYWJsZWRgKTtcbn0pO1xuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxjQUFjLFdBQVcsYUFBYSxRQUFRLHFCQUFxQjtBQUM1RSxTQUFTLHNCQUFzQixjQUFjO0FBQzdDLFNB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
