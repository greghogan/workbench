import { guixChannelFile } from "../scripts/managed-contract.mjs";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { distributionRoot, readConfig, readLanguageRoots, readText, writeAtomic } from "./core.js";
import {
  type CheckEnvironment,
  executionPreference,
  localConfiguration,
  selectedDevelopmentProfile,
} from "./environments.js";
import { ownedPath, relativePath } from "./paths.js";
import { storageSettings } from "./user-config.js";
import { userDirectory } from "./storage.js";
import { selectedCompiler, type CompilerSelection } from "./compilers.js";
import { nativeTools, assetFor, toolDirectory } from "./native-assets.js";
import { acquisitionIdentity } from "./artifact-policy.js";
import { withToolCacheAdmission } from "./tool-cache-lock.js";
import { guixProfileRegistrations, releaseGuixProfiles } from "./managed-profiles.js";
import { withCacheLocksSync, releaseAfterFailure } from "./cache-lock.js";
import { acquireProcessLock, type ProcessLock } from "./process-lock.js";
import { declaredCheckEnvironment } from "./language-config.js";

const marker = ".workbench-build.json";
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const nodeInputs = [".node-version", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
const compilerInputs = [
  ".llvm-version",
  ".gcc-version",
  ".vcpkg-version",
  "CMakeLists.txt",
  "vcpkg.json",
  "vcpkg-configuration.json",
];
const languageInputs: Record<string, string[]> = {
  typescript: nodeInputs,
  javascript: nodeInputs,
  c: compilerInputs,
  cpp: compilerInputs,
  python: [".python-version", "pyproject.toml", "uv.lock"],
  rust: ["rust-toolchain.toml", "rust-toolchain-miri.toml", "Cargo.toml", "Cargo.lock"],
  go: [".go-version", "go.mod", "go.sum"],
  ruby: [".ruby-version", "Gemfile", "Gemfile.lock"],
  java: [
    ".java-version",
    "pom.xml",
    ".mvn/checksums/checksums.sha256",
    ".mvn/settings.xml",
    ".mvn/maven.config",
    ".mvn/jvm.config",
  ],
  php: [
    ".php-version",
    ".composer-version",
    "composer.json",
    "composer.lock",
    ".composer/checksums.json",
    ".composer/verify/composer.json",
    ".composer/verify/src/VerifyPlugin.php",
    ".xdebug-version",
    "tools/composer.json",
    "tools/composer.lock",
    "tools/.composer/checksums.json",
    "tools/compat/composer.json",
    "tools/compat/composer.lock",
    "tools/compat/.composer/checksums.json",
  ],
};

export interface BuildIdentity {
  checkout: string;
  root: string;
  environment: CheckEnvironment;
  fingerprint: string;
  localCI?: { image: string; target: string };
}

export type BuildCacheKind = "builds" | "dependencies" | "checks" | "logs";
const markers: Record<BuildCacheKind, string> = {
  builds: marker,
  dependencies: ".workbench-dependencies.json",
  checks: ".workbench-check-result.json",
  logs: ".workbench-check-logs.json",
};
const ownerScope = (identity: BuildIdentity) =>
  [identity.root, identity.localCI?.image ?? null, identity.localCI?.target ?? null] as const;

/** All environments and generations of one owner use the same build lock. */
export const buildOwnerKey = (identity: BuildIdentity): string =>
  JSON.stringify([identity.checkout, ...ownerScope(identity)]);

export interface BuildPaths {
  external: boolean;
  projectDirectory: string;
  languages: string[];
  storageRoot: string;
  base: string;
  roots: string;
  directory: string;
  dependencyRoots: string;
  dependencies: string;
  pnpmStore: string;
  inputs: string[];
  identity: BuildIdentity;
}

/** Resolve existing ancestors (including macOS's /var alias) without creating cache directories. */
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) throw new Error(`cannot resolve build root: ${path}`);
  return join(canonical(parent), relative(parent, path));
}

export function buildStorageSettings(root?: string): { external: boolean; root: string } {
  const settings = storageSettings(root ? localConfiguration(root).storage : undefined);
  return { ...settings, root: canonical(resolve(settings.root)) };
}

/** Container mounts and local CI retain their host checkout's cache/lock identity. */
export function buildCheckout(root: string): string {
  return process.env.WORKBENCH_CONTAINER_CHECKOUT ?? root;
}

export function buildStorageRoots(storageRoot: string, identity: Pick<BuildIdentity, "checkout" | "root">) {
  const suffix = `${digest(identity.checkout)}/${digest(identity.root)}`;
  return {
    roots: ownedPath(join(storageRoot, "builds"), suffix),
    dependencyRoots: ownedPath(join(storageRoot, "dependencies"), suffix),
    checkRoots: ownedPath(join(storageRoot, "check-results"), suffix),
  };
}

export function checkLogDirectory(storageRoot: string, checkout: string, root: string, run: string): string {
  const project = basename(checkout).replace(/[^a-zA-Z0-9._-]/g, "-") || "project";
  const owner = createHash("sha256")
    .update(JSON.stringify([checkout, root]))
    .digest("hex")
    .slice(0, 16);
  return ownedPath(storageRoot, `check-logs/${project}-${owner}/${run}`);
}

/** A namespace receipt also identifies earlier logs from the same checkout and root. */
export function prepareCheckLogs(storageRoot: string, checkout: string, root: string, run: string): string {
  const directory = checkLogDirectory(storageRoot, checkout, root, run);
  const namespace = dirname(directory);
  const receipt = join(namespace, markers.logs);
  const identity: BuildIdentity = { checkout, root, environment: "native", fingerprint: "0".repeat(24) };
  if (existsSync(receipt)) {
    if (!isDeepStrictEqual(readBuildIdentity(namespace, markers.logs), identity))
      throw new Error(`${namespace}: check-log ownership changed`);
  } else writeAtomic(receipt, JSON.stringify(identity), 0o600);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** Receipts are untrusted cache input; validate before using them to select cleanup paths or locks. */
export function readBuildIdentity(directory: string, filename: string): BuildIdentity {
  const receipt = ownedPath(directory, filename);
  if (!existsSync(receipt) || !lstatSync(receipt).isFile()) throw new Error(`${directory}: unowned build directory`);
  const value = JSON.parse(readText(receipt)) as BuildIdentity | null;
  if (
    !value ||
    typeof value.checkout !== "string" ||
    !(isAbsolute(value.checkout) || win32.isAbsolute(value.checkout)) ||
    typeof value.root !== "string" ||
    !["native", "guix", "nix", "nix-docker", "devcontainer"].includes(value.environment) ||
    typeof value.fingerprint !== "string" ||
    !/^[a-f0-9]{24}$/.test(value.fingerprint)
  )
    throw new Error(`${receipt}: invalid build ownership`);
  relativePath(value.root.split(sep).join("/"), receipt, true);
  const localCI: unknown = value.localCI;
  if (
    localCI !== undefined &&
    (typeof localCI !== "object" ||
      localCI === null ||
      !("image" in localCI) ||
      typeof localCI.image !== "string" ||
      !localCI.image.length ||
      !("target" in localCI) ||
      typeof localCI.target !== "string" ||
      !localCI.target.length)
  )
    throw new Error(`${receipt}: invalid local CI ownership`);
  return value;
}

/** Shared inspection and deletion preflight for an externally stored, owned generation. */
export function readBuildGeneration(
  storageRoot: string,
  directory: string,
  kind: BuildCacheKind,
  expected?: BuildIdentity,
): BuildIdentity {
  ownedPath(storageRoot, relative(storageRoot, directory).split(sep).join("/"));
  const run = basename(directory);
  const identity =
    kind === "logs"
      ? { ...readBuildIdentity(dirname(directory), markers.logs), fingerprint: digest(run) }
      : readBuildIdentity(directory, markers[kind]);
  if (expected && !isDeepStrictEqual(identity, expected))
    throw new Error(`${directory}: cache ownership changed; inspect again`);
  const roots = buildStorageRoots(storageRoot, identity);
  const expectedPath =
    kind === "logs"
      ? checkLogDirectory(storageRoot, identity.checkout, identity.root, run)
      : join(
          kind === "builds" ? roots.roots : kind === "checks" ? roots.checkRoots : roots.dependencyRoots,
          `${identity.environment}-${identity.fingerprint}`,
        );
  if (directory !== expectedPath || (kind === "logs" && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(run)))
    throw new Error(`${directory}: build ownership does not match its cache location`);
  return identity;
}

export function buildPaths(
  root: string,
  directory: string,
  selected?: CheckEnvironment,
  compilerSelection: CompilerSelection = {},
  inspectTools = true,
  runtime?: { name: string; version: string },
): BuildPaths {
  root = realpathSync(root);
  directory = realpathSync(directory);
  const subdirectory = relative(root, directory);
  if (isAbsolute(subdirectory) || subdirectory === ".." || subdirectory.startsWith(`..${sep}`))
    throw new Error("build root must belong to the project checkout");
  const languages = existsSync(join(root, "workbench/projects.toml"))
    ? readLanguageRoots(root)
        .filter((entry) => resolve(root, entry.path) === directory)
        .map((entry) => entry.language)
    : [];
  const environment = selected ?? executionPreference(root) ?? readConfig(root).checks?.environment ?? "native";
  if (!["native", "guix", "nix", "nix-docker", "devcontainer"].includes(environment))
    throw new Error(`invalid build environment: ${environment}`);
  const storage = buildStorageSettings(root);
  const profile = environment === "devcontainer" ? selectedDevelopmentProfile(root) : undefined;
  const storageRoot = storage.root;
  const base = join(storageRoot, "builds");
  const inside = relative(root, base);
  if (storage.external && (!inside || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`))))
    throw new Error("build storage must be outside the project checkout");
  const checkout = buildCheckout(root);
  const image = process.env.WORKBENCH_LOCAL_CI_IMAGE;
  const target = process.env.WORKBENCH_CI_TARGET;
  if (image !== undefined && (!image || !target)) throw new Error("local CI requires an image and target");
  const localCI = image && target ? { image, target } : undefined;
  const compiler = inspectTools ? selectedCompiler(directory, { ...compilerSelection, environment }) : undefined;
  const distribution = compiler && environment === "native" ? distributionRoot(root) : undefined;
  const nativeArtifacts = distribution
    ? nativeTools(directory, distribution, compilerSelection).flatMap((tool) => {
        if (["rust", "miri", "python"].includes(tool.name)) return [];
        const asset = assetFor(distribution, tool, directory);
        return asset ? [[tool.name, toolDirectory(tool, asset), acquisitionIdentity(asset)]] : [];
      })
    : undefined;
  const inputs = [
    ...new Set([
      ".tool-versions",
      ...languages.flatMap((language) => languageInputs[language] ?? []),
      ...(environment === "guix" || profile?.builder === "guix" ? ["manifest.scm"] : []),
      ...(environment === "nix" || environment === "nix-docker" || profile?.builder === "nix"
        ? ["flake.nix", "flake.lock"]
        : []),
      ...(["guix", "nix", "nix-docker"].includes(environment) ? ["managed-check-inputs.json"] : []),
      ...readdirSync(directory).filter(
        (file) =>
          (environment === "guix" && file !== "channels.scm" && file.endsWith(".scm")) ||
          ((environment === "nix" || environment === "nix-docker") && file.endsWith(".nix")),
      ),
    ]),
  ].sort();
  const containerInputs =
    environment === "devcontainer"
      ? [
          profile?.container_config ?? ".devcontainer/devcontainer.json",
          `${dirname(profile?.container_config ?? ".devcontainer/devcontainer.json")}/Dockerfile`,
        ]
      : [];
  const declared =
    environment === "native"
      ? existsSync(join(root, "workbench/config.toml"))
        ? declaredCheckEnvironment(root, languages)
        : []
      : undefined;
  const fingerprint = digest(
    JSON.stringify({
      platform: environment === "nix-docker" || environment === "devcontainer" ? "linux" : process.platform,
      architecture: process.arch,
      compiler,
      runtime,
      localCI,
      nativeArtifacts,
      files: inputs.map((file) => [file, existsSync(join(directory, file)) ? readText(join(directory, file)) : null]),
      guixChannels:
        environment === "guix" || profile?.builder === "guix"
          ? existsSync(guixChannelFile(root, directory))
            ? readText(guixChannelFile(root, directory))
            : null
          : undefined,
      container: environment === "nix-docker" ? readConfig(root).checks?.nix_docker_image : null,
      devcontainer:
        environment === "devcontainer"
          ? containerInputs.map((file) => [file, existsSync(join(root, file)) ? readText(join(root, file)) : null])
          : null,
      profile,
      flags: Object.fromEntries(
        [
          "CC",
          "CXX",
          "CFLAGS",
          "CXXFLAGS",
          "CPPFLAGS",
          "LDFLAGS",
          "CPATH",
          "C_INCLUDE_PATH",
          "CPLUS_INCLUDE_PATH",
          "LIBRARY_PATH",
          "CMAKE_PREFIX_PATH",
          "PKG_CONFIG_PATH",
          "SDKROOT",
          "DEVELOPER_DIR",
          "MACOSX_DEPLOYMENT_TARGET",
          "RUSTFLAGS",
          "CARGO_ENCODED_RUSTFLAGS",
          "RUSTDOCFLAGS",
          "GOFLAGS",
          "WORKBENCH_LTO",
          "WORKBENCH_CI_TARGET",
        ]
          .filter((name) => {
            if (declared && !declared.includes(name)) return false;
            if (["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTDOCFLAGS"].includes(name))
              return languages.includes("rust");
            if (name === "GOFLAGS") return languages.includes("go");
            if (name === "WORKBENCH_CI_TARGET") return true;
            return languages.some((language) => ["c", "cpp", "rust", "go", "ruby", "php"].includes(language));
          })
          .map((name) => {
            const value =
              name === "GOFLAGS" ? process.env[name]?.replace(/(?:^|\s)-p=\S+/g, "").trim() : process.env[name];
            return [name, value === "" ? null : (value ?? null)];
          }),
      ),
    }),
  );
  const identity = {
    checkout,
    root: subdirectory || ".",
    environment: environment as CheckEnvironment,
    fingerprint,
    ...(localCI ? { localCI } : {}),
  };
  const { roots, dependencyRoots } = buildStorageRoots(storageRoot, identity);
  return {
    external: storage.external,
    projectDirectory: directory,
    languages,
    storageRoot,
    base,
    roots,
    directory: storage.external
      ? ownedPath(roots, `${environment}-${fingerprint}`)
      : compiler || runtime
        ? join(directory, "build", `${environment}-${fingerprint}`)
        : join(directory, "build"),
    dependencyRoots,
    dependencies: ownedPath(dependencyRoots, `${environment}-${fingerprint}`),
    pnpmStore: ownedPath(storageRoot, "downloads/pnpm"),
    inputs: [...inputs.map((file) => join(directory, file)), ...containerInputs.map((file) => join(root, file))],
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
  prepareBuildDependencies(paths);
  ownedPath(paths.storageRoot, "downloads/pnpm");
  mkdirSync(paths.pnpmStore, { recursive: true, mode: 0o700 });
}

/** Managed GC roots are dependencies even when project outputs stay in the checkout. */
export function prepareBuildDependencies(paths: BuildPaths): void {
  prepareOwnedDirectory(paths.storageRoot, paths.dependencies, ".workbench-dependencies.json", paths.identity);
}

function prepareOwnedDirectory(base: string, directory: string, filename: string, identity: BuildIdentity): void {
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
    if (!isDeepStrictEqual(readBuildIdentity(directory, filename), identity))
      throw new Error(`${receipt}: build ownership does not match`, { cause: error });
  }
}

/** Prepared artifacts follow the same ownership and cleanup boundary as other generated products. */
export function distributionDirectory(paths: Pick<BuildPaths, "external" | "directory" | "projectDirectory">): string {
  return ownedPath(paths.external ? paths.directory : paths.projectDirectory, "dist");
}

export function buildEnvironment(paths: BuildPaths, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    WORKBENCH_BUILD_DIR: paths.directory,
    WORKBENCH_DIST_DIR: distributionDirectory(paths),
    WORKBENCH_STORAGE_EXTERNAL: String(paths.external),
    WORKBENCH_STORAGE_ROOT: paths.storageRoot,
    WORKBENCH_STORAGE_PROJECT: paths.projectDirectory,
    ...(paths.languages.includes("java")
      ? { WORKBENCH_MAVEN_REPOSITORY: ownedPath(paths.storageRoot, "downloads/maven") }
      : {}),
    ...(paths.languages.includes("php")
      ? { WORKBENCH_COMPOSER_CACHE: ownedPath(paths.storageRoot, "downloads/composer") }
      : {}),
    ...(paths.external
      ? {
          WORKBENCH_DEPENDENCIES_DIR: paths.dependencies,
          ...(paths.languages.some((language) => language === "typescript" || language === "javascript")
            ? {
                PNPM_CONFIG_STORE_DIR: paths.pnpmStore,
                PNPM_CONFIG_VIRTUAL_STORE_DIR: join(paths.dependencies, "pnpm"),
                PNPM_CONFIG_VIRTUAL_STORE_TYPE: "project",
              }
            : {}),
          ...(paths.languages.includes("rust") ? { CARGO_TARGET_DIR: join(paths.directory, "cargo") } : {}),
          ...(paths.languages.includes("python")
            ? {
                UV_PROJECT_ENVIRONMENT: join(paths.dependencies, "venv"),
                PYTHONPYCACHEPREFIX: join(paths.directory, "pycache"),
                MYPY_CACHE_DIR: join(paths.directory, "mypy"),
                RUFF_CACHE_DIR: join(paths.directory, "ruff"),
                PYTEST_ADDOPTS:
                  `${source.PYTEST_ADDOPTS ?? ""} -o cache_dir=${JSON.stringify(join(paths.directory, "pytest"))}`.trim(),
                COVERAGE_FILE: join(paths.directory, ".coverage"),
                UV_BUILD_OUT_DIR: join(paths.directory, "python-dist"),
              }
            : {}),
        }
      : {}),
  };
}

/** Refuse overlapping Workbench builds/cleanup; never guess that an unfamiliar lock is stale. */
export function buildLockDirectory(identity: BuildIdentity): string {
  const locks = join(userDirectory("cache"), "locks");
  return ownedPath(ownedPath(locks, digest(identity.checkout)), digest(JSON.stringify(ownerScope(identity))));
}

export function withBuildLock<T>(
  paths: Pick<BuildPaths, "identity">,
  action: (owner: ProcessLock) => T,
  admissionHeld = false,
): T {
  // One lock spans local/external selections and storage-root changes without requiring the external disk in local mode.
  const lock = buildLockDirectory(paths.identity);
  const acquire = () => acquireProcessLock(lock);
  const owner = admissionHeld ? acquire() : withToolCacheAdmission(acquire);
  if (!owner) throw new Error(`${lock}: another build or cleanup may be active; inspect before removing a stale lock`);
  let result: T;
  try {
    result = action(owner);
  } catch (failure) {
    releaseAfterFailure(
      () => {
        owner.release();
      },
      failure,
      "Build and ownership release both failed",
    );
  }
  if (result instanceof Promise)
    return result.then(
      (value: unknown) => {
        owner.release();
        return value;
      },
      (failure: unknown) =>
        releaseAfterFailure(
          () => {
            owner.release();
          },
          failure,
          "Build and ownership release both failed",
        ),
    ) as T;
  owner.release();
  return result;
}

/** Only this root's marked products are disposable; dependency downloads and tool installations are separate. */
export function cleanBuilds(paths: BuildPaths, dependencies = false): void {
  if (!existsSync(paths.roots) && !existsSync(paths.dependencyRoots)) return;
  withBuildLock(paths, () => {
    const directories: string[] = [];
    const registrations = new Set<string>();
    for (const kind of dependencies ? (["builds", "dependencies"] as const) : (["builds"] as const)) {
      const root = kind === "builds" ? paths.roots : paths.dependencyRoots;
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.name === ".workbench-lock" || entry.name.endsWith(".lock")) continue;
        const directory = ownedPath(root, entry.name);
        if (!entry.isDirectory()) throw new Error(`${directory}: unexpected file in build storage`);
        const owner = readBuildGeneration(paths.storageRoot, directory, kind);
        if (buildOwnerKey(owner) === buildOwnerKey(paths.identity)) {
          directories.push(directory);
          if (owner.environment === "guix" || owner.environment === "nix")
            registrations.add(join(paths.dependencyRoots, `${owner.environment}-${owner.fingerprint}`));
        }
      }
    }
    withCacheLocksSync([...registrations].sort(), () => {
      if (dependencies) for (const directory of directories) guixProfileRegistrations(directory);
      for (const directory of directories) {
        if (dependencies) releaseGuixProfiles(directory);
        rmSync(directory, { recursive: true });
      }
    });
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
