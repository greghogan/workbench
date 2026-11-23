import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, posix, relative } from "node:path";
import { policyCompatibility } from "../collections/policy-compatibility.js";
import { settleCleanup, UserFacingError } from "../diagnostics/diagnostic-errors.mjs";
import {
  diagnostic,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  writeDiagnosticText,
} from "../diagnostics/diagnostics.mjs";
import { materializeDistribution } from "../distribution/runtime-distribution.js";
import { git } from "../distribution/update-git.js";
import { mapWork } from "../execution/checks/work-admission.mjs";
import { snapshotCIProject } from "../execution/ci/ci-workspace.js";
import { CILifecycle, executeCI, withCIProcessOwner } from "../execution/ci/support/ci-lifecycle.mjs";
import { builderExecutionResources, executionEnvironment } from "../execution/environments/execution-resources.js";
import { currentExecutionEnvironment } from "../execution/environments/execution-context.js";
import {
  builderDirectory,
  managedProfileOwner,
  guixChannelFile,
  managedStoreDirectory,
  managedStorePin,
  mountFields,
  type ManagedStorePin,
  PreparationStore,
} from "../execution/environments/managed/managed-contract.mjs";
import { readConfig, readLanguageRoots } from "../projects/project-configuration.js";
import { distributionRoot } from "../projects/project-context.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { readBoundedFile } from "../runtime/file-reads.js";
import { readText } from "../runtime/files.js";
import { required } from "../runtime/invariants.js";
import { processCancellation, runOwnedChild } from "../runtime/owned-child.mjs";
import { processFailure } from "../runtime/process-outcome.mjs";
import { gitBytes } from "../git/git-snapshot.js";
import { ownedPath } from "../runtime/paths.js";
import { preparedImageRecord, storePinForImage } from "./local-images.js";
import { withCacheActivity, withCacheLock } from "../storage/cache-lock.js";
import { completeManagedPreparation } from "../storage/managed-preparation.js";
import { acquireProcessLock, type ProcessLock } from "../storage/process-lock.js";
import { userDirectory } from "../storage/storage.js";
import { acquireRegistryImage } from "../toolchains/acquisition/image-acquisition.mts";
import { dependencyInputHash } from "../toolchains/dependency-identity.mjs";
import { nativeEnvironment } from "../toolchains/native/native-tools.js";
import { currentBuildkitCacheKeys, withProjectBuilder } from "./buildkit.js";
import { imageReference } from "./container-references.js";
import { containerStartup, validateContainerOwnership } from "./container-startup.js";
import { containerCLI } from "./container-tools.js";
import {
  ImageExecution,
  imageDigest as imageId,
  ImagePreparation,
  imageProfileLock,
  imageProfileMaintenanceLock,
  imageProfileReceipt,
  parsePreparedTag,
  preparedImageTag,
  RegistryAvailability,
  type OfflineImageState,
} from "./image-contract.js";
import { profileRequiresBinfmt } from "./image-emulation.js";
import { finalizeImage } from "./image-finalization.js";
import { autoPrunePreparedImages } from "./image-retention.js";
import { selectPreparationStore } from "./preparation-store.js";
import { registryImageDigest } from "./registry-images.js";
import {
  frozenDistributionTree,
  sameVerification,
  verificationProof,
  type VerificationProof,
} from "./offline-verification.js";
import {
  inspectPreparedImages,
  preparedImageSource,
  recordPreparedImage,
  registryImageStatus,
} from "./prepared-images.js";
import type { DevelopmentProfile } from "./profile-schema.js";
import { acquireManagedArtifactInputs } from "./managed-artifact-inputs.js";
import {
  restoredProfileDirectory,
  type readManagedProfileArchive,
} from "../execution/environments/managed/profile-transfer.mjs";

interface StoreVerification {
  file: string;
  expected: Parameters<typeof readManagedProfileArchive>[1];
}

interface ContainerDefinition {
  image?: string;
  build?: unknown;
  features?: Record<string, unknown>;
  mounts?: unknown[];
  runArgs?: string[];
  containerUser?: string;
  containerEnv?: Record<string, string>;
  remoteUser?: string;
  remoteEnv?: Record<string, string>;
  workspaceFolder?: string;
  overrideCommand?: boolean;
  dockerComposeFile?: unknown;
  [key: string]: unknown;
}
interface Receipt {
  version: number;
  profile: string;
  inputs: string;
  image: string;
  platform: string;
  verified: string;
  verificationHost?: string;
  verificationMethod?: ImageExecution;
  published?: string;
  verification?: VerificationProof;
  builderCaches?: string[] | undefined;
  storePin?: ManagedStorePin;
}

export function withOfflineProfileLock<T>(
  root: string,
  name: string,
  architecture: string,
  action: () => Promise<T>,
): Promise<T> {
  offlineProfile(root, name);
  const path = imageProfileLock(root, name, architecture),
    activity = `${path}.activity`;
  let owner: ProcessLock | undefined;
  return withCacheActivity(activity, () =>
    withCacheLock(
      path,
      async () => {
        owner = acquireProcessLock(activity, true);
        if (!owner) throw new Error(`Preparation activity is active or uncertain: ${activity}`);
        // Maintenance takes architecture operation locks first; it never races active preparation or publication.
        await withCacheLock(imageProfileMaintenanceLock(root, name), () => Promise.resolve());
        return await withCIProcessOwner(owner, action);
      },
      undefined,
      undefined,
      {
        beforeRelease: () => {
          if (!owner) throw new Error(`Preparation ownership could not be established; preserving ${path}.lock`);
          owner.release();
        },
      },
    ),
  );
}

function workingBuilderCaches(root: string): string[] | undefined {
  try {
    return currentBuildkitCacheKeys(root);
  } catch (error) {
    try {
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.Command,
        DiagnosticOutcome.Unavailable,
        { command: "record builder cache requirements" },
        error,
      );
    } catch {
      /* Optional retention evidence preserves caches on failure. */
    }
    return undefined;
  }
}

function maintainPreparedImages(root: string): Promise<void> {
  return autoPrunePreparedImages(
    root,
    (architecture = process.arch) =>
      new Map(
        (readConfig(root).development?.profiles ?? [])
          .filter((profile) => profile.offline)
          .map((profile) => [profile.name, offlineInputs(root, profile, architecture)]),
      ),
  );
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const lifecycleCommands = [
  "initializeCommand",
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
  "postAttachCommand",
];

export function offlineProfile(
  root: string,
  name: string,
): DevelopmentProfile & { offline: NonNullable<DevelopmentProfile["offline"]> & { verify: string[] } } {
  const profile = readConfig(root).development?.profiles?.find((entry) => entry.name === name);
  if (!profile?.offline) throw new Error(`'${name}' is not an offline development profile`);
  const roots = readLanguageRoots(root).map((entry) => entry.path);
  if (profile.offline.paths?.some((path) => !roots.includes(path)))
    throw new Error("offline.paths must name registered language roots");
  return {
    ...profile,
    offline: {
      ...profile.offline,
      verify: profile.offline.verify ?? [
        "node",
        ...(profile.offline.kind === "toolchain"
          ? ["{workbench}/bin/workbench.mjs", "image-tool-probe", profile.builder]
          : ["{workbench}/scripts/prepare-development.mjs", profile.builder, "--verify"]),
        ...(profile.builder === "native" && profile.toolchain ? ["--toolchain", profile.toolchain] : []),
        ...(profile.offline.paths ?? []).flatMap((path) => ["--path", path]),
      ],
    },
  };
}

export function offlineInputManifest(root: string, profile: DevelopmentProfile, architecture: string = process.arch) {
  if (!profile.offline || !profile.container_config) throw new Error("offline profile is incomplete");
  const files: [string, string, number][] = [];
  const gitAware = existsSync(join(root, ".git"));
  const visit = (name: string, optional = false) => {
    const path = ownedPath(root, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) {
      if (optional) return;
      throw new Error(`Offline input does not exist: ${name}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`offline input must not be a symbolic link: ${name}`);
    if (stat.isDirectory()) {
      const children = gitAware
        ? [
            ...new Set(
              git(path, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean),
            ),
          ].sort()
        : readdirSync(path).sort();
      for (const child of children) visit(`${name}/${child}`, gitAware);
    } else if (stat.isFile() && stat.size <= 64 * 1024 * 1024)
      // Git preserves the executable flag, not owner/group permission differences.
      files.push([
        name,
        dependencyInputHash(name, readBoundedFile(path, 64 * 1024 * 1024, "offline input")),
        stat.mode & 0o100 ? 0o111 : 0,
      ]);
    else throw new Error(`unsupported offline input: ${name}`);
  };
  // The standard Dev Container builder consumes its build configuration. Custom preparation owns explicit image inputs;
  // its workspace configuration and preparation command only coordinate use of the resulting image.
  const inputs = profile.offline.prepare
    ? profile.offline.inputs
    : [profile.container_config, ...profile.offline.inputs];
  for (const name of [...new Set(inputs)].sort()) visit(name);
  const roots = readLanguageRoots(root).filter(
    (entry) => !profile.offline?.paths || profile.offline.paths.includes(entry.path),
  );
  if (profile.builder === "guix")
    for (const entry of roots)
      visit(relative(root, guixChannelFile(root, join(root, entry.path))).replaceAll("\\", "/"), true);
  const config = readConfig(root);
  return {
    // Execution, publication, and verification settings do not change the dependency image.
    profile: {
      builder: profile.builder,
      kind: profile.offline.kind,
      toolchain: profile.toolchain,
      paths: profile.offline.paths ?? [...new Set(roots.map((entry) => entry.path))],
    },
    native:
      profile.builder === "native"
        ? {
            roots: roots.map(({ path, language, compiler }) => ({ path, language, compiler })),
            toolchains: config.toolchains?.profiles,
            ciToolchains: config.ci?.toolchains,
          }
        : undefined,
    platform: `linux-${architecture}`,
    files: [...new Map(files.map((entry) => [entry[0], entry])).values()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    ),
  };
}

export function offlineInputs(root: string, profile: DevelopmentProfile, architecture: string = process.arch): string {
  if (!["x64", "arm64"].includes(architecture)) throw new Error("Image architecture must be x64 or arm64");
  return hash(JSON.stringify(offlineInputManifest(root, profile, architecture)));
}

export function offlineReceiptPath(root: string, name: string, architecture: string = process.arch): string {
  return imageProfileReceipt(root, name, architecture);
}

export function preparedOfflineProfile(
  root: string,
  profile: DevelopmentProfile,
  architecture: string = process.arch,
): Receipt {
  const path = offlineReceiptPath(root, profile.name, architecture);
  if (!existsSync(path))
    throw new Error(
      `Offline profile '${profile.name}' is not prepared; run workbench development prepare ${profile.name}`,
    );
  const receipt = JSON.parse(readText(path)) as Receipt;
  if (
    receipt.version !== 1 ||
    receipt.profile !== profile.name ||
    receipt.inputs !== offlineInputs(root, profile, architecture) ||
    !imageId.test(receipt.image) ||
    receipt.platform !== `linux-${architecture}` ||
    (receipt.verificationHost !== undefined && receipt.verificationHost !== `linux-${process.arch}`) ||
    (receipt.verificationMethod !== undefined &&
      receipt.verificationMethod !== executionEvidence(architecture).verificationMethod) ||
    (architecture !== process.arch && (!receipt.verificationHost || !receipt.verificationMethod)) ||
    !receipt.verified
  )
    throw new Error(`Offline profile '${profile.name}' is stale or invalid; prepare it again`);
  return receipt;
}

export function validateOfflineDefinition(config: ContainerDefinition): void {
  if (config.dockerComposeFile || config.mounts?.length || lifecycleCommands.some((key) => config[key]))
    throw new Error(
      "Offline profiles require one image, no additional mounts, and preparation in the image build rather than lifecycle commands",
    );
  if (!config.workspaceFolder?.startsWith("/") || /[,\s]/.test(config.workspaceFolder))
    throw new Error("Offline profiles require a literal absolute workspaceFolder");
  if (
    config.runArgs?.some(
      (arg) => !["--security-opt=seccomp=unconfined", "--security-opt=systempaths=unconfined"].includes(arg),
    )
  )
    throw new Error("Offline profiles support only the declared namespace security options in runArgs");
  if (
    [config.containerEnv, config.remoteEnv].some(
      (env) =>
        env &&
        Object.entries(env).some(
          ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("${"),
        ),
    )
  )
    throw new Error("Offline containerEnv and remoteEnv must contain literal environment values");
}

function devcontainerCLI(root: string): { cli: string; env: NodeJS.ProcessEnv } {
  const distribution = distributionRoot(root);
  return {
    cli: containerCLI(distribution),
    env: { ...nativeEnvironment(distribution, distribution), ...executionEnvironment(root) },
  };
}

async function definition(
  root: string,
  profile: DevelopmentProfile,
  workspace = root,
  container?: string,
): Promise<ContainerDefinition> {
  const cli = containerCLI(distributionRoot(root));
  const result = JSON.parse(
    await executeCI(
      process.execPath,
      [
        cli,
        "read-configuration",
        "--workspace-folder",
        workspace,
        "--config",
        ownedPath(workspace, profile.container_config ?? ""),
        ...(container ? ["--container-id", container, "--include-merged-configuration"] : []),
      ],
      { env: { ...process.env, ...executionEnvironment(root) }, capture: true },
    ),
  ) as { configuration: ContainerDefinition; mergedConfiguration?: ContainerDefinition };
  validateContainerOwnership(result, profile.builder);
  validateOfflineDefinition(result.configuration);
  validateOfflineDefinition(result.mergedConfiguration ?? result.configuration);
  return result.configuration;
}

async function assertNativeDockerHost(): Promise<void> {
  const hostArchitecture = (
    await executeCI("docker", ["info", "--format", "{{.Architecture}}"], { capture: true })
  ).trim();
  if (!(process.arch === "arm64" ? ["arm64", "aarch64"] : ["amd64", "x86_64"]).includes(hostArchitecture))
    throw new Error("Image execution requires a Docker host matching the CLI host architecture");
}

function executionEvidence(architecture: string) {
  return {
    verificationHost: `linux-${process.arch}`,
    verificationMethod: architecture === process.arch ? ImageExecution.Native : ImageExecution.Binfmt,
  };
}

async function runImage(
  root: string,
  profile: ReturnType<typeof offlineProfile>,
  config: ContainerDefinition,
  image: string,
  source: string,
  options: {
    architecture?: string;
    command?: string[];
    network?: "host" | "none";
    env?: Record<string, string>;
    reports?: string;
    distributionMount?: string;
    managedInputs?: { root: string; directory: string }[];
    nativeDependencyMounts?: { directory: string; guest: string }[];
    stderr?: boolean;
    storeArchive?: StoreVerification;
    session?: { user: string; gitDirectories: string[]; signal: AbortSignal };
  } = {},
): Promise<number> {
  await assertNativeDockerHost();
  const architecture = options.architecture ?? process.arch;
  if (architecture !== process.arch && profileRequiresBinfmt(architecture))
    throw new Error("Foreign image verification requires enabled binfmt_misc with a persistent F-flag emulator");
  const platform = JSON.parse(
    await executeCI("docker", ["image", "inspect", "--format", "{{json .}}", image], { capture: true }),
  ) as {
    Os: string;
    Architecture: string;
    Config: { Volumes?: Record<string, unknown>; Labels?: Record<string, string> };
  };
  const store = options.storeArchive;
  const session = options.session;
  if (
    platform.Os !== "linux" ||
    platform.Architecture !== (architecture === "x64" ? "amd64" : "arm64") ||
    Object.keys(platform.Config.Volumes ?? {}).length ||
    (!store &&
      (platform.Config.Labels?.["org.workbench.inputs"] !== offlineInputs(root, profile, architecture) ||
        platform.Config.Labels["org.workbench.builder"] !== profile.builder))
  )
    throw new Error(
      "Offline image must match the selected architecture, declared inputs and builder, without implicit volumes",
    );
  const workspace = config.workspaceFolder ?? "/workbench";
  if (source.includes(",")) throw new Error("Docker mount paths cannot contain commas");
  const container = `workbench-offline-${randomUUID()}`;
  const inside = relative(root, distributionRoot(root));
  const distributionPath =
    isAbsolute(inside) || inside === ".." || inside.startsWith("../") ? ".git/workbench/runtime" : inside;
  const guestDistribution = options.distributionMount
    ? "/opt/workbench-runtime"
    : posix.join(workspace, distributionPath.replaceAll("\\", "/"));
  if (options.distributionMount?.includes(",")) throw new Error("Docker runtime mount paths cannot contain commas");
  const command = (options.command ?? profile.offline.verify).map((part) =>
    part.replaceAll("{workbench}", guestDistribution),
  );
  const docker = (args: string[], settings?: Parameters<typeof executeCI>[2]) =>
    executeCI(
      "docker",
      args,
      session ? { ...settings, capture: true } : options.stderr ? { ...settings, stderr: true } : settings,
    );
  let created = false;
  const owner = statSync(source);
  const reportOwner = options.reports ? statSync(options.reports) : undefined;
  const nativeDependencies = options.nativeDependencyMounts ?? [];
  const cacheOwners = nativeDependencies.map(({ directory, guest }) => {
    const { uid, gid } = statSync(directory);
    return { guest, uid, gid };
  });
  let ownershipChanged = false;
  const lifecycle = new CILifecycle();
  const dependencies = (options.managedInputs ?? []).map(({ root, directory }, index) => ({
    root,
    directory,
    guest: `/opt/workbench-ci-inputs/${String(index)}`,
  }));
  const archivePath = "/tmp/workbench-store-archive";
  const start =
    store?.expected.builder === "guix"
      ? "exec guix-daemon --no-substitutes --disable-chroot --build-users-group=guixbuild"
      : "exec nix-daemon --option substitute false --option max-jobs 0";
  try {
    await lifecycle.checkpoint();
    await docker([
      "create",
      ...(architecture === process.arch ? [] : ["--platform", `linux/${architecture === "x64" ? "amd64" : "arm64"}`]),
      "--name",
      container,
      `--network=${store ? "none" : (options.network ?? "none")}`,
      ...(config.runArgs ?? []),
      ...(config.containerUser ? ["--user", config.containerUser] : []),
      ...Object.entries(config.containerEnv ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--mount",
      mountFields("type=bind", `src=${source}`, `dst=${workspace}`),
      ...(session?.gitDirectories ?? []).flatMap((directory) => [
        "--mount",
        mountFields("type=bind", `src=${directory}`, `dst=${directory}`),
      ]),
      ...(store ? ["--mount", mountFields("type=bind", `src=${store.file}`, `dst=${archivePath}`, "readonly")] : []),
      ...(options.distributionMount
        ? [
            "--mount",
            mountFields("type=bind", `src=${options.distributionMount}`, `dst=${guestDistribution}`, "readonly"),
          ]
        : []),
      ...(options.reports ? ["--mount", mountFields("type=bind", `src=${options.reports}`, "dst=/reports")] : []),
      ...dependencies.flatMap(({ directory, guest }) => [
        "--mount",
        mountFields("type=bind", `src=${directory}`, `dst=${guest}`, "readonly"),
      ]),
      ...nativeDependencies.flatMap(({ directory, guest }) => [
        "--mount",
        mountFields("type=bind", `src=${directory}`, `dst=${guest}`),
      ]),
      ...(config.overrideCommand === false ? [] : ["--entrypoint", "/bin/sh"]),
      image,
      ...(config.overrideCommand === false ? [] : ["-c", store ? start : "while :; do sleep 3600; done"]),
    ]);
    created = true;
    await lifecycle.checkpoint();
    // Resolve inherited metadata from the selected image, without fetching its Dockerfile base.
    if (!store) await definition(root, profile, source, container);
    await lifecycle.checkpoint();
    await docker(["start", container]);
    const machine = (await executeCI("docker", ["exec", container, "uname", "-m"], { capture: true })).trim();
    const machines = architecture === "arm64" ? ["arm64", "aarch64"] : ["amd64", "x86_64"];
    if (!machines.includes(machine))
      throw new Error(`Container execution reports ${JSON.stringify(machine)}; expected linux-${architecture}`);
    if (store)
      await docker([
        "exec",
        "--user",
        "0",
        container,
        "node",
        posix.join(guestDistribution, "scripts/restore-store-archive.mjs"),
        archivePath,
        JSON.stringify(store.expected),
        ...(session ? [session.user] : []),
      ]);
    if (config.remoteUser) {
      await docker([
        "exec",
        "--user",
        "0",
        container,
        "chown",
        "-R",
        config.remoteUser,
        workspace,
        ...(options.reports ? ["/reports"] : []),
        ...nativeDependencies.map(({ guest }) => guest),
      ]);
      ownershipChanged = true;
    }
    const environment = {
      ...config.remoteEnv,
      ...executionEnvironment(root),
      WORKBENCH_DEVCONTAINER: "1",
      WORKBENCH_PREPARED: "1",
      ...((options.network ?? "none") === "none" ? { WORKBENCH_OFFLINE: "1" } : {}),
      WORKBENCH_PROJECT_ROOT: workspace,
      WORKBENCH_DISTRIBUTION_ROOT: guestDistribution,
      ...(process.env.CI ? { CI: process.env.CI } : {}),
      ...(!store && process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
      ...(dependencies.length
        ? {
            WORKBENCH_CI_MANAGED_INPUTS: JSON.stringify(
              Object.fromEntries(dependencies.map(({ root, guest }) => [root, guest])),
            ),
          }
        : {}),
      ...options.env,
    };
    await lifecycle.checkpoint();
    const user = session?.user ?? config.remoteUser;
    const execution = [
      ...(user ? ["--user", user] : []),
      "--workdir",
      workspace,
      // Inherit the GitHub token from Docker's process environment to keep its value out of argv.
      ...Object.entries(environment).flatMap(([key, value]) => ["--env", key === "GH_TOKEN" ? key : `${key}=${value}`]),
      container,
    ];
    if (session) {
      await docker([
        "exec",
        ...execution,
        "node",
        posix.join(guestDistribution, "bin/workbench.mjs"),
        "project",
        "add",
        workspace,
      ]);
      const terminal = process.stdin.isTTY && process.stdout.isTTY ? ["--tty"] : [];
      const result = await runOwnedChild("docker", ["exec", "--interactive", ...terminal, ...execution, ...command], {
        cwd: root,
        env: process.env,
        signal: session.signal,
        inheritInput: true,
        inheritOutput: true,
      });
      if (result.error || result.signal !== null || result.status === null)
        throw processFailure("Archive shell", result) ?? new Error("Archive shell returned no exit status");
      return result.status;
    }
    await docker(["exec", ...execution, ...command], {
      env: { ...process.env, ...(environment.GH_TOKEN === undefined ? {} : { GH_TOKEN: environment.GH_TOKEN }) },
    });
    return 0;
  } finally {
    try {
      if (ownershipChanged) {
        await docker([
          "exec",
          "--user",
          "0",
          container,
          "chown",
          "-R",
          `${String(owner.uid)}:${String(owner.gid)}`,
          workspace,
        ]);
        if (reportOwner)
          await docker([
            "exec",
            "--user",
            "0",
            container,
            "chown",
            "-R",
            `${String(reportOwner.uid)}:${String(reportOwner.gid)}`,
            "/reports",
          ]);
        for (const owner of cacheOwners)
          await docker([
            "exec",
            "--user",
            "0",
            container,
            "chown",
            "-R",
            `${String(owner.uid)}:${String(owner.gid)}`,
            owner.guest,
          ]);
      }
    } finally {
      try {
        if (created) await docker(["rm", "--force", container]);
      } finally {
        lifecycle.close();
      }
    }
  }
}

function runStoreArchive(
  root: string,
  profile: ReturnType<typeof offlineProfile>,
  bootstrapImage: string,
  source: string,
  storeArchive: StoreVerification,
  shell?: { path: string; command: string[]; signal: AbortSignal },
) {
  const guestHome = "/tmp/workbench-home";
  const cache = `${guestHome}/cache`;
  const env = {
    HOME: guestHome,
    WORKBENCH_ENVIRONMENTS: restoredProfileDirectory,
    WORKBENCH_CACHE_HOME: cache,
    WORKBENCH_DATA_HOME: `${guestHome}/data`,
    WORKBENCH_STATE_HOME: `${guestHome}/state`,
    WORKBENCH_STORAGE_ROOT: cache,
    WORKBENCH_STORAGE_EXTERNAL: "true",
    XDG_CACHE_HOME: `${cache}/xdg`,
    XDG_CONFIG_HOME: `${guestHome}/config`,
    XDG_STATE_HOME: `${guestHome}/state`,
    CARGO_HOME: `${cache}/cargo`,
    RUSTUP_HOME: `${cache}/rustup`,
    GOCACHE: `${cache}/go-build`,
    GOMODCACHE: `${cache}/go-mod`,
    npm_config_cache: `${cache}/npm`,
    PIP_CACHE_DIR: `${cache}/pip`,
    UV_CACHE_DIR: `${cache}/uv`,
    UV_PYTHON_INSTALL_DIR: `${cache}/uv-python`,
    WORKBENCH_MAVEN_REPOSITORY: `${cache}/maven`,
    WORKBENCH_COMPOSER_CACHE: `${cache}/composer`,
    ...(storeArchive.expected.builder === "nix" ? { NIX_REMOTE: "daemon" } : {}),
  };
  const shared = {
    architecture: storeArchive.expected.architecture,
    env,
    storeArchive,
    stderr: true,
  };
  if (!shell)
    return runImage(
      root,
      profile,
      { workspaceFolder: "/workspace", remoteUser: "1000:1000" },
      bootstrapImage,
      source,
      shared,
    );
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (!uid || gid === undefined) throw new Error("Open a managed archive shell as a non-root Linux user");
  const contains = (directory: string, path: string) => {
    const name = relative(directory, path);
    return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith("../"));
  };
  const metadata = [
    ...new Set(
      ["--git-common-dir", "--git-dir"].map((name) =>
        gitBytes(root, ["rev-parse", "--path-format=absolute", name])
          .toString()
          .replace(/\r?\n$/, ""),
      ),
    ),
  ].filter((directory) => !contains(root, directory));
  const gitDirectories = metadata.filter(
    (directory) => !metadata.some((parent) => directory !== parent && contains(parent, directory)),
  );
  return runImage(root, profile, { workspaceFolder: root }, bootstrapImage, source, {
    ...shared,
    env: {
      ...env,
      ...(process.env.TERM ? { TERM: process.env.TERM } : {}),
      ...(process.env.COLORTERM ? { COLORTERM: process.env.COLORTERM } : {}),
    },
    distributionMount: distributionRoot(root),
    command: [
      "node",
      "{workbench}/bin/workbench.mjs",
      "shell",
      "--environment",
      profile.builder,
      "--path",
      shell.path,
      "--",
      ...shell.command,
    ],
    session: { user: `${String(uid)}:${String(gid)}`, gitDirectories, signal: shell.signal },
  });
}

/** Check the archive against a disposable store, fresh source and private build caches. */
export async function verifyStoreArchive(
  root: string,
  profile: ReturnType<typeof offlineProfile>,
  bootstrapImage: string,
  source: string,
  storeArchive: StoreVerification,
) {
  await runStoreArchive(root, profile, bootstrapImage, source, storeArchive);
}

/** Use the imported store on the live checkout without changing its ownership. */
export function openStoreArchiveShell(
  root: string,
  profile: ReturnType<typeof offlineProfile>,
  bootstrapImage: string,
  storeArchive: StoreVerification,
  path: string,
  command: string[],
  signal: AbortSignal,
) {
  return runStoreArchive(root, profile, bootstrapImage, root, storeArchive, { path, command, signal });
}

/** Verification describes this frozen tree and the effective Docker execution environment. */
async function imageVerification(
  root: string,
  profile: ReturnType<typeof offlineProfile>,
  config: ContainerDefinition,
  image: string,
  source: string,
  trees: { path: string; tree: string }[],
  architecture: string = process.arch,
): Promise<VerificationProof | undefined> {
  let daemon: string;
  try {
    daemon = (
      await executeCI(
        "docker",
        ["info", "--format", "{{.ID}} {{.ServerVersion}} {{.KernelVersion}} {{.OSType}} {{.Architecture}}"],
        { capture: true },
      )
    ).trim();
  } catch {
    return undefined;
  }
  if (!daemon) return undefined;
  let policy: string;
  try {
    policy = policyCompatibility(root).digest;
  } catch {
    return undefined;
  }
  const inside = relative(root, distributionRoot(root));
  let runtimeTree: string | undefined;
  if (isAbsolute(inside) || inside === ".." || inside.startsWith("../")) {
    try {
      runtimeTree = await frozenDistributionTree(materializeDistribution(root, source, ""));
    } catch {
      return undefined;
    }
  }
  const baselines = await Promise.all(
    trees.map(async (tree) => ({
      path: tree.path,
      commit: (await executeCI("git", ["rev-parse", "HEAD"], { cwd: join(source, tree.path), capture: true })).trim(),
    })),
  );
  // Bind-source references retain their meaning across fresh temporary checkouts.
  // Use a tagged value so a literal environment string cannot collide with the reference.
  const environmentIdentity = (environment?: Record<string, string>) =>
    environment &&
    Object.fromEntries(
      Object.entries(environment).map(([key, value]) => [key, value === source ? { workspaceSource: true } : value]),
    );
  return verificationProof({
    image,
    trees,
    verifier: required(profile.offline, "missing offline profile").verify,
    environment: {
      execution: { ...executionEvidence(architecture), target: `linux-${architecture}` },
      ...executionEnvironment(root),
      CI: process.env.CI,
      policy,
      node: process.versions.node,
      GH_TOKEN: process.env.GH_TOKEN,
      kernel: release(),
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      distribution: inside,
      runtimeTree,
      daemon,
      baselines,
    },
    container: {
      workspace: config.workspaceFolder,
      user: config.containerUser,
      remoteUser: config.remoteUser,
      env: environmentIdentity(config.containerEnv),
      remoteEnv: environmentIdentity(config.remoteEnv),
      runArgs: config.runArgs,
      overrideCommand: config.overrideCommand,
    },
  });
}

async function executeManagedPreparation(
  root: string,
  source: string,
  profile: ReturnType<typeof offlineProfile>,
  architecture: string,
  inputs: string,
  options: { destination: string; archive?: boolean; preparationResult?: string; refreshBootstrap?: boolean },
  env: NodeJS.ProcessEnv,
) {
  const store = await selectPreparationStore(profile.builder, root);
  if (options.refreshBootstrap && store !== PreparationStore.Managed)
    throw new Error("Only managed Guix preparation supports --refresh-bootstrap");
  const distribution = materializeDistribution(root, source, "");
  const [command, ...args] = (profile.offline.prepare ?? []).map((part) =>
    part.replaceAll("{image}", options.destination).replaceAll("{workbench}", distribution),
  );
  if (!command) throw new Error("Managed preparation requires a command");
  const allocation = builderExecutionResources(root);
  const cache = userDirectory("cache");
  const managed = store === PreparationStore.Managed;
  const lock = managed ? managedStoreDirectory(cache, profile.builder) : builderDirectory(cache, root, profile.builder);
  if (managed) ownedPath(cache, `managed-stores/${profile.builder}`);
  await withCacheLock(lock, () =>
    executeCI(command, args, {
      cwd: source,
      stderr: options.archive ?? false,
      env: {
        ...env,
        WORKBENCH_PROJECT_ROOT: source,
        WORKBENCH_DISTRIBUTION_ROOT: distribution,
        WORKBENCH_PREPARATION_OWNER: managedProfileOwner(root, profile.name),
        WORKBENCH_PREPARATION_PROFILE: managed && !options.archive ? profile.name : undefined,
        WORKBENCH_PREPARATION_STORE: store,
        WORKBENCH_REFRESH_GUIX_BOOTSTRAP: options.refreshBootstrap ? "1" : undefined,
        WORKBENCH_PREPARATION_RESULT: managed ? options.preparationResult : undefined,
        WORKBENCH_CONTAINER_CHECKOUT: root,
        WORKBENCH_LOCAL_CONFIG_ROOT: root,
        WORKBENCH_EPHEMERAL_CHECKOUT: "1",
        WORKBENCH_IMAGE_INPUTS: inputs,
        WORKBENCH_IMAGE_ARCHITECTURE: architecture,
        WORKBENCH_ARTIFACT_KIND: profile.offline.kind,
        WORKBENCH_MANAGED_PROFILE_EXPORT: options.archive ? "1" : undefined,
        WORKBENCH_MANAGED_CORES: String(allocation.cores),
        WORKBENCH_MANAGED_JOBS: String(allocation.maxJobs),
        WORKBENCH_IMAGE_ROOTS: profile.offline.paths ? JSON.stringify(profile.offline.paths) : undefined,
      },
    }),
  );
}

/** Export native store data using the same source snapshot, authority, and locks as image preparation. */
export async function prepareStoreArchive(root: string, name: string, architecture: string, destination: string) {
  if (process.platform !== "linux" || architecture !== process.arch)
    throw new Error("Managed archive preparation requires the target Linux host");
  const profile = offlineProfile(root, name);
  if (profile.builder === "native" || !profile.offline.prepare)
    throw new Error(`'${name}' does not declare managed store preparation`);
  return withOfflineProfileLock(root, name, architecture, async () => {
    const inputs = offlineInputs(root, profile, architecture);
    const temporary = mkdtempSync(join(tmpdir(), "workbench-store-export-"));
    const lifecycle = new CILifecycle();
    try {
      const source = join(temporary, "source");
      await snapshotCIProject(root, source, lifecycle);
      await lifecycle.checkpoint();
      if (offlineInputs(source, profile, architecture) !== inputs)
        throw new Error("Profile inputs changed during archive preparation");
      const env = currentExecutionEnvironment();
      await executeManagedPreparation(
        root,
        source,
        profile,
        architecture,
        inputs,
        { destination, archive: true },
        {
          ...env,
          PATH: [dirname(process.execPath), env.PATH ?? ""].join(delimiter),
          ...executionEnvironment(root),
        },
      );
      await lifecycle.checkpoint();
      if (offlineInputs(root, offlineProfile(root, name), architecture) !== inputs)
        throw new Error("Profile inputs changed during archive preparation");
    } finally {
      lifecycle.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

/** Acquire a dependency image, then establish or reuse evidence for the frozen source without network or host caches. */
export async function prepareOfflineProfile(
  root: string,
  name: string,
  options: {
    build?: boolean;
    pullOnly?: boolean;
    fresh?: boolean;
    refreshBootstrap?: boolean;
    architecture?: string;
    assembleOnly?: boolean;
    allowHostedBuild?: boolean;
  } = {},
): Promise<void> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Offline preparation requires a Linux x64 or ARM64 host; use WSL 2 on Windows");
  const architecture = options.architecture ?? process.arch;
  if (!["x64", "arm64"].includes(architecture)) throw new Error("Image architecture must be x64 or arm64");
  const profile = offlineProfile(root, name);
  const build = [options.build, options.refreshBootstrap].includes(true);
  if (options.refreshBootstrap && (profile.builder !== "guix" || !profile.offline.prepare))
    throw new Error("Only managed Guix preparation supports --refresh-bootstrap");
  const emulated = architecture !== process.arch;
  if (emulated && profileRequiresBinfmt(architecture))
    throw new Error(
      "Foreign image preparation requires enabled binfmt_misc with a persistent F-flag emulator for the selected architecture",
    );
  await maintainPreparedImages(root);
  const hosted = [process.env.CI, process.env.GITHUB_ACTIONS, process.env.GITLAB_CI].some(
    (value) => value && value !== "false" && value !== "0",
  );
  const pullOnly =
    options.pullOnly === true ||
    (hosted &&
      !emulated &&
      !options.assembleOnly &&
      !options.allowHostedBuild &&
      ["nix", "guix"].includes(profile.builder));
  if (pullOnly && build) throw new Error("Registry-only preparation cannot build locally");
  if (pullOnly && !profile.offline.registry)
    throw new Error(`Registry-only preparation requires offline.registry for '${name}'`);
  const path = offlineReceiptPath(root, name, architecture);
  await withOfflineProfileLock(root, name, architecture, async () => {
    const inputs = offlineInputs(root, profile, architecture);
    let previous: Receipt | undefined;
    try {
      previous = preparedOfflineProfile(root, profile, architecture);
    } catch {
      /* Missing or uncertain evidence requires fresh execution. */
    }
    devcontainerCLI(root);
    const temporary = mkdtempSync(join(tmpdir(), "workbench-offline-"));
    const lifecycle = new CILifecycle();
    const tag = `workbench-offline:prepare-${randomUUID()}`;
    let staging: "absent" | "building" | "built" = "absent";
    let failure: unknown;
    let storePin: ManagedStorePin | undefined;
    try {
      const source = join(temporary, "source");
      await snapshotCIProject(root, source, lifecycle);
      await lifecycle.checkpoint();
      if (offlineInputs(source, profile, architecture) !== inputs)
        throw new Error("Offline inputs changed during preparation; preserving the previous profile");
      const config = await definition(root, profile, source);
      if (options.refreshBootstrap && config.image)
        throw new Error("Only managed Guix preparation supports --refresh-bootstrap");
      const { cli, env } = devcontainerCLI(root);
      const platform = `linux/${architecture === "x64" ? "amd64" : "arm64"}`;
      const reference = imageReferenceForInputs(root, profile, inputs, architecture);
      let acquired = false;
      try {
        if (build || pullOnly) throw new Error("No such image: explicit acquisition requested");
        await executeCI("docker", ["image", "inspect", reference], { capture: true });
        acquired = true;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("No such image")) throw error;
      }
      if (!acquired && !build && profile.offline.registry) {
        try {
          await acquireRegistryImage(reference, { platform, profile: name });
          acquired = true;
        } catch (error) {
          await lifecycle.checkpoint();
          if (pullOnly)
            throw new UserFacingError(
              `Required prepared image ${reference} could not be pulled. ${error instanceof Error ? error.message : "Registry acquisition failed"}`,
              { cause: error },
            );
          writeDiagnosticText(
            `Could not retrieve prepared image ${reference}; building ${name} locally.\n${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (acquired) {
        const labels = JSON.parse(
          await executeCI("docker", ["image", "inspect", "--format", "{{json .Config.Labels}}", reference], {
            capture: true,
          }),
        ) as Record<string, string> | null;
        if (labels?.["org.workbench.inputs"] !== inputs)
          throw new Error("Prepared image input label does not match this configuration");
      } else if (config.image) await acquireRegistryImage(config.image, { platform, quiet: false });
      else if (profile.offline.prepare) {
        const preparationResult = join(temporary, "store-pin.json");
        staging = "building";
        await executeManagedPreparation(
          root,
          source,
          profile,
          architecture,
          inputs,
          { destination: tag, preparationResult, refreshBootstrap: options.refreshBootstrap ?? false },
          env,
        );
        staging = "built";
        if (existsSync(preparationResult)) {
          storePin = managedStorePin(
            JSON.parse(readBoundedFile(preparationResult, 64 * 1024, "managed store preparation").toString("utf8")),
          );
          if (profile.builder !== storePin.builder)
            throw new Error("Image preparation reported a different store manager");
        }
      } else {
        staging = "building";
        await withProjectBuilder(root, (client) =>
          containerStartup(
            "node",
            [
              cli,
              "build",
              "--docker-path",
              client.docker,
              "--platform",
              platform,
              "--workspace-folder",
              source,
              "--config",
              ownedPath(source, profile.container_config ?? ""),
              "--image-name",
              tag,
            ],
            { ...env, ...client.env },
          ),
        );
        staging = "built";
      }
      const candidate = offlineCandidateReference(root, name, inputs, architecture);
      const output = !acquired || options.assembleOnly ? candidate : reference;
      if (!acquired) {
        const sourceURL = preparedImageSource(root);
        await finalizeImage(config.image ?? tag, output, {
          "org.workbench.inputs": inputs,
          "org.workbench.builder": profile.builder,
          "org.workbench.architecture": architecture,
          "org.workbench.preparation-host": `linux-${process.arch}`,
          "org.workbench.preparation-method": emulated ? "binfmt" : "native",
          ...(sourceURL ? { "org.opencontainers.image.source": sourceURL } : {}),
        });
      } else if (output !== reference) {
        await executeCI("docker", ["tag", reference, output]);
      }
      const image = (
        await executeCI("docker", ["image", "inspect", "--format", "{{.Id}}", output], { capture: true })
      ).trim();
      if (!imageId.test(image)) throw new Error("Build did not produce an immutable image ID");
      storePin ??= storePinForImage(root, name, reference, image, inputs);
      if (output === candidate) {
        recordPreparedImage(root, name, output, {
          image,
          inputs,
          platform: `linux-${architecture}`,
          assembled: new Date().toISOString(),
          ...(storePin ? { storePin } : {}),
        });
        if (storePin)
          completeManagedPreparation({
            checkout: root,
            profile: name,
            architecture,
            inputs,
            builder: storePin.builder,
            key: storePin.key,
          });
      }
      if (options.assembleOnly) {
        console.log(
          `Assembled ${name} for linux-${architecture}: ${image}. Offline verification is required before publication.`,
        );
        return;
      }
      await lifecycle.checkpoint();
      const fresh = join(temporary, "verification");
      const trees = await snapshotCIProject(root, fresh, lifecycle);
      if (offlineInputs(fresh, profile, architecture) !== inputs)
        throw new Error("Offline inputs changed during preparation; preserving the previous profile");
      const verificationConfig = await definition(root, profile, fresh);
      const verification = await imageVerification(
        root,
        profile,
        verificationConfig,
        image,
        fresh,
        trees,
        architecture,
      );
      const reuse =
        !hosted &&
        !options.fresh &&
        !options.build &&
        previous?.image === image &&
        sameVerification(previous.verification, verification);
      if (reuse) console.log(`Reused matching offline verification for ${name}.`);
      else await runImage(root, profile, verificationConfig, image, fresh, { architecture });
      if (offlineInputs(root, offlineProfile(root, name), architecture) !== inputs)
        throw new Error("Offline inputs changed during preparation; preserving the previous profile");
      const receipt: Receipt = {
        version: 1,
        profile: name,
        inputs,
        image,
        platform: `linux-${architecture}`,
        verified: reuse && previous ? previous.verified : new Date().toISOString(),
        ...executionEvidence(architecture),
        ...(storePin ? { storePin } : {}),
        builderCaches: reuse && previous?.builderCaches ? previous.builderCaches : workingBuilderCaches(root),
        ...(verification ? { verification } : {}),
        ...(previous?.image === image &&
        typeof previous.published === "string" &&
        /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(previous.published)
          ? { published: previous.published }
          : {}),
      };
      mkdirSync(dirname(path), { recursive: true });
      if (output !== reference) await executeCI("docker", ["tag", image, reference]);
      recordPreparedImage(root, name, reference, receipt);
      writeAtomic(path, JSON.stringify(receipt, null, 2) + "\n");
      if (output === candidate) await executeCI("docker", ["image", "rm", candidate]);
      console.log(
        `Prepared ${name}: ${image}; ${reuse ? "matching offline verification reused" : "fresh offline build passed"}.`,
      );
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await settleCleanup(
        [
          async () => {
            if (
              staging === "built" ||
              (staging === "building" &&
                (
                  await executeCI("docker", ["image", "ls", "--quiet", "--filter", `reference=${tag}`], {
                    capture: true,
                  })
                ).trim())
            )
              await executeCI("docker", ["image", "rm", tag]);
          },
          () => {
            rmSync(temporary, { recursive: true, force: true });
          },
          () => {
            lifecycle.close();
          },
        ],
        failure,
      );
    }
  });
  await maintainPreparedImages(root);
}

export async function verifyOfflineProfile(
  root: string,
  name: string,
  image?: string,
  architecture: string = process.arch,
  transfer?: { inputs: string; load: () => Promise<void> },
): Promise<void> {
  await withOfflineProfileLock(root, name, architecture, async () => {
    if (transfer) {
      if (!image || offlineInputs(root, offlineProfile(root, name), architecture) !== transfer.inputs)
        throw new Error("Prepared image inputs differ from the current profile; transfer a matching image");
      if (architecture !== process.arch && profileRequiresBinfmt(architecture))
        throw new Error("Foreign image verification requires enabled binfmt_misc with a persistent F-flag emulator");
      await assertNativeDockerHost();
      await transfer.load();
    }
    const profile = offlineProfile(root, name);
    const inputs = offlineInputs(root, profile, architecture);
    const candidate = offlineCandidateReference(root, name, inputs, architecture);
    const assembled = preparedImageRecord(root, candidate);
    let imageToVerify = image;
    if (!imageToVerify && assembled?.image) {
      const images = await executeCI(
        "docker",
        ["image", "ls", "--no-trunc", "--quiet", "--filter", `reference=${candidate}`],
        { capture: true },
      );
      if (images.trim() === assembled.image) imageToVerify = assembled.image;
    }
    if (!imageToVerify) {
      const reference = imageReferenceForInputs(root, profile, inputs, architecture);
      try {
        const [id, label] = (
          await executeCI(
            "docker",
            ["image", "inspect", "--format", '{{.Id}} {{index .Config.Labels "org.workbench.inputs"}}', reference],
            { capture: true },
          )
        )
          .trim()
          .split(" ");
        if (!id || !imageId.test(id) || label !== inputs)
          throw new Error("Local image identity does not match this profile's inputs");
        imageToVerify = id;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("No such image")) throw error;
      }
    }
    const receipt = await verifyAcceptedProfile(root, name, imageToVerify, false, architecture, transfer?.inputs);
    if (imageToVerify && assembled?.image === receipt.image) {
      const images = await executeCI(
        "docker",
        ["image", "ls", "--no-trunc", "--quiet", "--filter", `reference=${candidate}`],
        { capture: true },
      );
      if (images.trim() === receipt.image) await executeCI("docker", ["image", "rm", candidate]);
    }
  });
  await maintainPreparedImages(root);
}

async function verifyAcceptedProfile(
  root: string,
  name: string,
  image?: string,
  retry = false,
  architecture: string = process.arch,
  expectedInputs?: string,
): Promise<Receipt> {
  const profile = offlineProfile(root, name);
  if (architecture !== process.arch && profileRequiresBinfmt(architecture))
    throw new Error("Foreign image verification requires enabled binfmt_misc with a persistent F-flag emulator");
  if (image && !imageId.test(image)) throw new Error("Verification requires an immutable sha256 image ID");
  let receipt: Receipt =
    image && !retry
      ? {
          version: 1,
          profile: name,
          inputs: offlineInputs(root, profile, architecture),
          image,
          platform: `linux-${architecture}`,
          verified: "",
        }
      : preparedOfflineProfile(root, profile, architecture);
  if (expectedInputs !== undefined && receipt.inputs !== expectedInputs)
    throw new Error("Prepared image inputs changed during transfer; preserving the previous receipt");
  if (image && !retry) {
    try {
      const previous = preparedOfflineProfile(root, profile, architecture);
      if (previous.image === image) receipt = previous;
    } catch {
      // Explicit qualification can accept a new image; failure still preserves the old receipt.
    }
  }
  const temporary = mkdtempSync(join(tmpdir(), "workbench-offline-verify-"));
  try {
    const source = join(temporary, "source");
    const trees = await snapshotCIProject(root, source);
    if (offlineInputs(source, profile, architecture) !== receipt.inputs)
      throw new Error("Offline inputs changed during verification; prepare the profile again");
    const config = await definition(root, profile, source);
    const current = retry
      ? await imageVerification(root, profile, config, image ?? receipt.image, source, trees, architecture)
      : undefined;
    const age = Date.now() - Date.parse(receipt.verified);
    if (
      retry &&
      image === receipt.image &&
      age >= 0 &&
      age <= 30 * 60 * 1000 &&
      sameVerification(receipt.verification, current)
    ) {
      preparedOfflineProfile(root, offlineProfile(root, name), architecture);
      console.log(`Reused recent matching offline verification for ${name}.`);
      return receipt;
    }
    await runImage(root, profile, config, image ?? receipt.image, source, {
      architecture,
      ...(expectedInputs === undefined ? {} : { stderr: true }),
    });
    if (offlineInputs(root, offlineProfile(root, name), architecture) !== receipt.inputs)
      throw new Error("Profile changed during verification; preserving the previous receipt");
    if ((!image || retry) && preparedOfflineProfile(root, profile, architecture).image !== receipt.image)
      throw new Error("Accepted image changed during verification");
    const verification = await imageVerification(root, profile, config, receipt.image, source, trees, architecture);
    const reference = offlineImageReference(root, name, architecture);
    const pin =
      storePinForImage(root, name, reference, receipt.image, receipt.inputs) ??
      storePinForImage(
        root,
        name,
        offlineCandidateReference(root, name, receipt.inputs, architecture),
        receipt.image,
        receipt.inputs,
      );
    const updated: Receipt = {
      ...receipt,
      verified: new Date().toISOString(),
      ...executionEvidence(architecture),
      builderCaches: receipt.builderCaches ?? workingBuilderCaches(root),
      ...(pin ? { storePin: pin } : {}),
      ...(verification ? { verification } : {}),
    };
    if (!verification) delete updated.verification;
    if (image && !retry) await executeCI("docker", ["tag", receipt.image, reference]);
    recordPreparedImage(root, name, reference, updated);
    writeAtomic(offlineReceiptPath(root, name, architecture), JSON.stringify(updated, null, 2) + "\n");
    return updated;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function pushLocalImage(target: string, image: string): Promise<void> {
  let tagged = false;
  try {
    const existing = (
      await executeCI("docker", ["image", "inspect", "--format", "{{.Id}}", target], { capture: true })
    ).trim();
    if (existing !== image) throw new Error(`Preserving existing local tag ${target} pointing at another image`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("No such image")) throw error;
    await executeCI("docker", ["tag", image, target]);
    tagged = true;
  }
  try {
    await executeCI("docker", ["push", target]);
  } finally {
    if (tagged) await executeCI("docker", ["image", "rm", target]);
  }
}

export async function publishOfflineProfile(
  root: string,
  name: string,
  target: string,
  architecture: string = process.arch,
): Promise<void> {
  if (!imageReference(target)) throw new Error("Publication requires an explicit registry/repository:tag");
  const path = offlineReceiptPath(root, name, architecture);
  await withOfflineProfileLock(root, name, architecture, async () => {
    await assertNativeDockerHost();
    const prepared = preparedOfflineProfile(root, offlineProfile(root, name), architecture);
    const receipt = await verifyAcceptedProfile(root, name, prepared.image, true, architecture);
    const cancellation = processCancellation();
    try {
      const { signal } = cancellation;
      const immutable = parsePreparedTag(target.slice(target.lastIndexOf(":") + 1));
      const existing = immutable ? await registryImageDigest(target, signal) : undefined;
      if (!existing) await pushLocalImage(target, receipt.image);
      const published = existing ?? (await registryImageDigest(target, signal));
      if (!published) throw new Error(`Published tag ${target} is missing from the registry`);
      await acquireRegistryImage(published, {
        ...(architecture === process.arch ? {} : { platform: `linux/${architecture === "x64" ? "amd64" : "arm64"}` }),
        signal,
      });
      if (
        (
          await executeCI("docker", ["image", "inspect", "--format", "{{.Id}}", published], { capture: true })
        ).trim() !== receipt.image
      )
        throw new Error(`Registry tag ${target} points to a different image than the verified local image`);
      if ((await registryImageDigest(target, signal)) !== published)
        throw new Error(`Registry tag ${target} changed during verification`);
      if (preparedOfflineProfile(root, offlineProfile(root, name), architecture).inputs !== receipt.inputs)
        throw new Error("Profile changed during publication");
      recordPreparedImage(root, name, offlineImageReference(root, name, architecture), { ...receipt, published });
      writeAtomic(path, JSON.stringify({ ...receipt, published }, null, 2) + "\n");
      console.log(`Published and verified ${published}`);
    } finally {
      cancellation.close();
    }
  });
}

/** Architecture and immutable preparation inputs select a project-internal registry tag. */
export function offlineImageReference(root: string, name: string, architecture: string = process.arch): string {
  const profile = offlineProfile(root, name);
  return imageReferenceForInputs(root, profile, offlineInputs(root, profile, architecture), architecture);
}

function imageReferenceForInputs(
  root: string,
  profile: ReturnType<typeof offlineProfile>,
  inputs: string,
  architecture: string = process.arch,
): string {
  return `${profile.offline.registry ?? `workbench-prepared-${hash(root).slice(0, 24)}`}:${preparedImageTag(architecture, inputs)}`;
}

export function offlineCandidateReference(root: string, name: string, inputs: string, architecture: string): string {
  return `workbench-candidate-${hash(JSON.stringify([root, name])).slice(0, 24)}:${preparedImageTag(architecture, inputs)}`;
}

/** Check registry manifests without downloading layers or changing the accepted local profile. */
export async function inspectOfflineImages(
  root: string,
  names: string[] = [],
  architecture: string = process.arch,
): Promise<OfflineImageState[]> {
  const profiles = names.length
    ? [...new Set(names)].map((name) => offlineProfile(root, name))
    : (readConfig(root).development?.profiles ?? []).filter((profile) => profile.offline);
  const selections = profiles.map((profile) => ({
    profile,
    reference: offlineImageReference(root, profile.name, architecture),
  }));
  const local = inspectPreparedImages(
    root,
    new Set(
      selections.flatMap(({ profile, reference }) => [
        reference,
        offlineCandidateReference(root, profile.name, offlineInputs(root, profile, architecture), architecture),
      ]),
    ),
  );
  const cancellation = processCancellation();
  try {
    return await mapWork(selections, { capacity: 4, signal: cancellation.signal }, async ({ profile, reference }) => {
      const registry = profile.offline?.registry
        ? await registryImageStatus(reference, cancellation.signal)
        : { state: RegistryAvailability.NotConfigured };
      const selected = local.entries.find(
        (entry) => entry.reference === reference && entry.blockedReason !== "changed",
      );
      const candidate = local.entries.find(
        (entry) =>
          entry.profile === profile.name &&
          entry.reference.startsWith("workbench-candidate-") &&
          entry.blockedReason !== "changed",
      );
      return {
        profile: profile.name,
        reference,
        local: selected
          ? selected.verified
            ? ImagePreparation.Prepared
            : ImagePreparation.Assembled
          : candidate
            ? ImagePreparation.Assembled
            : ImagePreparation.Missing,
        registry: registry.state,
        ...("detail" in registry && registry.detail ? { detail: registry.detail } : {}),
        ...(local.issues.length ? { local_issues: local.issues } : {}),
        ...(selected?.verificationHost ? { verificationHost: selected.verificationHost } : {}),
        ...(selected?.verificationMethod ? { verificationMethod: selected.verificationMethod } : {}),
      };
    });
  } finally {
    cancellation.close();
  }
}

interface PreparedExecution {
  reports?: string;
  env?: Record<string, string>;
  network?: "host" | "none";
}

interface PreparedSelection {
  path: string;
  toolchain?: string;
}

type PreparedRun = (command: string[], execution?: PreparedExecution) => Promise<void>;

/** Restore selected dependency inputs once for the lifetime of the supplied CI operation. */
export async function withPreparedProfile(
  root: string,
  name: string,
  options: { image?: string; selections?: PreparedSelection[] },
  action: (run: PreparedRun) => Promise<void>,
): Promise<void> {
  const profile = offlineProfile(root, name);
  const image = options.image ?? preparedOfflineProfile(root, profile).image;
  const config = await definition(root, profile, root);
  const distribution = distributionRoot(root);
  const inside = relative(root, distribution);
  const available = imageRootsForProfile(root, profile);
  const groups = new Map<string | undefined, Set<string>>();
  for (const { path, toolchain } of options.selections ?? available.map((path): PreparedSelection => ({ path }))) {
    if (!available.includes(path)) throw new Error(`Prepared profile '${name}' does not cover '${path}'`);
    const paths = groups.get(toolchain) ?? new Set<string>();
    paths.add(path);
    groups.set(toolchain, paths);
  }
  const managedInputs: { root: string; directory: string }[] = [];
  if (profile.offline.kind === "toolchain" && profile.builder !== "native") {
    const cancellation = processCancellation();
    try {
      const paths = new Set([...groups.values()].flatMap((group) => [...group]));
      const { maxJobs } = builderExecutionResources(root);
      for (const path of paths) {
        const directory = await acquireManagedArtifactInputs(
          ownedPath(root, path),
          `linux-${process.arch}`,
          maxJobs,
          cancellation.signal,
        );
        if (directory) managedInputs.push({ root: path, directory });
      }
    } finally {
      cancellation.close();
    }
  }
  const common = {
    ...(isAbsolute(inside) || inside === ".." || inside.startsWith("../") || inside.startsWith("..\\")
      ? { distributionMount: distribution }
      : {}),
  };
  const execute = (nativeDependencyMounts?: { directory: string; guest: string }[]) => {
    const run: PreparedRun = async (command, execution = {}) => {
      await runImage(root, profile, config, image, root, {
        ...common,
        ...execution,
        command,
        network: execution.network ?? "host",
        ...(managedInputs.length ? { managedInputs } : {}),
        ...(nativeDependencyMounts ? { nativeDependencyMounts } : {}),
      });
    };
    return action(run);
  };
  if (profile.offline.kind !== "toolchain" || profile.builder !== "native") {
    await execute();
    return;
  }
  const inputs = mkdtempSync(join(tmpdir(), "workbench-ci-dependencies-"));
  let failure: unknown;
  try {
    const acquisition = join(inputs, "checkout");
    // Package managers can update lock metadata during acquisition. Check the original source snapshot separately.
    await snapshotCIProject(root, acquisition);
    // Mount only dependency caches. The toolchain layer and all fresh build outputs are kept separate.
    const nativeDependencyMounts = [
      "downloads",
      "uv",
      "go-mod",
      "npm",
      "pip",
      "xdg",
      "ci/cargo/registry",
      "ci/cargo/git",
    ].map((path) => {
      const directory = join(inputs, path);
      mkdirSync(directory, { recursive: true });
      return { directory, guest: `/opt/workbench/cache/${path}` };
    });
    for (const [toolchain, paths] of groups) {
      await runImage(root, profile, config, image, acquisition, {
        ...common,
        nativeDependencyMounts,
        network: "host",
        command: [
          "node",
          "{workbench}/scripts/prepare-development.mjs",
          "native",
          "--acquire-only",
          ...[...paths].flatMap((path) => ["--path", path]),
          ...(toolchain ? ["--toolchain", toolchain] : []),
        ],
      });
    }
    await execute(nativeDependencyMounts);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await settleCleanup(
      [
        () => {
          removeNativeDependencyCache(inputs);
        },
      ],
      failure,
    );
  }
}

function removeNativeDependencyCache(directory: string): void {
  const remove = () => {
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    remove();
  } catch (error) {
    if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    // Package managers such as Go intentionally leave read-only module directories.
    const allowRemoval = (path: string) => {
      const info = lstatSync(path);
      if (!info.isDirectory()) return;
      if ((info.mode & 0o700) !== 0o700) chmodSync(path, info.mode | 0o700);
      for (const entry of readdirSync(path, { withFileTypes: true }))
        if (entry.isDirectory()) allowRemoval(join(path, entry.name));
    };
    allowRemoval(directory);
    remove();
  }
}

function imageRootsForProfile(root: string, profile: ReturnType<typeof offlineProfile>): string[] {
  return profile.offline.paths ?? [...new Set(readLanguageRoots(root).map((entry) => entry.path))];
}
