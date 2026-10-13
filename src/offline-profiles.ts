import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, dirname, isAbsolute } from "node:path";
import { distributionRoot, readConfig, readLanguageRoots, readText, writeAtomic } from "./core.js";
import { containerToolsDirectory, nativeEnvironment } from "./native-tools.js";
import { containerStartup, validateContainerOwnership } from "./devcontainers.js";
import { executeCI, CILifecycle } from "./ci-lifecycle.js";
import { projectPinFile, readDistributionPin } from "./distribution-manifest.js";
import { snapshotCIProject } from "./ci-workspace.js";
import { ownedPath } from "./paths.js";
import { userDirectory } from "./storage.js";
import { withCacheLock } from "./cache-lock.js";
import { executionEnvironment } from "./execution-resources.js";
import { git } from "./update-git.js";
import { recordImage } from "./image-catalog.js";
import type { DevelopmentProfile } from "./profile-schema.js";

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
  published?: string;
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const imageId = /^sha256:[0-9a-f]{64}$/;
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
): DevelopmentProfile & { offline: NonNullable<DevelopmentProfile["offline"]> } {
  const profile = readConfig(root).development?.profiles?.find((entry) => entry.name === name);
  if (!profile?.offline) throw new Error(`'${name}' is not an offline development profile`);
  const roots = readLanguageRoots(root).map((entry) => entry.path);
  if (profile.offline.paths?.some((path) => !roots.includes(path)))
    throw new Error("offline.paths must name registered language roots");
  return profile as DevelopmentProfile & { offline: NonNullable<DevelopmentProfile["offline"]> };
}

export function offlineInputManifest(root: string, profile: DevelopmentProfile) {
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
      files.push([name, hash(readFileSync(path)), stat.mode & 0o111]);
    else throw new Error(`unsupported offline input: ${name}`);
  };
  for (const name of [...new Set([profile.container_config, ...profile.offline.inputs])].sort()) visit(name);
  if (readDistributionPin(root) && !profile.offline.inputs.includes(projectPinFile)) visit(projectPinFile);
  return {
    profile,
    platform: `linux-${process.arch}`,
    files: [...new Map(files.map((entry) => [entry[0], entry])).values()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    ),
  };
}

export function offlineInputs(root: string, profile: DevelopmentProfile): string {
  return hash(JSON.stringify(offlineInputManifest(root, profile)));
}

export function offlineReceiptPath(root: string, name: string): string {
  return join(userDirectory("cache"), "offline-profiles", hash(root), `${name}.json`);
}

export function preparedOfflineProfile(root: string, profile: DevelopmentProfile): Receipt {
  const path = offlineReceiptPath(root, profile.name);
  if (!existsSync(path))
    throw new Error(
      `Offline profile '${profile.name}' is not prepared; run workbench development prepare ${profile.name}`,
    );
  const receipt = JSON.parse(readText(path)) as Receipt;
  if (
    receipt.version !== 1 ||
    receipt.profile !== profile.name ||
    receipt.inputs !== offlineInputs(root, profile) ||
    !imageId.test(receipt.image) ||
    receipt.platform !== `linux-${process.arch}` ||
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
  const tools = containerToolsDirectory(distribution);
  const metadataPath = join(tools, "node_modules/@devcontainers/cli/package.json");
  if (!existsSync(metadataPath))
    throw new Error("Install the locked Dev Container CLI with workbench tools install --devcontainer");
  const metadata = JSON.parse(readText(metadataPath)) as {
    version: string;
    bin: { devcontainer: string };
  };
  const declared = JSON.parse(readText(join(distribution, "package.json"))) as {
    devDependencies: Record<string, string>;
  };
  if (metadata.version !== declared.devDependencies["@devcontainers/cli"])
    throw new Error("Install the locked Dev Container CLI with workbench tools install --devcontainer");
  return {
    cli: join(tools, "node_modules/@devcontainers/cli", metadata.bin.devcontainer),
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

async function runImage(
  root: string,
  profile: ReturnType<typeof offlineProfile>,
  config: ContainerDefinition,
  image: string,
  source: string,
  options: { command?: string[]; network?: "host" | "none"; env?: Record<string, string>; reports?: string } = {},
): Promise<void> {
  const platform = JSON.parse(
    await executeCI("docker", ["image", "inspect", "--format", "{{json .}}", image], { capture: true }),
  ) as { Os: string; Architecture: string; Config: { Volumes?: Record<string, unknown> } };
  if (
    platform.Os !== "linux" ||
    platform.Architecture !== (process.arch === "x64" ? "amd64" : "arm64") ||
    Object.keys(platform.Config.Volumes ?? {}).length
  )
    throw new Error("Offline image must match the native architecture and have no implicit volumes");
  const workspace = config.workspaceFolder ?? "/workbench";
  if (source.includes(",")) throw new Error("Docker mount paths cannot contain commas");
  const container = `workbench-offline-${randomUUID()}`;
  const distributionPath = readDistributionPin(root) ? ".workbench" : relative(root, distributionRoot(root));
  if (isAbsolute(distributionPath) || distributionPath === ".." || distributionPath.startsWith("../"))
    throw new Error("Offline verification requires a project-contained Workbench reference");
  const guestDistribution = posix.join(workspace, distributionPath.replaceAll("\\", "/"));
  const command = (options.command ?? profile.offline.verify).map((part) =>
    part.replaceAll("{workbench}", guestDistribution),
  );
  let created = false;
  const owner = statSync(source);
  const reportOwner = options.reports ? statSync(options.reports) : undefined;
  let ownershipChanged = false;
  try {
    await executeCI("docker", [
      "create",
      "--name",
      container,
      `--network=${options.network ?? "none"}`,
      ...(config.runArgs ?? []),
      ...(config.containerUser ? ["--user", config.containerUser] : []),
      ...Object.entries(config.containerEnv ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--mount",
      `type=bind,src=${source},dst=${workspace}`,
      ...(options.reports ? ["--mount", `type=bind,src=${options.reports},dst=/reports`] : []),
      ...(config.overrideCommand === false ? [] : ["--entrypoint", "/bin/sh"]),
      image,
      ...(config.overrideCommand === false ? [] : ["-c", "while :; do sleep 3600; done"]),
    ]);
    created = true;
    await executeCI("docker", ["start", container]);
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
    await executeCI("docker", [
      "exec",
      ...(config.remoteUser ? ["--user", config.remoteUser] : []),
      "--workdir",
      workspace,
      ...Object.entries({
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
      }).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      container,
      ...command,
    ]);
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
      if (created) await executeCI("docker", ["rm", "--force", container]);
    }
  }
}

/** Build online, then accept only a fresh source build with no network or host caches. */
export async function prepareOfflineProfile(root: string, name: string, build = false): Promise<void> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Offline preparation currently requires native Linux x64 or ARM64; use WSL on Windows");
  const profile = offlineProfile(root, name);
  const path = offlineReceiptPath(root, name);
  await withCacheLock(path, async () => {
    const inputs = offlineInputs(root, profile);
    devcontainerCLI(root);
    const temporary = mkdtempSync(join(tmpdir(), "workbench-offline-"));
    const lifecycle = new CILifecycle();
    const tag = `workbench-offline:prepare-${randomUUID()}`;
    let built = false;
    try {
      const source = join(temporary, "source");
      await snapshotCIProject(root, source, lifecycle);
      await lifecycle.checkpoint();
      if (offlineInputs(source, profile) !== inputs)
        throw new Error("Offline inputs changed during preparation; preserving the previous profile");
      const config = await definition(root, profile, source);
      const { cli, env } = devcontainerCLI(root);
      const platform = `linux/${process.arch === "x64" ? "amd64" : "arm64"}`;
      const reference = offlineImageReference(root, name);
      let acquired = false;
      try {
        if (build) throw new Error("No such image: explicit build requested");
        await executeCI("docker", ["image", "inspect", reference], { capture: true });
        acquired = true;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("No such image")) throw error;
      }
      if (!acquired && !build && profile.offline.registry) {
        try {
          await executeCI("docker", ["pull", "--platform", platform, reference], { capture: true });
          acquired = true;
        } catch (error) {
          if (!(error instanceof Error) || !/manifest unknown|not found/.test(error.message)) throw error;
          console.log(`No published image for ${inputs}; building ${name}.`);
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
      } else if (config.image) await executeCI("docker", ["pull", "--platform", platform, config.image]);
      else {
        await containerStartup(
          "node",
          [
            cli,
            "build",
            "--platform",
            platform,
            "--workspace-folder",
            source,
            "--config",
            ownedPath(source, profile.container_config ?? ""),
            "--image-name",
            tag,
          ],
          env,
        );
        built = true;
      }
      if (!acquired) {
        const metadata = join(temporary, "metadata");
        mkdirSync(metadata);
        writeAtomic(
          join(metadata, "Dockerfile"),
          `FROM ${config.image ?? tag}\nLABEL org.workbench.inputs=${inputs} org.workbench.builder=${profile.builder} org.workbench.architecture=${process.arch}\n`,
        );
        await executeCI("docker", ["build", "--tag", reference, metadata]);
      }
      const image = (
        await executeCI("docker", ["image", "inspect", "--format", "{{.Id}}", reference], { capture: true })
      ).trim();
      if (!imageId.test(image)) throw new Error("Build did not produce an immutable image ID");
      await lifecycle.checkpoint();
      const fresh = join(temporary, "verification");
      await snapshotCIProject(root, fresh, lifecycle);
      if (offlineInputs(fresh, profile) !== inputs)
        throw new Error("Offline inputs changed during preparation; preserving the previous profile");
      await runImage(root, profile, config, image, fresh);
      if (offlineInputs(root, profile) !== inputs)
        throw new Error("Offline inputs changed during preparation; preserving the previous profile");
      const receipt: Receipt = {
        version: 1,
        profile: name,
        inputs,
        image,
        platform: `linux-${process.arch}`,
        verified: new Date().toISOString(),
      };
      mkdirSync(dirname(path), { recursive: true });
      await recordImage(root, {
        inputs,
        manifest: offlineInputManifest(root, profile),
        image,
        reference,
        verified: receipt.verified,
      });
      writeAtomic(path, JSON.stringify(receipt, null, 2) + "\n");
      console.log(`Prepared ${name}: ${image}; fresh offline build passed.`);
    } finally {
      lifecycle.close();
      try {
        if (built) await executeCI("docker", ["image", "rm", tag]);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  });
}

export async function verifyOfflineProfile(root: string, name: string, image?: string): Promise<void> {
  const profile = offlineProfile(root, name);
  const receipt = preparedOfflineProfile(root, profile);
  const temporary = mkdtempSync(join(tmpdir(), "workbench-offline-verify-"));
  try {
    const source = join(temporary, "source");
    await snapshotCIProject(root, source);
    if (offlineInputs(source, profile) !== receipt.inputs)
      throw new Error("Offline inputs changed during verification; prepare the profile again");
    const config = await definition(root, profile, source);
    await runImage(root, profile, config, image ?? receipt.image, source);
    preparedOfflineProfile(root, offlineProfile(root, name));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function publishOfflineProfile(root: string, name: string, target: string): Promise<void> {
  if (!/^ghcr\.io\/[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)+:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(target))
    throw new Error("Publication requires an explicit ghcr.io/owner/image:tag");
  const path = offlineReceiptPath(root, name);
  await withCacheLock(path, async () => {
    const receipt = preparedOfflineProfile(root, offlineProfile(root, name));
    // The accepted receipt already binds the immutable image to these inputs; verify the registry pull below.
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
      await executeCI("docker", ["pull", published]);
      if (
        (
          await executeCI("docker", ["image", "inspect", "--format", "{{.Id}}", published], { capture: true })
        ).trim() !== receipt.image
      )
        throw new Error("Published image identity differs from prepared image");
      await verifyOfflineProfile(root, name, published);
      if (preparedOfflineProfile(root, offlineProfile(root, name)).inputs !== receipt.inputs)
        throw new Error("Profile changed during publication");
      await recordImage(root, {
        inputs: receipt.inputs,
        manifest: offlineInputManifest(root, offlineProfile(root, name)),
        image: receipt.image,
        reference: target,
        verified: receipt.verified,
        published,
        publishedAt: new Date().toISOString(),
      });
      writeAtomic(path, JSON.stringify({ ...receipt, published }, null, 2) + "\n");
      console.log(`Published and verified ${published}`);
    } finally {
      if (tagged) await executeCI("docker", ["image", "rm", target]);
    }
  });
}

/** Architecture and immutable preparation inputs select a project-internal registry tag. */
export function offlineImageReference(root: string, name: string): string {
  const profile = offlineProfile(root, name);
  return `${profile.offline.registry ?? "workbench-prepared"}:linux-${process.arch}-${offlineInputs(root, profile)}`;
}

/** CI shares the accepted image and recipe, while retaining its explicit online checks. */
export async function executePreparedProfile(
  root: string,
  name: string,
  command: string[],
  options: { image?: string; reports?: string; env?: Record<string, string> } = {},
): Promise<void> {
  const profile = offlineProfile(root, name);
  const image = options.image ?? preparedOfflineProfile(root, profile).image;
  const config = await definition(root, profile, root);
  await runImage(root, profile, config, image, root, {
    command,
    network: "host",
    ...(options.reports ? { reports: options.reports } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
}
