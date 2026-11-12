// Generated from verify-managed-preparation.mts; edit the TypeScript source.
import { isStringArray } from "../app/src/core/runtime/values.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInZlcmlmeS1tYW5hZ2VkLXByZXBhcmF0aW9uLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBpc1N0cmluZ0FycmF5IH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IGNvcHlGaWxlU3luYywgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGF2YWlsYWJsZVBhcmFsbGVsaXNtLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQsIGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IHdpdGhNYW5hZ2VkUHJvY2Vzc2VzIH0gZnJvbSBcIi4vbWFuYWdlZC1wcm9jZXNzLm1qc1wiO1xuXG4vLyBFeHBsaWNpdCBpbnRlZ3JhdGlvbiByZWhlYXJzYWw6IHJlYWwgaW5zdGFsbGVkIG1hbmFnZXIsIHJlYWwgc3RvcmUsIHR3byB0aW55IHByb2ZpbGVzLCBhbmQgRG9ja2VyIG9mZmxpbmUgZXhlY3V0aW9uLlxuY29uc3QgW2J1aWxkZXJdID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpO1xuY29uc3QgaW5kZXBlbmRlbnQgPSBwcm9jZXNzLmFyZ3YuaW5jbHVkZXMoXCItLXN1YnByb2plY3QtcGluXCIpO1xuaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09IFwibGludXhcIiB8fCAoYnVpbGRlciAhPT0gXCJuaXhcIiAmJiBidWlsZGVyICE9PSBcImd1aXhcIikpXG4gIHRocm93IG5ldyBFcnJvcihcIlVzZSB2ZXJpZnktbWFuYWdlZC1wcmVwYXJhdGlvbi5tanMgbml4fGd1aXggb24gTGludXggd2l0aCB0aGF0IG1hbmFnZXIgaW5zdGFsbGVkXCIpO1xuY29uc3QgZGlzdHJpYnV0aW9uID0gcmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcIi4uXCIpO1xuYXdhaXQgd2l0aE1hbmFnZWRQcm9jZXNzZXMoYXN5bmMgKHNjb3BlKSA9PiB7XG4gIGF3YWl0IHNjb3BlLnJ1bihidWlsZGVyLCBbXCItLXZlcnNpb25cIl0sIHsgY2FwdHVyZTogdHJ1ZSB9KTtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid29ya2JlbmNoLW1hbmFnZWQtdmVyaWZpY2F0aW9uLVwiKSk7XG4gIHNjb3BlLmRlZmVyKCgpID0+IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbiAgY29uc3Qgcm9vdCA9IGpvaW4oYmFzZSwgXCJwcm9qZWN0XCIpO1xuICBta2RpclN5bmMoam9pbihyb290LCBcIndvcmtiZW5jaFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhqb2luKHJvb3QsIFwib3RoZXJcIikpO1xuICBjb25zdCBlbnYgPSB7XG4gICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgR1VJWF9CVUlMRF9PUFRJT05TOiB1bmRlZmluZWQsXG4gICAgV09SS0JFTkNIX0RJU1RSSUJVVElPTl9ST09UOiBkaXN0cmlidXRpb24sXG4gICAgV09SS0JFTkNIX1BST0pFQ1RfUk9PVDogcm9vdCxcbiAgICBXT1JLQkVOQ0hfQ09OVEFJTkVSX0NIRUNLT1VUOiByb290LFxuICAgIFdPUktCRU5DSF9MT0NBTF9DT05GSUdfUk9PVDogcm9vdCxcbiAgICBXT1JLQkVOQ0hfQ09ORklHX0hPTUU6IGpvaW4oYmFzZSwgXCJjb25maWdcIiksXG4gICAgV09SS0JFTkNIX1NUQVRFX0hPTUU6IGpvaW4oYmFzZSwgXCJzdGF0ZVwiKSxcbiAgICBXT1JLQkVOQ0hfREFUQV9IT01FOiBqb2luKGJhc2UsIFwiZGF0YVwiKSxcbiAgICBXT1JLQkVOQ0hfQ0FDSEVfSE9NRTogam9pbihiYXNlLCBcImNhY2hlXCIpLFxuICAgIFdPUktCRU5DSF9TVE9SQUdFX1JPT1Q6IGpvaW4oYmFzZSwgXCJjYWNoZVwiKSxcbiAgICBXT1JLQkVOQ0hfU1RPUkFHRV9FWFRFUk5BTDogXCJ0cnVlXCIsXG4gICAgV09SS0JFTkNIX01BTkFHRURfQ09SRVM6IFN0cmluZyhhdmFpbGFibGVQYXJhbGxlbGlzbSgpKSxcbiAgICBXT1JLQkVOQ0hfTUFOQUdFRF9KT0JTOiBTdHJpbmcoYXZhaWxhYmxlUGFyYWxsZWxpc20oKSksXG4gICAgV09SS0JFTkNIX0lNQUdFX0lOUFVUUzogY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUocmFuZG9tVVVJRCgpKS5kaWdlc3QoXCJoZXhcIiksXG4gIH07XG4gIGNvbnN0IHJ1biA9IChjb21tYW5kOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdLCBvcHRpb25zID0ge30pID0+XG4gICAgc2NvcGUucnVuKGNvbW1hbmQsIGFyZ3MsIHsgY3dkOiByb290LCBlbnYsIC4uLm9wdGlvbnMgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihyb290LCBcIndvcmtiZW5jaC9jb25maWcudG9tbFwiKSxcbiAgICBcInNjaGVtYV92ZXJzaW9uPTFcXG5bbWFya2Rvd25dXFxud3JhcF93aWR0aD0xMjBcXG5bY29tcGF0aWJpbGl0eV1cXG5yZXF1aXJlZD1mYWxzZVxcblwiLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4ocm9vdCwgXCJ3b3JrYmVuY2gvcHJvamVjdHMudG9tbFwiKSxcbiAgICAnW1twcm9qZWN0XV1cXG5pZD1cInZlcmlmaWNhdGlvblwiXFxucGF0aD1cIi5cIlxcbltbbGFuZ3VhZ2Vfcm9vdF1dXFxubGFuZ3VhZ2U9XCJ0eXBlc2NyaXB0XCJcXG5wYXRoPVwiLlwiXFxuW1tsYW5ndWFnZV9yb290XV1cXG5sYW5ndWFnZT1cInR5cGVzY3JpcHRcIlxcbnBhdGg9XCJvdGhlclwiXFxuJyxcbiAgKTtcbiAgZm9yIChjb25zdCBkaXJlY3Rvcnkgb2YgW3Jvb3QsIGpvaW4ocm9vdCwgXCJvdGhlclwiKV0pIHtcbiAgICBpZiAoYnVpbGRlciA9PT0gXCJndWl4XCIpIHtcbiAgICAgIGlmIChkaXJlY3RvcnkgPT09IHJvb3QpIGNvcHlGaWxlU3luYyhqb2luKGRpc3RyaWJ1dGlvbiwgXCJjaGFubmVscy5zY21cIiksIGpvaW4ocm9vdCwgXCJjaGFubmVscy5zY21cIikpO1xuICAgICAgZWxzZSBpZiAoaW5kZXBlbmRlbnQpIHtcbiAgICAgICAgY29uc3QgeyByZWFkRmlsZVN5bmMgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6ZnNcIik7XG4gICAgICAgIC8vIEV4ZXJjaXNlIHNlcGFyYXRlIGRlY2xhcmF0aW9ucyB3aXRob3V0IHNlbGVjdGluZyBhbiB1bnJlcXVlc3RlZCBjaGFubmVsIHJldmlzaW9uLlxuICAgICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICAgIGpvaW4oZGlyZWN0b3J5LCBcImNoYW5uZWxzLnNjbVwiKSxcbiAgICAgICAgICByZWFkRmlsZVN5bmMoam9pbihkaXN0cmlidXRpb24sIFwiY2hhbm5lbHMuc2NtXCIpLCBcInV0ZjhcIikgKyBcIlxcbjs7IEluZGVwZW5kZW50IHN1YnByb2plY3QgZGVjbGFyYXRpb24uXFxuXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKGRpcmVjdG9yeSwgXCJtYW5pZmVzdC5zY21cIiksXG4gICAgICAgICcodXNlLW1vZHVsZXMgKGdudSBwYWNrYWdlcykgKGd1aXggcHJvZmlsZXMpKVxcbihzcGVjaWZpY2F0aW9ucy0+bWFuaWZlc3QgKGxpc3QgXCJoZWxsb1wiKSlcXG4nLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29weUZpbGVTeW5jKGpvaW4oZGlzdHJpYnV0aW9uLCBcImZsYWtlLmxvY2tcIiksIGpvaW4oZGlyZWN0b3J5LCBcImZsYWtlLmxvY2tcIikpO1xuICAgICAgd3JpdGVGaWxlU3luYyhcbiAgICAgICAgam9pbihkaXJlY3RvcnksIFwiZmxha2Uubml4XCIpLFxuICAgICAgICBgeyBpbnB1dHMubml4cGtncy51cmwgPSBcImdpdGh1YjpOaXhPUy9uaXhwa2dzL25peG9zLXVuc3RhYmxlXCI7IG91dHB1dHMgPSB7IG5peHBrZ3MsIC4uLiB9OiB7IGRldlNoZWxscyA9IG5peHBrZ3MubGliLmdlbkF0dHJzIFtcIng4Nl82NC1saW51eFwiIFwiYWFyY2g2NC1saW51eFwiXSAoc3lzdGVtOiB7IGRlZmF1bHQgPSBuaXhwa2dzLmxlZ2FjeVBhY2thZ2VzLlxcJHtzeXN0ZW19Lm1rU2hlbGwgeyBwYWNrYWdlcyA9IFsgbml4cGtncy5sZWdhY3lQYWNrYWdlcy5cXCR7c3lzdGVtfS5oZWxsbyBdOyB9OyB9KTsgfTsgfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICBta2RpclN5bmMoam9pbihyb290LCBcIi5kZXZjb250YWluZXJcIiwgYnVpbGRlciksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgYnVpbGRlciA9PT0gXCJndWl4XCIgPyBbXCJlbnZpcm9ubWVudHMuc2NtXCIsIFwiaW1hZ2UuanNvblwiLCBcImltYWdlLnNjbVwiLCBcInByZXBhcmUuc2hcIl0gOiBbXCJpbWFnZS5uaXhcIl0pXG4gICAgY29weUZpbGVTeW5jKGpvaW4oZGlzdHJpYnV0aW9uLCBcIi5kZXZjb250YWluZXJcIiwgYnVpbGRlciwgZmlsZSksIGpvaW4ocm9vdCwgXCIuZGV2Y29udGFpbmVyXCIsIGJ1aWxkZXIsIGZpbGUpKTtcbiAgLy8gUmVjZWlwdHMgcmVsZWFzZSBldmVyeSBwdWJsaWMgR3VpeCByb290IGFuZCByZXRhaW5lZCBOaXggcHJvZmlsZSBiZWZvcmUgdGhlIGRpc3Bvc2FibGUgY2hlY2tvdXQgZGlzYXBwZWFycy5cbiAgc2NvcGUuZGVmZXIoKCkgPT5cbiAgICBydW4oXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgW1xuICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgXCJjYWNoZVwiLFxuICAgICAgICBcInBydW5lXCIsXG4gICAgICAgIFwiLS1jaGVja291dFwiLFxuICAgICAgICByb290LFxuICAgICAgICBcIi0tZGVwZW5kZW5jaWVzXCIsXG4gICAgICAgIFwiLS1hcHBseVwiLFxuICAgICAgICBcIi0tanNvblwiLFxuICAgICAgXSxcbiAgICAgIHsgY2xlYW51cDogdHJ1ZSwgY2FwdHVyZTogdHJ1ZSB9LFxuICAgICksXG4gICk7XG4gIGNvbnN0IGltYWdlID0gYHdvcmtiZW5jaC1tYW5hZ2VkLXZlcmlmaWNhdGlvbjoke3JhbmRvbVVVSUQoKX1gO1xuICBjb25zdCBiZWZvcmUgPSBuZXcgU2V0KFxuICAgIChhd2FpdCBydW4oXCJkb2NrZXJcIiwgW1wiaW1hZ2VcIiwgXCJsc1wiLCBcIi0tZm9ybWF0XCIsIFwie3suUmVwb3NpdG9yeX19Ont7LlRhZ319XCJdLCB7IGNhcHR1cmU6IHRydWUgfSkpLnNwbGl0KFwiXFxuXCIpLFxuICApO1xuICBzY29wZS5kZWZlcihhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZm91bmQgPSBhd2FpdCBydW4oXCJkb2NrZXJcIiwgW1wiaW1hZ2VcIiwgXCJsc1wiLCBcIi0tcXVpZXRcIiwgXCItLWZpbHRlclwiLCBgcmVmZXJlbmNlPSR7aW1hZ2V9YF0sIHtcbiAgICAgIGNsZWFudXA6IHRydWUsXG4gICAgICBjYXB0dXJlOiB0cnVlLFxuICAgIH0pO1xuICAgIGlmICghZm91bmQpIHJldHVybjtcbiAgICBjb25zdCBpbnNwZWN0ZWQgPSBhd2FpdCBydW4oXCJkb2NrZXJcIiwgW1wiaW1hZ2VcIiwgXCJpbnNwZWN0XCIsIGltYWdlLCBcIi0tZm9ybWF0XCIsIFwie3tqc29uIC5SZXBvVGFnc319XCJdLCB7XG4gICAgICBjbGVhbnVwOiB0cnVlLFxuICAgICAgY2FwdHVyZTogdHJ1ZSxcbiAgICB9KTtcbiAgICBjb25zdCB0YWdzOiB1bmtub3duID0gSlNPTi5wYXJzZShpbnNwZWN0ZWQpO1xuICAgIGlmICghaXNTdHJpbmdBcnJheSh0YWdzKSkgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBEb2NrZXIgaW1hZ2UgdGFnc1wiKTtcbiAgICBmb3IgKGNvbnN0IHRhZyBvZiB0YWdzKVxuICAgICAgaWYgKCFiZWZvcmUuaGFzKHRhZykgJiYgKHRhZyA9PT0gaW1hZ2UgfHwgdGFnLnN0YXJ0c1dpdGgoYHdvcmtiZW5jaC0ke2J1aWxkZXJ9LXByZXBhcmVkYCkpKVxuICAgICAgICBhd2FpdCBydW4oXCJkb2NrZXJcIiwgW1wiaW1hZ2VcIiwgXCJybVwiLCB0YWddLCB7IGNsZWFudXA6IHRydWUsIGNhcHR1cmU6IHRydWUgfSk7XG4gIH0pO1xuICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4oZGlzdHJpYnV0aW9uLCBcInNjcmlwdHMvcHJlcGFyZS1tYW5hZ2VkLWRldmVsb3BtZW50Lm1qc1wiKSwgYnVpbGRlciwgaW1hZ2VdKTtcbiAgY29uc3QgY29tbWFuZHMgPSBbXCJta2RpciAtcCAvdG1wIC9yb290OyBjaG1vZCAxNzc3IC90bXBcIl07XG4gIGlmIChidWlsZGVyID09PSBcImd1aXhcIilcbiAgICBjb21tYW5kcy5wdXNoKFxuICAgICAgXCJ0ZXN0IC1mIC9ldGMvcGFzc3dkICYmIHRlc3QgISAtTCAvZXRjL3Bhc3N3ZCAmJiB0ZXN0IC1yIC9ldGMvcGFzc3dkXCIsXG4gICAgICBcInRlc3QgLWYgL2V0Yy9ncm91cCAmJiB0ZXN0ICEgLUwgL2V0Yy9ncm91cCAmJiB0ZXN0IC1yIC9ldGMvZ3JvdXBcIixcbiAgICApO1xuICBmb3IgKGNvbnN0IGluZGV4IG9mIFswLCAxXSlcbiAgICBjb21tYW5kcy5wdXNoKFxuICAgICAgYnVpbGRlciA9PT0gXCJndWl4XCJcbiAgICAgICAgPyBgL29wdC93b3JrYmVuY2gtZW52aXJvbm1lbnRzL3J1bnRpbWVzLyR7U3RyaW5nKGluZGV4KX0vYmluL2d1aXggc2hlbGwgLS1wcm9maWxlPS9vcHQvd29ya2JlbmNoLWVudmlyb25tZW50cy8ke1N0cmluZyhpbmRleCl9IC0tIGhlbGxvYFxuICAgICAgICA6IGBuaXggLS1leHRyYS1leHBlcmltZW50YWwtZmVhdHVyZXMgJ25peC1jb21tYW5kIGZsYWtlcycgLS1vcHRpb24gZmxha2UtcmVnaXN0cnkgJycgZGV2ZWxvcCAtLW9mZmxpbmUgL29wdC93b3JrYmVuY2gtZW52aXJvbm1lbnRzLyR7U3RyaW5nKGluZGV4KX0gLS1jb21tYW5kIGhlbGxvYCxcbiAgICApO1xuICBjb25zdCBvdXRwdXQgPSBhd2FpdCBydW4oXG4gICAgXCJkb2NrZXJcIixcbiAgICBbXG4gICAgICBcInJ1blwiLFxuICAgICAgXCItLXJtXCIsXG4gICAgICBcIi0tbmV0d29yaz1ub25lXCIsXG4gICAgICBcIi0tdWxpbWl0XCIsXG4gICAgICBcInN0YWNrPTY3MTA4ODY0OjY3MTA4ODY0XCIsXG4gICAgICBcIi0tZW50cnlwb2ludFwiLFxuICAgICAgXCIvYmluL2Jhc2hcIixcbiAgICAgIGltYWdlLFxuICAgICAgXCItZWNcIixcbiAgICAgIGNvbW1hbmRzLmpvaW4oXCJcXG5cIiksXG4gICAgXSxcbiAgICB7IGNhcHR1cmU6IHRydWUgfSxcbiAgKTtcbiAgaWYgKG91dHB1dC5zcGxpdChcIlxcblwiKS5maWx0ZXIoKGxpbmU6IHN0cmluZyB8IHN0cmluZ1tdKSA9PiBsaW5lLmluY2x1ZGVzKFwiSGVsbG8sIHdvcmxkIVwiKSkubGVuZ3RoICE9PSAyKVxuICAgIHRocm93IG5ldyBFcnJvcihcIkJvdGggcmV0YWluZWQgcHJvZmlsZXMgbXVzdCBleGVjdXRlIGluIHRoZSBvZmZsaW5lIGltYWdlXCIpO1xuICBjb25zb2xlLmxvZyhgJHtidWlsZGVyfTogYm90aCBkZWNsYXJlZCBwcm9maWxlcyBleGVjdXRlZCBzdWNjZXNzZnVsbHkgd2l0aCBuZXR3b3JraW5nIGRpc2FibGVkYCk7XG59KTtcbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsY0FBYyxXQUFXLGFBQWEsUUFBUSxxQkFBcUI7QUFDNUUsU0FB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
