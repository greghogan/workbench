import { join } from "node:path";
import { cpuEnvironment } from "./cpu-budget.mjs";

/** One layout is used by hosted jobs, local guests, and Dev Container forwarding. */
export function ciCacheEnvironment(
  cache: string,
  data: string = join(cache, "ci/data"),
  isolateRust = false,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return {
    WORKBENCH_DATA_HOME: data,
    WORKBENCH_CACHE_HOME: cache,
    WORKBENCH_STORAGE_ROOT: cache,
    WORKBENCH_STORAGE_EXTERNAL: "true",
    UV_CACHE_DIR: join(cache, "uv"),
    UV_PYTHON_INSTALL_DIR: join(cache, "uv-python", "python"),
    ...(platform === "win32" ? { UV_PYTHON_CACHE_DIR: join(cache, "downloads", "uv-python") } : {}),
    WORKBENCH_MAVEN_REPOSITORY: join(cache, "downloads", "maven"),
    WORKBENCH_COMPOSER_CACHE: join(cache, "downloads", "composer"),
    GOMODCACHE: join(cache, "go-mod"),
    GOCACHE: join(cache, "go-build"),
    npm_config_cache: join(cache, "npm"),
    PIP_CACHE_DIR: join(cache, "pip"),
    ...(isolateRust ? { CARGO_HOME: join(cache, "ci/cargo"), RUSTUP_HOME: join(cache, "ci/rustup") } : {}),
  };
}

/** Recreate installed dependencies from download stores; retain only reusable compiled outputs.
 * Windows build trees contain junctions that do not survive the Actions archive round trip.
 */
export function ciBuildCachePaths(
  cache: string,
  environment?: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const directories =
    platform === "win32"
      ? ["go-build"]
      : ["builds", "go-build", ...(environment === "devcontainer" ? ["container-tools"] : [])];
  return directories.map((name) => join(cache, name));
}

export function forwardedCIEnvironment(env: NodeJS.ProcessEnv): string[] {
  const names = [
    ...Object.keys(ciCacheEnvironment("", "", true)),
    ...Object.keys(cpuEnvironment(1, {})),
    "WORKBENCH_CPUS",
    "WORKBENCH_CI_TARGET",
    "WORKBENCH_LOCAL_CI_IMAGE",
    // Only hosted jobs forward their explicitly provisioned read-only API token.
    ...(env.GITHUB_ACTIONS === "true" ? ["GITHUB_ACTIONS", "GH_TOKEN"] : []),
  ];
  return names.flatMap((name) => (env[name] === undefined ? [] : ["--remote-env", `${name}=${env[name]}`]));
}
