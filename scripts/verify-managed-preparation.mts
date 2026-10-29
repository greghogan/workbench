import { isStringArray } from "./values.mjs";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { withManagedProcesses } from "./managed-process.mjs";

// Explicit integration rehearsal: real installed manager, real store, two tiny profiles, and Docker offline execution.
const [builder] = process.argv.slice(2);
const independent = process.argv.includes("--subproject-pin");
if (process.platform !== "linux" || (builder !== "nix" && builder !== "guix"))
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
    GUIX_BUILD_OPTIONS: undefined,
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
    WORKBENCH_IMAGE_INPUTS: createHash("sha256").update(randomUUID()).digest("hex"),
  };
  const run = (command: string, args: string[], options = {}) =>
    scope.run(command, args, { cwd: root, env, ...options });
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="verification"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="other"\n',
  );
  for (const directory of [root, join(root, "other")]) {
    if (builder === "guix") {
      if (directory === root) copyFileSync(join(distribution, "channels.scm"), join(root, "channels.scm"));
      else if (independent) {
        const { readFileSync } = await import("node:fs");
        // Exercise separate declarations without selecting an unrequested channel revision.
        writeFileSync(
          join(directory, "channels.scm"),
          readFileSync(join(distribution, "channels.scm"), "utf8") + "\n;; Independent subproject declaration.\n",
        );
      }
      writeFileSync(
        join(directory, "manifest.scm"),
        '(use-modules (gnu packages) (guix profiles))\n(specifications->manifest (list "hello"))\n',
      );
    } else {
      copyFileSync(join(distribution, "flake.lock"), join(directory, "flake.lock"));
      writeFileSync(
        join(directory, "flake.nix"),
        `{ inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable"; outputs = { nixpkgs, ... }: { devShells = nixpkgs.lib.genAttrs ["x86_64-linux" "aarch64-linux"] (system: { default = nixpkgs.legacyPackages.\${system}.mkShell { packages = [ nixpkgs.legacyPackages.\${system}.hello ]; }; }); }; }`,
      );
    }
  }
  mkdirSync(join(root, ".devcontainer", builder), { recursive: true });
  for (const file of builder === "guix" ? ["environments.scm", "image.json", "image.scm", "prepare.sh"] : ["image.nix"])
    copyFileSync(join(distribution, ".devcontainer", builder, file), join(root, ".devcontainer", builder, file));
  // Receipts release every public Guix root and retained Nix profile before the disposable checkout disappears.
  scope.defer(() =>
    run(
      process.execPath,
      [
        join(distribution, "bin/workbench.mjs"),
        "cache",
        "prune",
        "--checkout",
        root,
        "--dependencies",
        "--apply",
        "--json",
      ],
      { cleanup: true, capture: true },
    ),
  );
  const image = `workbench-managed-verification:${randomUUID()}`;
  const before = new Set(
    (await run("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], { capture: true })).split("\n"),
  );
  scope.defer(async () => {
    const found = await run("docker", ["image", "ls", "--quiet", "--filter", `reference=${image}`], {
      cleanup: true,
      capture: true,
    });
    if (!found) return;
    const inspected = await run("docker", ["image", "inspect", image, "--format", "{{json .RepoTags}}"], {
      cleanup: true,
      capture: true,
    });
    const tags: unknown = JSON.parse(inspected);
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
      "test -f /etc/group && test ! -L /etc/group && test -r /etc/group",
    );
  for (const index of [0, 1])
    commands.push(
      builder === "guix"
        ? `/opt/workbench-environments/runtimes/${String(index)}/bin/guix shell --profile=/opt/workbench-environments/${String(index)} -- hello`
        : `nix --extra-experimental-features 'nix-command flakes' --option flake-registry '' develop --offline /opt/workbench-environments/${String(index)} --command hello`,
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
      commands.join("\n"),
    ],
    { capture: true },
  );
  if (output.split("\n").filter((line: string | string[]) => line.includes("Hello, world!")).length !== 2)
    throw new Error("Both retained profiles must execute in the offline image");
  console.log(`${builder}: both declared profiles executed successfully with networking disabled`);
});
