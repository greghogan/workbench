import { approveProjectRegistration, registrationInstruction } from "./project-admission.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "smol-toml";
import { readDistributionSource } from "./distribution-identity.js";
import { diagnosticOptions } from "../scripts/diagnostic-contract.mjs";
import { toolPin, specificationPin, toolSpecification, type ToolPin } from "./tool-pin.js";
import { npmCommand } from "./npm-command.js";
import { cachedNpmWorkbench } from "./npm-cache.js";
import { captureOwnedChild } from "../scripts/owned-child.mjs";
import { projectRegistration, Registration } from "./project-registry.js";
import { commandAdmission } from "./cli/commands.js";

export { minimumCliNode } from "../scripts/node-runtimes.mjs";
import { minimumCliNode } from "../scripts/node-runtimes.mjs";

export function toolProjectRoot(): string | undefined {
  if (process.env.WORKBENCH_PROJECT_ROOT) return resolve(process.env.WORKBENCH_PROJECT_ROOT);
  let directory = process.cwd();
  for (;;) {
    if (existsSync(join(directory, "workbench/config.toml"))) return directory;
    if (existsSync(join(directory, ".git"))) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
export function readToolPin(root: string): ToolPin | undefined {
  const path = join(root, "workbench/config.toml");
  if (!existsSync(path)) return undefined;
  const pin = parse(readFileSync(path, "utf8")).tool as unknown as ToolPin | undefined;
  if (pin !== undefined) toolSpecification(pin);
  return pin;
}

/** Package identity and npm installation metadata take precedence over inherited dispatch context. */
export function executingToolPin(distribution: string): ToolPin | undefined {
  const source = readDistributionSource(distribution);
  const packaged = source ? toolPin(source) : undefined;
  for (let parent = distribution; ; parent = resolve(parent, "..")) {
    const lock = join(parent, "package-lock.json");
    if (relative(parent, distribution).split(sep).join("/").startsWith("node_modules/") && existsSync(lock)) {
      const document = JSON.parse(readFileSync(lock, "utf8")) as { packages?: Record<string, { resolved?: string }> };
      const entry = document.packages?.[relative(parent, distribution).split(sep).join("/")];
      const pin = specificationPin(entry?.resolved);
      if (pin) {
        if (packaged && toolSpecification(packaged) !== toolSpecification(pin))
          throw new Error("Workbench package source identity conflicts with npm installation metadata");
        return packaged ?? pin;
      }
    }
    if (resolve(parent, "..") === parent) break;
  }
  return packaged ?? specificationPin(process.env.WORKBENCH_EXECUTING_SPEC);
}

/** Standard npm caching owns acquisition; argument arrays and exact pins avoid shell evaluation and silent upgrades. */
export async function npmWorkbench(
  specification: string,
  args: string[],
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { command, prefix } = npmCommand();
  const env = { ...environment, WORKBENCH_EXECUTING_SPEC: specification };
  for (const key of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ])
    Reflect.deleteProperty(env, key);
  const controller = new AbortController();
  let cancelled: number | undefined;
  const interrupt = () => {
      cancelled = 130;
      controller.abort();
    },
    terminate = () => {
      cancelled = 143;
      controller.abort();
    };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let cached: string | undefined;
  try {
    let cache = Object.entries(env).find(([name]) => name.toLowerCase() === "npm_config_cache")?.[1];
    if (!cache) {
      const queried = await captureOwnedChild(
        command,
        [...prefix, "config", "get", "cache", "--json"],
        {
          env,
          cwd: cwd ?? process.cwd(),
          signal: controller.signal,
        },
        65536,
      );
      if (queried.status === 0 && !queried.error) {
        try {
          const value: unknown = JSON.parse(queried.stdout);
          if (typeof value === "string") cache = value;
        } catch {
          /* Older/custom npm implementations may not expose JSON configuration. */
        }
      }
    }
    controller.signal.throwIfAborted();
    cached = cache ? await cachedNpmWorkbench(cache, specification, controller.signal) : undefined;
    controller.signal.throwIfAborted();
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
  if (cancelled !== undefined) {
    process.exitCode = cancelled;
    return;
  }
  if (cached) {
    await launchProcess(process.execPath, [cached, ...args], { env, ...(cwd === undefined ? {} : { cwd }) });
    return;
  }
  await launchProcess(command, [...prefix, "exec", "--yes", `--package=${specification}`, "--", "workbench", ...args], {
    env,
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (process.exitCode !== undefined && ![0, 130, 143].includes(Number(process.exitCode)))
    console.error(
      `workbench: pinned Workbench ${specification.replace("#", " at revision ")} failed with exit ${String(process.exitCode)}`,
    );
}

/** Keep ownership until a dispatched CLI exits, forwarding interruption to its cleanup handlers. */
export async function launchProcess(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<void> {
  await new Promise<void>((finish, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    const interrupt = () => child.kill("SIGINT"),
      terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
      finish();
    });
  });
}

/** Managed environments and explicit compatibility runs own their interpreter. */
export function ownsStartupRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return !(
    Boolean(env.GUIX_ENVIRONMENT) ||
    Boolean(env.IN_NIX_SHELL) ||
    (Boolean(env.WORKBENCH_SHELL_ENVIRONMENT) && env.WORKBENCH_SHELL_ENVIRONMENT !== "native") ||
    env.WORKBENCH_PREPARED === "1" ||
    env.WORKBENCH_DEVCONTAINER === "1" ||
    env.WORKBENCH_COMPATIBILITY_RUNTIME === "node"
  );
}

/** Shared diagnostic options must not change which executable an install command selects. */
export function launcherCommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--plain" || argument === "--no-plain" || argument === "--no-pager") continue;
    const specification = diagnosticOptions.find(
      (option) => argument === option.flag || argument?.startsWith(`${option.flag}=`),
    );
    if (specification) {
      if (specification.argument && argument === specification.flag) index++;
      continue;
    }
    return argument;
  }
  return undefined;
}

/** Dispatch before the CLI parses options; a user-installed launcher always has a default pin. */
export async function launch(args: string[], defaultPin?: ToolPin, distribution?: string): Promise<void> {
  const version = process.versions.node.split(".").map(Number);
  const atLeast = (major: number, minor: number, patch: number) =>
    (version[0] ?? 0) > major ||
    (version[0] === major && ((version[1] ?? 0) > minor || (version[1] === minor && (version[2] ?? 0) >= patch)));
  if (!atLeast(18, 20, 8)) throw new Error("Node.js 18.20.8 or newer is required to bootstrap Workbench");
  const own = distribution ? executingToolPin(distribution) : undefined;
  if (own) process.env.WORKBENCH_EXECUTING_SPEC = toolSpecification(own);
  const root = toolProjectRoot();
  const original =
    process.env.WORKBENCH_EPHEMERAL_CHECKOUT === "1" && process.env.WORKBENCH_LOCAL_CONFIG_ROOT
      ? process.env.WORKBENCH_LOCAL_CONFIG_ROOT
      : root;
  const command = launcherCommand(args);
  if (root && existsSync(join(root, "workbench/projects.toml"))) {
    const inspection = args.some((argument) => ["--help", "-h", "--help-all"].includes(argument));
    if (
      command &&
      commandAdmission(command).registration &&
      !inspection &&
      !(command === "serve" && args.includes("--demo"))
    )
      await approveProjectRegistration(original ?? root);
    else if (
      projectRegistration(original ?? root) === Registration.Declined &&
      command !== "complete" &&
      !commandAdmission(command ?? "").internal
    ) {
      console.error(registrationInstruction(original ?? root));
      process.env.WORKBENCH_REGISTRATION_NOTICE = original ?? root;
    }
  }
  const canSelectProject =
    root &&
    (!existsSync(join(root, "workbench/projects.toml")) ||
      projectRegistration(original ?? root) === Registration.Registered);
  const pin =
    command === "install" || command === "project"
      ? defaultPin
      : ((canSelectProject ? readToolPin(root) : undefined) ?? defaultPin);
  if (pin) {
    const spec = toolSpecification(pin);
    if (!distribution || process.env.WORKBENCH_EXECUTING_SPEC !== spec) {
      await npmWorkbench(spec, args);
      return;
    }
  }
  if (!distribution) throw new Error("No project or default Workbench revision is configured");
  process.env.WORKBENCH_DISTRIBUTION_ROOT = distribution;
  const [major = 0, minor = 0, patch = 0] = minimumCliNode.split(".").map(Number);
  if (!atLeast(major, minor, patch)) {
    if (ownsStartupRuntime()) {
      const { default: bootstrap } = (await import(pathToFileURL(join(distribution, "bundle/bootstrap.cjs")).href)) as {
        default: { restartWithStartupRuntime: (distribution: string) => Promise<boolean> };
      };
      if (await bootstrap.restartWithStartupRuntime(distribution)) return;
    }
    throw new Error(`the selected environment requires Node.js ${minimumCliNode} or newer to run the Workbench CLI`);
  }
  await import(pathToFileURL(join(distribution, "bundle/main.cjs")).href);
}
