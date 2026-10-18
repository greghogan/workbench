import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "smol-toml";
import { readDistributionSource } from "./distribution-identity.js";

export const minimumCliNode = "22.23.3";

export interface ToolPin {
  repository: string;
  revision: string;
}
function toolPin(value: unknown): ToolPin {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "repository,revision"
  )
    throw new Error("tool pin requires repository and revision fields");
  const pin = value as ToolPin;
  if (
    typeof pin.repository !== "string" ||
    typeof pin.revision !== "string" ||
    /[\s\\?#\p{Cc}]/u.test(pin.repository) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(pin.revision)
  )
    throw new Error("tool pin requires an HTTPS or SSH Git repository URL and a full immutable Git commit");
  let repository: URL;
  try {
    repository = new URL(pin.repository.replace(/^git\+/, ""));
  } catch {
    throw new Error("tool repository must be an HTTPS or SSH Git URL");
  }
  if (
    !["https:", "ssh:"].includes(repository.protocol) ||
    !repository.hostname ||
    repository.password ||
    (repository.protocol === "https:" && repository.username)
  )
    throw new Error("tool repository must be an HTTPS or SSH Git URL without embedded credentials");
  return { repository: `git+${repository.href}`, revision: pin.revision };
}
export function toolSpecification(value: unknown): string {
  const pin = toolPin(value);
  return `${pin.repository}#${pin.revision}`;
}

function specificationPin(value: unknown): ToolPin | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("#");
  if (parts.length !== 2) return undefined;
  try {
    return toolPin({ repository: parts[0], revision: parts[1] });
  } catch {
    return undefined;
  }
}
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
export async function npmWorkbench(specification: string, args: string[], cwd?: string): Promise<void> {
  let command = "npm";
  let prefix: string[] = [];
  const explicit = process.env.npm_execpath;
  const npm =
    (explicit && /^npm-cli\.[cm]?js$/i.test(basename(explicit)) ? explicit : undefined) ??
    (process.platform === "win32" ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : undefined);
  if (npm) {
    if (!existsSync(npm)) throw new Error("Cannot locate npm-cli.js; install Node.js with npm or set npm_execpath");
    command = process.execPath;
    prefix = [npm];
  }
  const env = { ...process.env, WORKBENCH_EXECUTING_SPEC: specification };
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
  await launchProcess(command, [...prefix, "exec", "--yes", `--package=${specification}`, "--", "workbench", ...args], {
    env,
    ...(cwd === undefined ? {} : { cwd }),
  });
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
  const command = args.find((argument) => !["--plain", "--no-plain"].includes(argument));
  const pin = command === "install" ? defaultPin : ((root ? readToolPin(root) : undefined) ?? defaultPin);
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
