import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { distributionRoot, readText } from "./core.js";
import { execute } from "./tool-downloads.js";
import { nativeEnvironment } from "./native-tools.js";
import { buildPaths } from "./builds.js";

export function devcontainerConfig(root: string): string {
  const path = join(root, ".devcontainer/devcontainer.json");
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
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
  });
}

/** The standard CLI owns images, workspace mounts, and project lifecycle commands. */
export async function executeDevcontainer(root: string, directory: string, command: string[]): Promise<void> {
  const distribution = distributionRoot(root);
  const subdirectory = relative(root, resolve(directory));
  const distributionDirectory = relative(root, distribution);
  if (
    [subdirectory, distributionDirectory].some(
      (path) => isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`),
    )
  )
    throw new Error("Dev Container check and Workbench distribution must be inside the workspace");
  const metadata = JSON.parse(readText(join(distribution, "node_modules/@devcontainers/cli/package.json"))) as {
    version: string;
    bin: { devcontainer: string };
  };
  const declared = JSON.parse(readText(join(distribution, "package.json"))) as {
    devDependencies: Record<string, string>;
  };
  if (metadata.version !== declared.devDependencies["@devcontainers/cli"])
    throw new Error("Dev Container CLI does not match Workbench's lock; run workbench tools install --devcontainer");
  const cli = join(distribution, "node_modules/@devcontainers/cli", metadata.bin.devcontainer);
  const env = nativeEnvironment(distribution, distribution);
  const builds = buildPaths(root, directory, "devcontainer");
  const caches = builds.external
    ? [resolve(builds.roots, ".."), resolve(builds.dependencyRoots, ".."), builds.pnpmStore]
    : [];
  for (const cache of caches) {
    if (cache.includes(",")) throw new Error("Docker cache mounts do not support commas in paths");
    mkdirSync(cache, { recursive: true, mode: 0o700 });
  }
  const args = [
    cli,
    "up",
    "--log-format",
    "json",
    "--workspace-folder",
    root,
    "--config",
    devcontainerConfig(root),
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
  const remoteRoot = result.remoteWorkspaceFolder;
  const remoteDirectory = posix.join(remoteRoot, subdirectory.split(sep).join("/"));
  const remoteDistribution = posix.join(remoteRoot, distributionDirectory.split(sep).join("/"));
  execute(
    "node",
    [
      cli,
      "exec",
      "--workspace-folder",
      root,
      "--config",
      devcontainerConfig(root),
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
      "--",
      "node",
      posix.join(remoteDistribution, "bin/workbench.mjs"),
      "native-exec",
      remoteDirectory,
      "--",
      ...command,
    ],
    { env },
  );
}

export function devcontainerCommand(root: string, directory: string, command: string[]): string[] {
  devcontainerConfig(root);
  if (process.env.WORKBENCH_DEVCONTAINER === "1") return command;
  const distribution = distributionRoot(root);
  if (!existsSync(join(distribution, "node_modules/@devcontainers/cli/package.json")))
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
