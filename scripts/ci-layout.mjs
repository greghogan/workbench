import { join } from "node:path";
import { cpuEnvironment } from "./cpu-budget.mjs";

/** One layout is used by hosted jobs, local guests, and Dev Container forwarding. */
export function ciCacheEnvironment(
  cache,
  data = join(cache, "ci/data"),
  isolateRust = false,
  platform = process.platform,
) {
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

/** Windows junctions in installed dependency/venv trees do not survive the Actions archive round trip. */
export function ciBuildCachePaths(cache, environment, platform = process.platform) {
  const directories =
    platform === "win32"
      ? ["go-build"]
      : ["builds", "dependencies", "go-build", ...(environment === "devcontainer" ? ["container-tools"] : [])];
  return directories.map((name) => join(cache, name));
}

export function forwardedCIEnvironment(env) {
  const names = [
    ...Object.keys(ciCacheEnvironment("", "", true)),
    ...Object.keys(cpuEnvironment(1)),
    "WORKBENCH_CI_TARGET",
    // Only hosted jobs forward their explicitly provisioned read-only API token.
    ...(env.GITHUB_ACTIONS === "true" ? ["GITHUB_ACTIONS", "GH_TOKEN"] : []),
  ];
  return names.flatMap((name) => (env[name] === undefined ? [] : ["--remote-env", `${name}=${env[name]}`]));
}
