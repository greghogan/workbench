import { mapWork } from "../scripts/work-admission.mjs";
import { processCancellation } from "../scripts/owned-child.mjs";
import { UserFacingError } from "../scripts/diagnostic-errors.mjs";
import { acquireRegistryImage } from "../scripts/image-acquisition.mts";
import { readBoundedFile } from "./file-reads.js";
import { dependencyInputHash } from "../scripts/dependency-identity.mjs";
import { finalizeImage } from "./image-finalization.js";
import { autoPrunePreparedImages, retainedBuilderInputs } from "./image-retention.js";
import { currentBuilderCacheKeys } from "./builder-cache.js";
import { diagnostic, LogLevel, DiagnosticOperation, DiagnosticOutcome } from "./diagnostics.js";
import {
  verificationProof,
  sameVerification,
  frozenDistributionTree,
  type VerificationProof,
} from "./offline-verification.js";
import { policyCompatibility } from "./policy-compatibility.js";
import { profileRequiresBinfmt } from "./image-emulation.js";
import { release, tmpdir } from "node:os";
import { required } from "./invariants.js";
import { withProjectBuilder } from "./buildkit.js";
import {
  RegistryAvailability,
  ImagePreparation,
  type OfflineImageState,
  imageProfileLock,
  imageProfileMaintenanceLock,
  imageProfileReceipt,
  ImageExecution,
  preparedImageTag,
  imageDigest as imageId,
} from "./image-contract.js";
import { builderDirectory, builderOwner, guixChannelFile } from "../scripts/managed-contract.mjs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, posix, relative, dirname, isAbsolute } from "node:path";
import { distributionRoot } from "./project-context.js";
import { readConfig, readLanguageRoots } from "./project-configuration.js";
import { readText } from "./files.js";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { nativeEnvironment } from "./native-tools.js";
import { containerCLI } from "./container-tools.js";
import { containerStartup, validateContainerOwnership } from "./container-startup.js";
import { executeCI, CILifecycle, withCIProcessOwner } from "../scripts/ci-lifecycle.mjs";
import { snapshotCIProject } from "./ci-workspace.js";
import { materializeDistribution } from "./runtime-distribution.js";
import { ownedPath } from "./paths.js";
import { userDirectory } from "./storage.js";
import { acquireProcessLock, type ProcessLock } from "./process-lock.js";
import { withCacheLock, withCacheActivity } from "./cache-lock.js";
import { executionEnvironment, builderExecutionResources } from "./execution-resources.js";
import { git } from "./update-git.js";
import type { DevelopmentProfile } from "./profile-schema.js";
import { imageReference } from "./container-references.js";
import {
  recordPreparedImage,
  inspectPreparedImages,
  registryImageStatus,
  preparedImageSource,
} from "./prepared-images.js";

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

function workingBuilderCaches(root: string, builder: string, inputs: string): string[] | undefined {
  try {
    return currentBuilderCacheKeys(root, builder, inputs);
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
        "{workbench}/scripts/prepare-development.mjs",
        profile.builder,
        "--verify",
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

async function definition(root: string, profile: DevelopmentProfile, workspace = root): Promise<ContainerDefinition> {
  const { cli, env } = devcontainerCLI(root);
  const result = JSON.parse(
    await executeCI(
      "node",
      [
        cli,
        "read-configuration",
        "--workspace-folder",
        workspace,
        "--config",
        ownedPath(workspace, profile.container_config ?? ""),
        "--include-merged-configuration",
      ],
      { env, capture: true },
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
  } = {},
): Promise<void> {
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
  if (
    platform.Os !== "linux" ||
    platform.Architecture !== (architecture === "x64" ? "amd64" : "arm64") ||
    Object.keys(platform.Config.Volumes ?? {}).length ||
    platform.Config.Labels?.["org.workbench.inputs"] !== offlineInputs(root, profile, architecture) ||
    platform.Config.Labels["org.workbench.builder"] !== profile.builder
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
  let created = false;
  const owner = statSync(source);
  const reportOwner = options.reports ? statSync(options.reports) : undefined;
  let ownershipChanged = false;
  const lifecycle = new CILifecycle();
  try {
    await lifecycle.checkpoint();
    await executeCI("docker", [
      "create",
      ...(architecture === process.arch ? [] : ["--platform", `linux/${architecture === "x64" ? "amd64" : "arm64"}`]),
      "--name",
      container,
      `--network=${options.network ?? "none"}`,
      ...(config.runArgs ?? []),
      ...(config.containerUser ? ["--user", config.containerUser] : []),
      ...Object.entries(config.containerEnv ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--mount",
      `type=bind,src=${source},dst=${workspace}`,
      ...(options.distributionMount
        ? ["--mount", `type=bind,src=${options.distributionMount},dst=${guestDistribution},readonly`]
        : []),
      ...(options.reports ? ["--mount", `type=bind,src=${options.reports},dst=/reports`] : []),
      ...(config.overrideCommand === false ? [] : ["--entrypoint", "/bin/sh"]),
      image,
      ...(config.overrideCommand === false ? [] : ["-c", "while :; do sleep 3600; done"]),
    ]);
    created = true;
    await lifecycle.checkpoint();
    await executeCI("docker", ["start", container]);
    const machine = (await executeCI("docker", ["exec", container, "uname", "-m"], { capture: true })).trim();
    const machines = architecture === "arm64" ? ["arm64", "aarch64"] : ["amd64", "x86_64"];
    if (!machines.includes(machine))
      throw new Error(`Container execution reports ${JSON.stringify(machine)}; expected linux-${architecture}`);
    if (config.remoteUser) {
      await executeCI("docker", [
        "exec",
        "--user",
        "0",
        container,
        "chown",
        "-R",
        config.remoteUser,
        workspace,
        ...(options.reports ? ["/reports"] : []),
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
      ...(process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
      ...options.env,
    };
    await lifecycle.checkpoint();
    await executeCI(
      "docker",
      [
        "exec",
        ...(config.remoteUser ? ["--user", config.remoteUser] : []),
        "--workdir",
        workspace,
        // Inherit the GitHub token from Docker's process environment to keep its value out of argv.
        ...Object.entries(environment).flatMap(([key, value]) => [
          "--env",
          key === "GH_TOKEN" ? key : `${key}=${value}`,
        ]),
        container,
        ...command,
      ],
      { env: { ...process.env, ...(environment.GH_TOKEN === undefined ? {} : { GH_TOKEN: environment.GH_TOKEN }) } },
    );
  } finally {
    try {
      if (ownershipChanged) {
        await executeCI("docker", [
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
          await executeCI("docker", [
            "exec",
            "--user",
            "0",
            container,
            "chown",
            "-R",
            `${String(reportOwner.uid)}:${String(reportOwner.gid)}`,
            "/reports",
          ]);
      }
    } finally {
      try {
        if (created) await executeCI("docker", ["rm", "--force", container]);
      } finally {
        lifecycle.close();
      }
    }
  }
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

/** Acquire a dependency image, then establish or reuse evidence for the frozen source without network or host caches. */
export async function prepareOfflineProfile(
  root: string,
  name: string,
  options: { build?: boolean; pullOnly?: boolean; fresh?: boolean; architecture?: string; assembleOnly?: boolean } = {},
): Promise<void> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Offline preparation requires a Linux x64 or ARM64 host; use WSL 2 on Windows");
  const architecture = options.architecture ?? process.arch;
  if (!["x64", "arm64"].includes(architecture)) throw new Error("Image architecture must be x64 or arm64");
  const profile = offlineProfile(root, name);
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
    (hosted && !emulated && !options.assembleOnly && ["nix", "guix"].includes(profile.builder));
  if (pullOnly && options.build) throw new Error("Registry-only preparation cannot build locally");
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
    let built = false;
    try {
      const source = join(temporary, "source");
      await snapshotCIProject(root, source, lifecycle);
      await lifecycle.checkpoint();
      if (offlineInputs(source, profile, architecture) !== inputs)
        throw new Error("Offline inputs changed during preparation; preserving the previous profile");
      const config = await definition(root, profile, source);
      const { cli, env } = devcontainerCLI(root);
      const platform = `linux/${architecture === "x64" ? "amd64" : "arm64"}`;
      const reference = imageReferenceForInputs(root, profile, inputs, architecture);
      let acquired = false;
      try {
        if (options.build || pullOnly) throw new Error("No such image: explicit acquisition requested");
        await executeCI("docker", ["image", "inspect", reference], { capture: true });
        acquired = true;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("No such image")) throw error;
      }
      if (!acquired && !options.build && profile.offline.registry) {
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
          console.warn(
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
        const snapshotDistribution = materializeDistribution(root, source, "");
        const [command, ...args] = profile.offline.prepare.map((part) =>
          part.replaceAll("{image}", tag).replaceAll("{workbench}", snapshotDistribution),
        );
        if (!command) throw new Error("Image preparation requires a command");
        const allocation = builderExecutionResources(root);
        await withCacheLock(builderDirectory(userDirectory("cache"), root, profile.builder), () =>
          executeCI(command, args, {
            cwd: source,
            env: {
              ...env,
              WORKBENCH_PROJECT_ROOT: source,
              WORKBENCH_DISTRIBUTION_ROOT: snapshotDistribution,
              WORKBENCH_PREPARATION_OWNER: builderOwner(root),
              WORKBENCH_CONTAINER_CHECKOUT: root,
              WORKBENCH_LOCAL_CONFIG_ROOT: root,
              WORKBENCH_EPHEMERAL_CHECKOUT: "1",
              WORKBENCH_IMAGE_INPUTS: inputs,
              WORKBENCH_IMAGE_ARCHITECTURE: architecture,
              WORKBENCH_BUILDER_RETAIN_INPUTS: (() => {
                const retained = retainedBuilderInputs(
                  root,
                  (readConfig(root).development?.profiles ?? [])
                    .filter((entry) => entry.offline && entry.builder === profile.builder)
                    .map((entry) => entry.name),
                );
                return retained === undefined ? undefined : JSON.stringify(retained);
              })(),
              WORKBENCH_MANAGED_CORES: String(allocation.cores),
              WORKBENCH_MANAGED_JOBS: String(allocation.maxJobs),
              WORKBENCH_IMAGE_ROOTS: profile.offline.paths ? JSON.stringify(profile.offline.paths) : undefined,
            },
          }),
        );
        built = true;
      } else {
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
        built = true;
      }
      if (!acquired) {
        const sourceURL = preparedImageSource(root);
        await finalizeImage(config.image ?? tag, reference, {
          "org.workbench.inputs": inputs,
          "org.workbench.builder": profile.builder,
          "org.workbench.architecture": architecture,
          "org.workbench.preparation-host": `linux-${process.arch}`,
          "org.workbench.preparation-method": emulated ? "binfmt" : "native",
          ...(sourceURL ? { "org.opencontainers.image.source": sourceURL } : {}),
        });
      }
      const image = (
        await executeCI("docker", ["image", "inspect", "--format", "{{.Id}}", reference], { capture: true })
      ).trim();
      if (!imageId.test(image)) throw new Error("Build did not produce an immutable image ID");
      recordPreparedImage(root, name, reference, {
        image,
        inputs,
        platform: `linux-${architecture}`,
        assembled: new Date().toISOString(),
      });
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
        builderCaches:
          reuse && previous?.builderCaches
            ? previous.builderCaches
            : workingBuilderCaches(root, profile.builder, inputs),
        ...(verification ? { verification } : {}),
        ...(previous?.image === image &&
        typeof previous.published === "string" &&
        /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(previous.published)
          ? { published: previous.published }
          : {}),
      };
      mkdirSync(dirname(path), { recursive: true });
      recordPreparedImage(root, name, reference, receipt);
      writeAtomic(path, JSON.stringify(receipt, null, 2) + "\n");
      console.log(
        `Prepared ${name}: ${image}; ${reuse ? "matching offline verification reused" : "fresh offline build passed"}.`,
      );
    } finally {
      lifecycle.close();
      try {
        if (built) await executeCI("docker", ["image", "rm", tag]);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  });
  await maintainPreparedImages(root);
}

export async function verifyOfflineProfile(
  root: string,
  name: string,
  image?: string,
  architecture: string = process.arch,
): Promise<void> {
  await withOfflineProfileLock(root, name, architecture, () =>
    verifyAcceptedProfile(root, name, image, false, architecture),
  );
  await maintainPreparedImages(root);
}

async function verifyAcceptedProfile(
  root: string,
  name: string,
  image?: string,
  retry = false,
  architecture: string = process.arch,
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
    await runImage(root, profile, config, image ?? receipt.image, source, { architecture });
    if (offlineInputs(root, offlineProfile(root, name), architecture) !== receipt.inputs)
      throw new Error("Profile changed during verification; preserving the previous receipt");
    if ((!image || retry) && preparedOfflineProfile(root, profile, architecture).image !== receipt.image)
      throw new Error("Accepted image changed during verification");
    const verification = await imageVerification(root, profile, config, receipt.image, source, trees, architecture);
    const updated: Receipt = {
      ...receipt,
      verified: new Date().toISOString(),
      ...executionEvidence(architecture),
      builderCaches: receipt.builderCaches ?? workingBuilderCaches(root, profile.builder, receipt.inputs),
      ...(verification ? { verification } : {}),
    };
    if (!verification) delete updated.verification;
    if (image && !retry)
      await executeCI("docker", ["tag", receipt.image, offlineImageReference(root, name, architecture)]);
    recordPreparedImage(root, name, offlineImageReference(root, name, architecture), updated);
    writeAtomic(offlineReceiptPath(root, name, architecture), JSON.stringify(updated, null, 2) + "\n");
    return updated;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
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
    // Verify the selected image before publishing; the registry pull below must preserve its identity.
    const receipt = await verifyAcceptedProfile(root, name, prepared.image, true, architecture);
    let tagged = false;
    try {
      const existing = (
        await executeCI("docker", ["image", "inspect", "--format", "{{.Id}}", target], { capture: true })
      ).trim();
      if (existing !== receipt.image)
        throw new Error(`Preserving existing local tag ${target} pointing at another image`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("No such image")) throw error;
      tagged = true;
    }
    try {
      await executeCI("docker", ["tag", receipt.image, target]);
      await executeCI("docker", ["push", target]);
      const digests = JSON.parse(
        await executeCI("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", target], { capture: true }),
      ) as string[];
      const repository = target.slice(0, target.lastIndexOf(":"));
      const published = digests.find((entry) => entry.startsWith(`${repository}@sha256:`));
      if (!published || !/@sha256:[a-f0-9]{64}$/.test(published))
        throw new Error("Registry did not return a digest for the selected repository");
      await executeCI("docker", [
        "pull",
        ...(architecture === process.arch ? [] : ["--platform", `linux/${architecture === "x64" ? "amd64" : "arm64"}`]),
        published,
      ]);
      if (
        (
          await executeCI("docker", ["image", "inspect", "--format", "{{.Id}}", published], { capture: true })
        ).trim() !== receipt.image
      )
        throw new Error("Published image identity differs from prepared image");
      if (preparedOfflineProfile(root, offlineProfile(root, name), architecture).inputs !== receipt.inputs)
        throw new Error("Profile changed during publication");
      recordPreparedImage(root, name, offlineImageReference(root, name, architecture), { ...receipt, published });
      writeAtomic(path, JSON.stringify({ ...receipt, published }, null, 2) + "\n");
      console.log(`Published and verified ${published}`);
    } finally {
      if (tagged) await executeCI("docker", ["image", "rm", target]);
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
  const local = inspectPreparedImages(root, new Set(selections.map(({ reference }) => reference)));
  const cancellation = processCancellation();
  try {
    return await mapWork(selections, { capacity: 4, signal: cancellation.signal }, async ({ profile, reference }) => {
      const registry = profile.offline?.registry
        ? await registryImageStatus(reference, cancellation.signal)
        : { state: RegistryAvailability.NotConfigured };
      const selected = local.entries.find(
        (entry) => entry.reference === reference && entry.blockedReason !== "changed",
      );
      return {
        profile: profile.name,
        reference,
        local: selected
          ? selected.verified
            ? ImagePreparation.Prepared
            : ImagePreparation.Assembled
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

/** CI shares the accepted image and recipe, while retaining its explicit online checks. */
export async function executePreparedProfile(
  root: string,
  name: string,
  command: string[],
  options: { image?: string; reports?: string; env?: Record<string, string>; network?: "host" | "none" } = {},
): Promise<void> {
  const profile = offlineProfile(root, name);
  const image = options.image ?? preparedOfflineProfile(root, profile).image;
  const config = await definition(root, profile, root);
  const distribution = distributionRoot(root);
  const inside = relative(root, distribution);
  await runImage(root, profile, config, image, root, {
    command,
    network: options.network ?? "host",
    ...(options.reports ? { reports: options.reports } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(isAbsolute(inside) || inside === ".." || inside.startsWith("../") || inside.startsWith("..\\")
      ? { distributionMount: distribution }
      : {}),
  });
}
