import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

/** Package-derived environments can supply Node and npm through separate immutable outputs. */
function runtimeNpm(node: string, environment: NodeJS.ProcessEnv): string | undefined {
  try {
    const selected = realpathSync(node);
    for (const directory of (environment.PATH ?? "").split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      try {
        if (realpathSync(join(directory, "node")) !== selected) continue;
        const launcher = realpathSync(join(directory, "npm"));
        if (/^npm-cli\.[cm]?js$/i.test(basename(launcher))) return launcher;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  return undefined;
}

/** Prefer the selected runtime's npm over an unrelated PATH installation; honor explicit npm dispatch. */
export function npmCommand(
  options: {
    sdkOnly?: boolean;
    node?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): { command: string; prefix: string[] } {
  const node = options.node ?? process.execPath,
    environment = options.environment ?? process.env,
    platform = options.platform ?? process.platform;
  const explicit = environment.npm_execpath;
  const path =
    !options.sdkOnly && explicit && /^npm-cli\.[cm]?js$/i.test(basename(explicit))
      ? explicit
      : ([
          join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
          join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
        ].find(existsSync) ?? (platform === "win32" ? undefined : runtimeNpm(node, environment)));
  if (path) {
    if (!existsSync(path)) throw new Error("Cannot locate npm-cli.js; install Node.js with npm or set npm_execpath");
    return { command: node, prefix: [path] };
  }
  if (options.sdkOnly || platform === "win32")
    throw new Error("Cannot locate the npm CLI supplied by the selected Node SDK");
  return { command: "npm", prefix: [] };
}
