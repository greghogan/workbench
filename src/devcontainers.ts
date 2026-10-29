import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { forwardedCIEnvironment } from "../scripts/ci-layout.mjs";
import { buildPaths } from "./builds.js";
import { containerStartup, validateContainerOwnership, type ContainerConfiguration } from "./container-startup.js";
import { containerCLI } from "./container-tools.js";
import { selectedDevelopmentProfile } from "./environments.js";
import { currentExecutionEnvironment } from "./execution-context.js";
import { executionEnvironment } from "./execution-resources.js";
import { nativeEnvironment } from "./native-tools.js";
import { preparedOfflineProfile, prepareOfflineProfile, validateOfflineDefinition } from "./offline-profiles.js";
import { ownedPath } from "./paths.js";
import { policyExecutionEnvironment } from "./policy-compatibility.js";
import { distributionRoot } from "./project-context.js";
import { userDirectory } from "./storage.js";
import { execute } from "./tool-execution.js";

export function devcontainerConfig(root: string): string {
  const profile = selectedDevelopmentProfile(root);
  const path = ownedPath(
    root,
    profile?.workspace === "devcontainer" ? (profile.container_config ?? "") : ".devcontainer/devcontainer.json",
  );
  if (!existsSync(path)) throw new Error(`${root}: devcontainer requires .devcontainer/devcontainer.json`);
  return path;
}

/** The standard CLI owns images, workspace mounts, and project lifecycle commands. */
export async function executeDevcontainer(root: string, directory: string, command: string[]): Promise<void> {
  const distribution = distributionRoot(root);
  const subdirectory = relative(root, resolve(directory));
  const distributionDirectory = relative(root, distribution);
  const sharedPin =
    isAbsolute(distributionDirectory) || distributionDirectory === ".." || distributionDirectory.startsWith(`..${sep}`);
  if ([subdirectory].some((path) => isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)))
    throw new Error("Dev Container check and Workbench distribution must be inside the workspace");
  const cli = containerCLI(distribution);
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
  let offline;
  if (profile?.offline) {
    try {
      offline = preparedOfflineProfile(root, profile);
      execute("docker", ["image", "inspect", offline.image], { env, capture: true });
    } catch {
      await prepareOfflineProfile(root, profile.name);
      offline = preparedOfflineProfile(root, profile);
    }
  }
  if (profile?.offline?.paths && !profile.offline.paths.includes(subdirectory.split(sep).join("/") || "."))
    throw new Error(`Offline profile '${profile.name}' does not include this root; select one of offline.paths`);
  if (offline && root.includes(",")) throw new Error("Docker workspace paths cannot contain commas");
  if (offline) {
    validateOfflineDefinition(configured.configuration ?? {});
    // Fail before the upstream CLI can try pulling a missing local image ID.
    try {
      execute("docker", ["image", "inspect", offline.image], { env, capture: true });
    } catch (cause) {
      throw new Error(
        "Prepared offline image is unavailable locally; prepare the profile again or pull its recorded registry digest",
        { cause },
      );
    }
  }
  const temporary = sharedPin || offline ? mkdtempSync(join(tmpdir(), "workbench-container-config-")) : undefined;
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
          ...(offline
            ? {
                build: undefined,
                image: offline.image,
                updateRemoteUserUID: false,
                workspaceMount: `source=${root},target=${(configured.configuration as { workspaceFolder?: string }).workspaceFolder ?? "/workbench"},type=bind`,
              }
            : {}),
          mounts: [
            ...(configured.configuration.mounts ?? []),
            ...(sharedPin ? [`type=bind,source=${distribution},target=${distribution},readonly`] : []),
          ],
        }),
      );
      override.push("--override-config", path);
    }
    const builds = buildPaths(root, directory, "devcontainer");
    const rehearsal = currentExecutionEnvironment().WORKBENCH_CI_DOCKER !== undefined;
    const ci = rehearsal || currentExecutionEnvironment().GITHUB_ACTIONS === "true";
    const caches = offline
      ? []
      : ci
        ? [...new Set([userDirectory("cache"), userDirectory("data")])]
        : builds.external
          ? [resolve(builds.roots, ".."), resolve(builds.dependencyRoots, ".."), builds.pnpmStore]
          : [];
    const runtime = [
      ...Object.entries(policyExecutionEnvironment(root)).flatMap(([name, value]) => [
        "--remote-env",
        `${name}=${String(value)}`,
      ]),
      ...forwardedCIEnvironment(ci && !offline ? env : executionEnvironment(root)),
      ...(sharedPin ? ["--remote-env", "WORKBENCH_DISTRIBUTION_MATERIALIZED=1"] : []),
    ];
    if (sharedPin && distribution.includes(","))
      throw new Error("Docker distribution mounts do not support commas in paths");
    for (const cache of caches) {
      if (cache.includes(",")) throw new Error("Docker cache mounts do not support commas in paths");
      mkdirSync(cache, { recursive: true, mode: 0o700 });
    }
    const dockerPath = currentExecutionEnvironment().WORKBENCH_CI_DOCKER;
    const docker = dockerPath ? ["--docker-path", dockerPath] : [];
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
    if (offline) {
      const actual = JSON.parse(
        execute("docker", ["inspect", "--format", "{{json .}}", result.containerId], { env, capture: true }),
      ) as { Image: string; HostConfig: { NetworkMode: string } };
      if (actual.Image !== offline.image)
        throw new Error(
          "Existing Dev Container does not use the prepared image; preserve active work and reopen it explicitly",
        );
      if (
        mounts.some(
          (mount) =>
            !(mount.Source === root && mount.Destination === result.remoteWorkspaceFolder) &&
            !(sharedPin && mount.Source === distribution && mount.Destination === distribution && !mount.RW),
        )
      )
        throw new Error(
          "Offline Dev Container has unexpected host mounts; preserve active work and reopen it explicitly",
        );
    }
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
    const remoteDistribution = sharedPin
      ? distribution.split(sep).join("/")
      : posix.join(remoteRoot, distributionDirectory.split(sep).join("/"));
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
        `WORKBENCH_STORAGE_EXTERNAL=${String(offline ? false : builds.external)}`,
        ...(offline ? [] : ["--remote-env", `WORKBENCH_STORAGE_ROOT=${builds.storageRoot}`]),
        "--remote-env",
        `WORKBENCH_CONTAINER_CHECKOUT=${builds.identity.checkout}`,
        "--remote-env",
        `WORKBENCH_PROFILE_CONTEXT=${profile?.name ?? ""}`,
        "--remote-env",
        "WORKBENCH_WORKSPACE_CONTEXT=devcontainer",
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
  if (currentExecutionEnvironment().WORKBENCH_DEVCONTAINER === "1") return command;
  const distribution = distributionRoot(root);
  containerCLI(distribution);
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
