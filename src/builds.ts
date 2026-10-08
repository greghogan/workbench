import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readConfig, readText } from "./core.js";
import { type CheckEnvironment, executionPreference, localConfiguration } from "./environments.js";
import { ownedPath } from "./paths.js";
import { storageSettings } from "./user-config.js";
import { userDirectory } from "./storage.js";
import { selectedCompiler, type CompilerSelection } from "./compilers.js";

const marker = ".workbench-build.json";
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const pinFiles = [
  ".node-version",
  ".python-version",
  ".go-version",
  ".llvm-version",
  ".gcc-version",
  "CMakeLists.txt",
  ".tool-versions",
  "rust-toolchain.toml",
  "rust-toolchain-miri.toml",
  ".vcpkg-version",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "vcpkg.json",
  "vcpkg-configuration.json",
];

export interface BuildPaths {
  external: boolean;
  projectDirectory: string;
  storageRoot: string;
  base: string;
  roots: string;
  directory: string;
  dependencyRoots: string;
  dependencies: string;
  pnpmStore: string;
  identity: { checkout: string; root: string; environment: CheckEnvironment; fingerprint: string };
}

/** Resolve existing ancestors (including macOS's /var alias) without creating cache directories. */
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) throw new Error(`cannot resolve build root: ${path}`);
  return join(canonical(parent), relative(parent, path));
}

export function buildPaths(
  root: string,
  directory: string,
  selected?: CheckEnvironment,
  compilerSelection: CompilerSelection = {},
  inspectTools = true,
): BuildPaths {
  root = realpathSync(root);
  directory = realpathSync(directory);
  const subdirectory = relative(root, directory);
  if (isAbsolute(subdirectory) || subdirectory === ".." || subdirectory.startsWith(`..${sep}`))
    throw new Error("build root must belong to the project checkout");
  const environment = selected ?? executionPreference(root) ?? readConfig(root).checks?.environment ?? "native";
  if (!["native", "guix", "nix", "nix-docker", "devcontainer"].includes(environment))
    throw new Error(`invalid build environment: ${environment}`);
  const storage = storageSettings(localConfiguration(root).storage);
  const storageRoot = canonical(resolve(storage.root));
  const base = join(storageRoot, "builds");
  const inside = relative(root, base);
  if (storage.external && (!inside || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`))))
    throw new Error("build storage must be outside the project checkout");
  const checkout = process.env.WORKBENCH_CONTAINER_CHECKOUT ?? root;
  const compiler = inspectTools ? selectedCompiler(directory, compilerSelection) : undefined;
  const inputs = [
    ...pinFiles,
    ...(environment === "guix" ? ["channels.scm", "manifest.scm"] : []),
    ...(environment === "nix" || environment === "nix-docker" ? ["flake.nix", "flake.lock"] : []),
    ...readdirSync(directory).filter(
      (file) =>
        (environment === "guix" && file.endsWith(".scm")) ||
        ((environment === "nix" || environment === "nix-docker") && file.endsWith(".nix")),
    ),
  ];
  const fingerprint = digest(
    JSON.stringify({
      platform: environment === "nix-docker" || environment === "devcontainer" ? "linux" : process.platform,
      architecture: process.arch,
      compiler,
      files: [...new Set(inputs)]
        .sort()
        .map((file) => [file, existsSync(join(directory, file)) ? readText(join(directory, file)) : null]),
      container: environment === "nix-docker" ? readConfig(root).checks?.nix_docker_image : null,
      devcontainer:
        environment === "devcontainer"
          ? [".devcontainer/devcontainer.json", ".devcontainer/Dockerfile"].map((file) => [
              file,
              existsSync(join(root, file)) ? readText(join(root, file)) : null,
            ])
          : null,
      flags: Object.fromEntries(
        ["CC", "CXX", "CFLAGS", "CXXFLAGS", "RUSTFLAGS", "GOFLAGS", "SDKROOT"].map((name) => [
          name,
          process.env[name] ?? null,
        ]),
      ),
    }),
  );
  const identity = { checkout, root: subdirectory || ".", environment: environment as CheckEnvironment, fingerprint };
  const roots = ownedPath(base, `${digest(checkout)}/${digest(identity.root)}`);
  const dependencyRoots = ownedPath(join(storageRoot, "dependencies"), `${digest(checkout)}/${digest(identity.root)}`);
  return {
    external: storage.external,
    projectDirectory: directory,
    storageRoot,
    base,
    roots,
    directory: storage.external
      ? ownedPath(roots, `${environment}-${fingerprint}`)
      : compiler
        ? join(directory, "build", `${environment}-${fingerprint}`)
        : join(directory, "build"),
    dependencyRoots,
    dependencies: ownedPath(dependencyRoots, `${environment}-${fingerprint}`),
    pnpmStore: ownedPath(storageRoot, "downloads/pnpm"),
    identity,
  };
}

export function prepareBuild(paths: BuildPaths): void {
  if (!paths.external) {
    ownedPath(paths.projectDirectory, "build");
    if (paths.directory !== join(paths.projectDirectory, "build"))
      prepareOwnedDirectory(join(paths.projectDirectory, "build"), paths.directory, marker, paths.identity);
    return;
  }
  prepareOwnedDirectory(paths.base, paths.directory, marker, paths.identity);
  prepareOwnedDirectory(paths.storageRoot, paths.dependencies, ".workbench-dependencies.json", paths.identity);
  ownedPath(paths.storageRoot, "downloads/pnpm");
  mkdirSync(paths.pnpmStore, { recursive: true, mode: 0o700 });
}

function prepareOwnedDirectory(
  base: string,
  directory: string,
  filename: string,
  identity: BuildPaths["identity"],
): void {
  ownedPath(base, relative(base, directory).split(sep).join("/"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receipt = ownedPath(directory, filename);
  const body = JSON.stringify(identity) + "\n";
  if (!existsSync(receipt) && readdirSync(directory).length)
    throw new Error(`${directory}: refusing to adopt unowned build files`);
  try {
    writeFileSync(receipt, body, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (readFileSync(receipt, "utf8") !== body)
      throw new Error(`${receipt}: build ownership does not match`, { cause: error });
  }
}

export function buildEnvironment(paths: BuildPaths): Record<string, string> {
  return {
    WORKBENCH_BUILD_DIR: paths.directory,
    WORKBENCH_STORAGE_EXTERNAL: String(paths.external),
    WORKBENCH_STORAGE_ROOT: paths.storageRoot,
    ...(paths.external
      ? {
          WORKBENCH_DEPENDENCIES_DIR: paths.dependencies,
          PNPM_CONFIG_STORE_DIR: paths.pnpmStore,
          PNPM_CONFIG_VIRTUAL_STORE_DIR: join(paths.dependencies, "pnpm"),
          PNPM_CONFIG_VIRTUAL_STORE_TYPE: "project",
          UV_PROJECT_ENVIRONMENT: join(paths.dependencies, "venv"),
          CARGO_TARGET_DIR: join(paths.directory, "cargo"),
          PYTHONPYCACHEPREFIX: join(paths.directory, "pycache"),
          MYPY_CACHE_DIR: join(paths.directory, "mypy"),
          RUFF_CACHE_DIR: join(paths.directory, "ruff"),
          PYTEST_ADDOPTS:
            `${process.env.PYTEST_ADDOPTS ?? ""} -o cache_dir=${JSON.stringify(join(paths.directory, "pytest"))}`.trim(),
          COVERAGE_FILE: join(paths.directory, ".coverage"),
          UV_BUILD_OUT_DIR: join(paths.directory, "python-dist"),
        }
      : {}),
  };
}

/** Refuse overlapping Workbench builds/cleanup; never guess that an unfamiliar lock is stale. */
export function withBuildLock<T>(paths: BuildPaths, action: () => T): T {
  // One lock spans local/external selections and storage-root changes without requiring the external disk in local mode.
  const locks = join(userDirectory("cache"), "locks");
  const parent = ownedPath(locks, digest(paths.identity.checkout));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const lock = ownedPath(parent, digest(paths.identity.root));
  try {
    mkdirSync(lock);
  } catch (error) {
    throw new Error(`${lock}: another build or cleanup may be active; inspect before removing a stale lock`, {
      cause: error,
    });
  }
  try {
    return action();
  } finally {
    rmSync(lock, { recursive: true });
  }
}

/** Only this root's marked products are disposable; dependency downloads and tool installations are separate. */
export function cleanBuilds(paths: BuildPaths, dependencies = false): void {
  if (!existsSync(paths.roots) && !existsSync(paths.dependencyRoots)) return;
  withBuildLock(paths, () => {
    const directories: string[] = [];
    for (const [root, filename] of [
      [paths.roots, marker],
      ...(dependencies ? [[paths.dependencyRoots, ".workbench-dependencies.json"]] : []),
    ] as [string, string][]) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.name === ".workbench-lock") continue;
        const directory = ownedPath(root, entry.name);
        if (!entry.isDirectory()) throw new Error(`${directory}: unexpected file in build storage`);
        const receipt = ownedPath(directory, filename);
        if (!existsSync(receipt) || !lstatSync(receipt).isFile())
          throw new Error(`${directory}: unowned build directory`);
        const owner = JSON.parse(readText(receipt)) as BuildPaths["identity"];
        if (
          owner.checkout !== paths.identity.checkout ||
          owner.root !== paths.identity.root ||
          entry.name !== `${owner.environment}-${owner.fingerprint}`
        )
          throw new Error(`${directory}: build ownership does not match`);
        directories.push(directory);
      }
    }
    for (const directory of directories) rmSync(directory, { recursive: true });
  });
}

export function assertBuildOutput(directory: string): void {
  const output = process.env.WORKBENCH_BUILD_DIR;
  if (!output || !isAbsolute(output)) throw new Error("build output requires a configured Workbench environment");
  const within = relative(output, resolve(directory));
  if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
    throw new Error("build output must be a child of WORKBENCH_BUILD_DIR");
  if (existsSync(output) && lstatSync(output).isSymbolicLink())
    throw new Error(`${output}: build directory must not be a symlink`);
  const receipt = ownedPath(output, marker);
  if (!existsSync(receipt) && resolve(output) !== join(realpathSync(process.cwd()), "build"))
    throw new Error(`${output}: missing build ownership receipt`);
  ownedPath(output, within.split(sep).join("/"));
}
