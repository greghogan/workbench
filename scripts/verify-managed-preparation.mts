import { isRecord, isStringArray, records, required } from "../app/src/core/runtime/values.mjs";
import {
  constants,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { withManagedProcesses, type ManagedProcessScope } from "./managed-process.mjs";
import { containerToolsDirectory } from "../app/src/core/artifacts/container-tools.ts";
import { imageDigest, preparedImageTag } from "../app/src/core/artifacts/image-contract.ts";
import { managedStoreMaintenanceImage, managedStoreVolumes } from "../app/src/core/storage/managed-builder-store.ts";
import { userDirectory } from "../app/src/core/storage/storage.ts";
import {
  builderOwner,
  managedProfileOwner,
  managedStoreDirectory,
  PreparationStore,
  storePrefix,
  type StoreManager,
} from "../app/src/core/execution/environments/managed/managed-contract.mjs";

// Explicit integration rehearsal: real installed manager, real store, two tiny profiles, and Docker offline execution.
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    store: { type: "string", default: PreparationStore.System },
    "subproject-pin": { type: "boolean" },
  },
});
const [builder] = positionals;
const independent = values["subproject-pin"];
if (
  process.platform !== "linux" ||
  positionals.length !== 1 ||
  (builder !== "nix" && builder !== "guix") ||
  (values.store !== PreparationStore.System && values.store !== PreparationStore.Managed)
)
  throw new Error("Use verify-managed-preparation.mjs nix|guix [--store system|managed] on Linux");
const distribution = resolve(import.meta.dirname, "..");

const guixFiles = ["environments.scm", "image.json", "image.scm", "prepare.sh"];
const sha256 = /^[a-f0-9]{64}$/;
const fixtureProfile = "qualification";

function createManagedProject(root: string, manager: StoreManager, name: string, packages: string[]) {
  const write = (path: string, contents: string) => {
    writeFileSync(join(root, path), contents);
  };
  mkdirSync(join(root, "workbench"), { recursive: true });
  mkdirSync(join(root, ".devcontainer", manager), { recursive: true });
  if (manager === "guix") mkdirSync(join(root, "scripts"));
  const configInputs =
    manager === "guix"
      ? ["channels.scm", "manifest.scm", "scripts/ci-guix-bootstrap.scm"]
      : ["flake.nix", "flake.lock", "browser.nix", "check-inputs.nix"];
  for (const file of [
    ".devcontainer/managed-build.sh",
    `.devcontainer/${manager}/Dockerfile`,
    ...(manager === "guix"
      ? ["channels.scm", "scripts/ci-guix-bootstrap.scm", ...guixFiles.map((file) => `.devcontainer/guix/${file}`)]
      : ["flake.nix", "flake.lock", ".devcontainer/nix/prepare.sh", ".devcontainer/nix/image.nix"]),
  ])
    copyFileSync(join(distribution, file), join(root, file));
  write(
    "workbench/projects.toml",
    `[[project]]\nid="${name}"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n`,
  );
  write(
    "workbench/config.toml",
    `schema_version=1
[markdown]
wrap_width=120
[compatibility]
required=false
[[development.profiles]]
name="${fixtureProfile}"
builder="${manager}"
workspace="host"
container_config=".devcontainer/${manager}/devcontainer.json"
[development.profiles.offline]
inputs=${JSON.stringify([".devcontainer", ...configInputs])}
prepare=["node", "{workbench}/scripts/prepare-managed-development.mjs", "${manager}", "{image}"]
verify=["/bin/sh", "verify.sh"]
`,
  );
  write(
    `.devcontainer/${manager}/devcontainer.json`,
    JSON.stringify({
      name,
      build: { dockerfile: "Dockerfile", context: "../.." },
      workspaceFolder: "/workbench",
    }),
  );
  if (manager === "nix") write("browser.nix", "{ pkgs }: pkgs.hello\n");
  writeManifest(root, manager, packages);
  write(
    "verify.sh",
    `set -eu
test "$WORKBENCH_OFFLINE" = 1
` +
      (manager === "guix"
        ? `test -f /etc/passwd && test ! -L /etc/passwd
test -f /etc/group && test ! -L /etc/group
test -r /opt/workbench-environments/0/bin/hello
/opt/workbench-environments/0/bin/hello --version
`
        : `mkdir -p /tmp /root
chmod 1777 /tmp
nix --extra-experimental-features 'nix-command flakes' --option flake-registry '' develop --offline /opt/workbench-environments/0 --command hello
`),
  );
}

function writeManifest(root: string, manager: StoreManager, packages: string[]): void {
  if (manager === "nix") {
    writeFileSync(
      join(root, "check-inputs.nix"),
      `{ pkgs }: pkgs.buildEnv { name = "qualification-tools"; paths = with pkgs; [ ${packages.join(" ")} ]; }\n`,
    );
    return;
  }
  const specs = packages.map((entry) => JSON.stringify(entry)).join(" ");
  writeFileSync(
    join(root, "manifest.scm"),
    `(use-modules (gnu packages) (guix profiles))\n(specifications->manifest (list ${specs}))\n`,
  );
}

function managedPins(directory: string, manager: StoreManager, project: string, inputs: string): string {
  return join(
    directory,
    manager === "guix" ? "state" : "store/var/nix",
    "gcroots",
    "workbench",
    managedProfileOwner(project, fixtureProfile),
    inputs,
  );
}

function managedPinTargets(directory: string, manager: StoreManager, project: string, inputs: string): string[] {
  const pins = managedPins(directory, manager, project, inputs);
  const prefix = storePrefix(manager) + "/";
  return readdirSync(pins)
    .filter((name) => name !== "archive")
    .map((name) => {
      if (!/^\d+$/.test(name)) throw new Error(`Unexpected root link in ${pins}`);
      const target = readlinkSync(join(pins, name));
      if (!target.startsWith(prefix) || !/^[a-z0-9]{32}-[^/]+$/.test(target.slice(prefix.length)))
        throw new Error(`Root points outside the ${manager} store: ${target}`);
      const retained = lstatSync(join(directory, "store", relative(dirname(prefix), target)));
      if (!retained.isDirectory() && !retained.isFile())
        throw new Error(`Expected a retained profile or runtime: ${target}`);
      return target;
    })
    .sort();
}

/** Real public CLI builds share one private store across independent projects. */
async function verifyManagedStore(scope: ManagedProcessScope, manager: StoreManager) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `workbench-${manager}-qualification-`)));
  const cache = join(base, "cache");
  let safeToRemove = true;
  scope.defer(() => {
    if (safeToRemove) rmSync(base, { recursive: true, force: true });
    else console.error(`Preserving disposable qualification data at ${base}`);
  });
  const entry = join(distribution, "bin/workbench.mjs");
  const toolsEnvironment = {
    ...process.env,
    WORKBENCH_PROJECT_ROOT: distribution,
    WORKBENCH_LOCAL_CONFIG_ROOT: distribution,
    WORKBENCH_DATA_HOME: join(base, "tool-data"),
    WORKBENCH_STATE_HOME: join(base, "tool-state"),
  };
  await scope.run(process.execPath, [entry, "project", "add", distribution], {
    cwd: distribution,
    env: toolsEnvironment,
    capture: true,
  });
  const tools = records(
    JSON.parse(
      await scope.run(process.execPath, [entry, "tools", "--json", "--path", "."], {
        cwd: distribution,
        env: toolsEnvironment,
        capture: true,
      }),
    ),
    "Invalid native tools inspection",
  );
  const originalCache = userDirectory("cache");
  for (const path of [
    containerToolsDirectory(distribution),
    ...tools.map((tool) => {
      if (tool.state !== "installed" || typeof tool.directory !== "string")
        throw new Error(`Run the Workbench development setup before qualifying managed ${manager}`);
      return tool.directory;
    }),
  ]) {
    const subpath = relative(originalCache, path);
    if (isAbsolute(subpath) || subpath.startsWith("../") || subpath === ".." || !subpath)
      throw new Error("Qualification tools must reside in the prepared Workbench cache");
    const destination = join(cache, subpath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    cpSync(path, destination, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  }
  const first = join(base, "first"),
    second = join(base, "second"),
    projects = [first, second];
  const env = (root: string): NodeJS.ProcessEnv => ({
    ...process.env,
    CI: undefined,
    GITHUB_ACTIONS: undefined,
    GITLAB_CI: undefined,
    GUIX_BUILD_OPTIONS: undefined,
    WORKBENCH_DISTRIBUTION_ROOT: distribution,
    WORKBENCH_PROJECT_ROOT: root,
    WORKBENCH_LOCAL_CONFIG_ROOT: root,
    WORKBENCH_CONTAINER_CHECKOUT: root,
    WORKBENCH_CONFIG_HOME: join(base, "config"),
    WORKBENCH_STATE_HOME: join(base, "state"),
    WORKBENCH_DATA_HOME: join(base, "data"),
    WORKBENCH_CACHE_HOME: cache,
    WORKBENCH_STORAGE_ROOT: cache,
    WORKBENCH_STORAGE_EXTERNAL: "true",
  });
  const workbench = (root: string, args: string[], options: { capture?: boolean; cleanup?: boolean } = {}) =>
    scope.run(process.execPath, [entry, ...args], { cwd: root, env: env(root), ...options });
  const docker = (args: string[], options: { cleanup?: boolean } = {}) =>
    scope.run("docker", args, { capture: true, ...options });
  const prune = (root: string, checkout: "builders" | "images", cleanup = false) =>
    workbench(root, ["cache", "prune", "--checkout", checkout, "--apply", "--json"], { capture: true, cleanup });
  for (const [index, root] of projects.entries()) {
    createManagedProject(root, manager, `${manager}-${String(index)}`, [
      "hello",
      ...(index ? [manager === "guix" ? "grep" : "gnugrep"] : []),
    ]);
    await scope.run("git", ["init", "--quiet"], { cwd: root });
    await scope.run("git", ["add", "--all"], { cwd: root });
    await scope.run(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Workbench",
        "-c",
        "user.email=verification@example.invalid",
        "commit",
        "--quiet",
        "-m",
        `Create disposable ${manager} qualification project`,
      ],
      { cwd: root },
    );
    await workbench(root, ["project", "add", root]);
  }
  await workbench(first, ["config", "set", "--scope", "global", `preparation.${manager}_store`, "managed"]);
  await workbench(first, ["config", "set", "--scope", "global", "cache.auto_prune", "false"]);
  const prepare = async (root: string) => {
    await workbench(root, ["development", "prepare", fixtureProfile, "--build"]);
    const receipt: unknown = JSON.parse(
      readFileSync(join(cache, "offline-profiles", builderOwner(root), `${fixtureProfile}.json`), "utf8"),
    );
    if (
      !isRecord(receipt) ||
      typeof receipt.image !== "string" ||
      !imageDigest.test(receipt.image) ||
      typeof receipt.inputs !== "string" ||
      !sha256.test(receipt.inputs) ||
      typeof receipt.verified !== "string"
    )
      throw new Error("Managed preparation did not publish verified image evidence");
    return { inputs: receipt.inputs, image: receipt.image };
  };
  safeToRemove = false;
  const original = await prepare(first);
  const storage = managedStoreDirectory(cache, manager);
  const stores = readdirSync(storage).filter((name) => /^[a-f0-9]{24}$/.test(name));
  const key = required(stores[0], `Missing managed ${manager} store`);
  if (stores.length !== 1) throw new Error(`Expected one compatible ${manager} store`);
  const directory = join(storage, key);
  const expectedMounts = managedStoreVolumes(manager, key);
  const mounts = async (cleanup = false) => {
    const volumes: string[] = [];
    for (const { role, name } of expectedMounts) {
      const found = await docker(["volume", "ls", "-q", "--filter", `name=^${name}$`], { cleanup });
      if (!found) continue;
      const options: unknown = JSON.parse(
        await docker(["volume", "inspect", "--format", "{{json .Options}}", name], { cleanup }),
      );
      if (
        found !== name ||
        !isRecord(options) ||
        options.type !== "none" ||
        options.o !== "bind" ||
        options.device !== join(directory, role)
      )
        throw new Error(`Unexpected Docker volume identity: ${name}`);
      volumes.push(name);
    }
    return volumes;
  };
  const dropMounts = async (cleanup = false) => {
    const volumes = await mounts(cleanup);
    if (volumes.length) await docker(["volume", "rm", ...volumes], { cleanup });
  };
  const maintenanceTag = `workbench-managed-store:${manager}-${key}`;
  scope.defer(async () => {
    await prune(first, "builders", true);
    await prune(first, "images", true);
    await dropMounts(true);
    const image = managedStoreMaintenanceImage(directory);
    const tagged = await docker(["image", "inspect", "--format", "{{.Id}}", maintenanceTag], { cleanup: true });
    if (tagged !== image) throw new Error(`Managed cleanup image changed: ${maintenanceTag}`);
    await docker(
      [
        "run",
        "--rm",
        "--pull",
        "never",
        "--network=none",
        "--entrypoint",
        "/bin/sh",
        "--mount",
        `type=bind,src=${storage},dst=/fixture`,
        image,
        "-ec",
        'rm -rf -- "/fixture/$1"',
        "workbench-managed-cleanup",
        key,
      ],
      { cleanup: true },
    );
    await docker(["image", "rm", maintenanceTag], { cleanup: true });
    safeToRemove = true;
  });
  const other = await prepare(second);
  const pins = (project: string, inputs: string) => managedPins(directory, manager, project, inputs);
  const pinTargets = (project: string, inputs: string) => managedPinTargets(directory, manager, project, inputs);
  const firstPins = pinTargets(first, original.inputs);
  const secondPins = pinTargets(second, other.inputs);
  if (
    !firstPins.some((target) => secondPins.includes(target)) ||
    !firstPins.some((target) => !secondPins.includes(target))
  )
    throw new Error("The two pinned closures must share runtime objects and have distinct project profiles");
  if (readdirSync(storage).filter((name) => /^[a-f0-9]{24}$/.test(name)).length !== 1)
    throw new Error(`Both projects must share one compatible ${manager} store`);
  await prune(first, "builders");
  if (
    [pins(first, original.inputs), pins(second, other.inputs)].some((generation) =>
      lstatSync(join(generation, "archive"), { throwIfNoEntry: false }),
    )
  )
    throw new Error("Verification did not allow removing the transient archive roots");
  const firstReference = `workbench-prepared-${builderOwner(first).slice(0, 24)}:${preparedImageTag(process.arch, original.inputs)}`;
  if ((await docker(["image", "inspect", "--format", "{{.Id}}", firstReference])) !== original.image)
    throw new Error(`Managed prepared image changed: ${firstReference}`);
  await docker(["image", "rm", firstReference]);
  if ((await mounts()).length !== expectedMounts.length) throw new Error("Store mounts must be registered");
  await dropMounts();
  writeManifest(first, manager, ["hello", manager === "guix" ? "sed" : "gnused"]);
  const replacement = await prepare(first);
  if (replacement.inputs === original.inputs) throw new Error("The manifest change did not select new inputs");
  const replacementPins = pinTargets(first, replacement.inputs);
  if (JSON.stringify(pinTargets(first, original.inputs)) !== JSON.stringify(firstPins))
    throw new Error("Profile pins changed after image, builder and volume cleanup");
  if ((await mounts()).length !== expectedMounts.length) throw new Error("Store mounts must be recreated");
  await prune(first, "builders");
  if (lstatSync(pins(first, original.inputs), { throwIfNoEntry: false }))
    throw new Error("Builder pruning left the superseded project's roots registered");
  if (
    JSON.stringify(pinTargets(first, replacement.inputs)) !== JSON.stringify(replacementPins) ||
    JSON.stringify(pinTargets(second, other.inputs)) !== JSON.stringify(secondPins)
  )
    throw new Error("Builder pruning changed roots for a current project profile");
  for (const root of projects) await workbench(root, ["development", "verify", fixtureProfile]);
  console.log(
    `Managed ${manager} preserved shared packages and active profile pins through Docker cleanup and project pruning.`,
  );
}

const verification = withManagedProcesses(async (scope) => {
  if (values.store === PreparationStore.Managed) return verifyManagedStore(scope, builder);
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
    WORKBENCH_PREPARATION_STORE: PreparationStore.System,
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
  for (const file of builder === "guix" ? guixFiles : ["image.nix"])
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
await verification.catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
