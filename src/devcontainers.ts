import { readDistributionPin } from "./distribution-manifest.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { distributionRoot, readText } from "./core.js";
import { execute } from "./tool-downloads.js";
import { nativeEnvironment, containerToolsDirectory } from "./native-tools.js";
import { buildPaths } from "./builds.js";
import { userDirectory } from "./storage.js";
import { forwardedCIEnvironment } from "../scripts/ci-layout.mjs";
import { selectedDevelopmentProfile } from "./environments.js";
import { ownedPath } from "./paths.js";
import { executionEnvironment } from "./execution-resources.js";

interface ContainerConfiguration {
  configuration?: { image?: string; features?: Record<string, unknown>; mounts?: unknown[] };
  mergedConfiguration?: { features?: Record<string, unknown> };
}

export function validateContainerOwnership(configured: ContainerConfiguration, builder: string): void {
  if (configured.configuration?.image && !/@sha256:[0-9a-f]{64}$/.test(configured.configuration.image))
    throw new Error("prebuilt development images must be pinned by SHA-256 digest");
  if (
    builder !== "native" &&
    (Object.keys(configured.configuration?.features ?? {}).length ||
      Object.keys(configured.mergedConfiguration?.features ?? {}).length)
  )
    throw new Error(
      "managed Dev Container profiles require their builder in the image; remove independently installed Features",
    );
}

export function devcontainerConfig(root: string): string {
  const profile = selectedDevelopmentProfile(root);
  const path = ownedPath(
    root,
    profile?.workspace === "devcontainer" ? (profile.container_config ?? "") : ".devcontainer/devcontainer.json",
  );
  if (!existsSync(path)) throw new Error(`${root}: devcontainer requires .devcontainer/devcontainer.json`);
  return path;
}

/** Own the startup process group, including Docker clients the upstream CLI leaves attached.
 * Resource affinity/cgroup membership is inherited; only signal ownership changes.
 * Docker's --sig-proxy=false leaves the workspace running when its attached client exits.
 */
export async function containerStartup(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform === "win32")
    throw new Error("Workbench Dev Container execution requires a POSIX host; use WSL or an editor on Windows");
  // Upstream's updateUID Dockerfile has a shared filename; concurrent startups must own separate scratch directories.
  const temporary = mkdtempSync(join(tmpdir(), "workbench-devcontainer-"));
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    const stop = (signal: NodeJS.Signals = "SIGTERM") => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };
    const interrupt = () => {
      stop("SIGINT");
    };
    const terminate = () => {
      stop("SIGTERM");
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    const cleanup = () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errors += chunk;
      let end;
      while ((end = errors.indexOf("\n")) >= 0) {
        const line = errors.slice(0, end);
        errors = errors.slice(end + 1);
        try {
          const event = JSON.parse(line) as { type?: string; text?: string; channel?: string; level?: number };
          if (event.text && (event.channel === "postCreate" || event.level === 3))
            process.stderr.write(event.text + (event.type === "text" && !event.text.endsWith("\n") ? "\n" : ""));
        } catch {
          process.stderr.write(`${line}\n`);
        }
      }
    });
    child.once("error", (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("exit", () => {
      stop();
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (errors) process.stderr.write(errors);
      if (code !== 0) reject(new Error(`Dev Container startup failed: ${String(code ?? signal)}`));
      else resolve(output);
    });
  }).finally(() => {
    rmSync(temporary, { recursive: true, force: true });
  });
}

/** The standard CLI owns images, workspace mounts, and project lifecycle commands. */
export async function executeDevcontainer(root: string, directory: string, command: string[]): Promise<void> {
  const distribution = distributionRoot(root);
  const subdirectory = relative(root, resolve(directory));
  const sharedPin = readDistributionPin(root);
  const distributionDirectory = sharedPin ? ".workbench" : relative(root, distribution);
  if (
    [subdirectory, distributionDirectory].some(
      (path) => isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`),
    )
  )
    throw new Error("Dev Container check and Workbench distribution must be inside the workspace");
  const tools = containerToolsDirectory(distribution);
  const metadata = JSON.parse(readText(join(tools, "node_modules/@devcontainers/cli/package.json"))) as {
    version: string;
    bin: { devcontainer: string };
  };
  const declared = JSON.parse(readText(join(distribution, "package.json"))) as {
    devDependencies: Record<string, string>;
  };
  if (metadata.version !== declared.devDependencies["@devcontainers/cli"])
    throw new Error("Dev Container CLI does not match Workbench's lock; run workbench tools install --devcontainer");
  const cli = join(tools, "node_modules/@devcontainers/cli", metadata.bin.devcontainer);
  const env = { ...nativeEnvironment(distribution, distribution), ...executionEnvironment(root) };
  const profile = selectedDevelopmentProfile(root);
  const builder = profile?.workspace === "devcontainer" ? profile.builder : "native";
  const configuration = devcontainerConfig(root);
  const configured = JSON.parse(
    execute(
      "node",
      [
        cli,
        "read-configuration",
        "--workspace-folder",
        root,
        "--config",
        configuration,
        "--include-merged-configuration",
      ],
      { env, capture: true },
    ),
  ) as ContainerConfiguration;
  validateContainerOwnership(configured, builder);
  const temporary = sharedPin ? mkdtempSync(join(tmpdir(), "workbench-container-config-")) : undefined;
  try {
    const override: string[] = [];
    if (temporary) {
      if (process.platform === "win32")
        throw new Error(
          "Shared installations in Linux Dev Containers require WSL 2; install and run Workbench inside that Linux environment",
        );
      if (!configured.configuration) throw new Error("Dev Container CLI did not return its parsed configuration");
      const path = join(temporary, "devcontainer.json");
      writeFileSync(
        path,
        JSON.stringify({
          ...configured.configuration,
          mounts: [
            ...(configured.configuration.mounts ?? []),
            `type=bind,source=${distribution},target=${distribution},readonly`,
          ],
        }),
      );
      override.push("--override-config", path);
    }
    const builds = buildPaths(root, directory, "devcontainer");
    const rehearsal = process.env.WORKBENCH_CI_DOCKER !== undefined;
    const caches = rehearsal
      ? [userDirectory("cache")]
      : builds.external
        ? [resolve(builds.roots, ".."), resolve(builds.dependencyRoots, ".."), builds.pnpmStore]
        : [];
    const runtime = [
      ...forwardedCIEnvironment(rehearsal ? env : executionEnvironment(root)),
      ...(sharedPin ? ["--remote-env", "WORKBENCH_DISTRIBUTION_MATERIALIZED=1"] : []),
    ];
    if (sharedPin && distribution.includes(","))
      throw new Error("Docker distribution mounts do not support commas in paths");
    for (const cache of caches) {
      if (cache.includes(",")) throw new Error("Docker cache mounts do not support commas in paths");
      mkdirSync(cache, { recursive: true, mode: 0o700 });
    }
    const docker = process.env.WORKBENCH_CI_DOCKER ? ["--docker-path", process.env.WORKBENCH_CI_DOCKER] : [];
    const args = [
      cli,
      "up",
      ...docker,
      ...runtime,
      "--log-format",
      "json",
      "--workspace-folder",
      root,
      "--config",
      configuration,
      ...override,
      ...caches.flatMap((cache) => ["--mount", `type=bind,source=${cache},target=${cache}`]),
    ];
    // CLI logs go to stderr; stdout is its machine-readable result.
    const result = JSON.parse(await containerStartup("node", args, env)) as {
      outcome?: string;
      containerId?: string;
      remoteWorkspaceFolder?: string;
    };
    if (result.outcome !== "success" || !result.remoteWorkspaceFolder?.startsWith("/"))
      throw new Error("Dev Container CLI did not report a successful workspace");
    if (!result.containerId) throw new Error("Dev Container CLI did not report its container ID");
    const mounts = JSON.parse(
      execute("docker", ["inspect", "--format", "{{json .Mounts}}", result.containerId], { env, capture: true }),
    ) as { Source?: string; Destination?: string; RW?: boolean }[];
    if (
      caches.some((cache) => !mounts.some((mount) => mount.Source === cache && mount.Destination === cache && mount.RW))
    )
      throw new Error(
        "existing Dev Container lacks the selected build-cache mount; finish active work and rebuild the container before retrying",
      );
    if (
      sharedPin &&
      !mounts.some((mount) => mount.Source === distribution && mount.Destination === distribution && !mount.RW)
    )
      throw new Error(
        "existing Dev Container lacks the exact Workbench distribution mount; rebuild it before retrying",
      );
    const remoteRoot = result.remoteWorkspaceFolder;
    const remoteDirectory = posix.join(remoteRoot, subdirectory.split(sep).join("/"));
    const remoteDistribution = posix.join(remoteRoot, distributionDirectory.split(sep).join("/"));
    execute(
      "node",
      [
        cli,
        "exec",
        ...docker,
        ...runtime,
        "--workspace-folder",
        root,
        "--config",
        configuration,
        ...override,
        "--remote-env",
        `WORKBENCH_PROJECT_ROOT=${remoteRoot}`,
        "--remote-env",
        "WORKBENCH_DEVCONTAINER=1",
        "--remote-env",
        `WORKBENCH_STORAGE_EXTERNAL=${String(builds.external)}`,
        "--remote-env",
        `WORKBENCH_STORAGE_ROOT=${builds.storageRoot}`,
        "--remote-env",
        `WORKBENCH_CONTAINER_CHECKOUT=${builds.identity.checkout}`,
        "--remote-env",
        `WORKBENCH_PROFILE_CONTEXT=${profile?.name ?? ""}`,
        "--",
        "node",
        posix.join(remoteDistribution, "bin/workbench.mjs"),
        ...(builder === "native" ? ["native-exec"] : ["managed-exec", builder]),
        remoteDirectory,
        "--",
        ...command,
      ],
      { env },
    );
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

export function devcontainerCommand(root: string, directory: string, command: string[]): string[] {
  devcontainerConfig(root);
  if (process.env.WORKBENCH_DEVCONTAINER === "1") return command;
  const distribution = distributionRoot(root);
  if (!existsSync(join(containerToolsDirectory(distribution), "node_modules/@devcontainers/cli/package.json")))
    throw new Error("Dev Container CLI is not installed; run workbench tools install --devcontainer");
  return [
    process.execPath,
    join(distribution, "bin/workbench.mjs"),
    "devcontainer-exec",
    root,
    directory,
    "--",
    ...command,
  ];
}
