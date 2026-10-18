import { existsSync, realpathSync, statSync } from "node:fs";
import { windowsGitExecutable, windowsGitDirectories, normalizeWindowsPaths } from "./windows-host.js";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { readConfig, readLanguageRoots, distributionRoot } from "./core.js";
import { declaredCheckEnvironment } from "./language-config.js";
import { nativeEnvironment } from "./native-tools.js";
import { buildPaths, buildEnvironment, type BuildPaths } from "./builds.js";
import { executionResources } from "./execution-resources.js";
import { cpuEnvironment } from "../scripts/cpu-budget.mjs";
import type { CompilerSelection } from "./compilers.js";
import { userDirectory } from "./storage.js";

const platformNames = [
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  // Without this context, Git for Windows initializes MSYS again and prepends tool directories to PATH.
  "MSYSTEM",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TZ",
  "CI",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "GIT_SSL_CAINFO",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
];
// These select Workbench-owned locations or execution modes; agent/session metadata is never inherited.
const contextNames = [
  "WORKBENCH_CONFIG_HOME",
  "WORKBENCH_DATA_HOME",
  "WORKBENCH_CACHE_HOME",
  "WORKBENCH_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_DIRS",
  "WORKBENCH_LOCAL_CONFIG_ROOT",
  "WORKBENCH_EPHEMERAL_CHECKOUT",
  "WORKBENCH_COLLECTIONS_MATERIALIZED",
  "WORKBENCH_DISTRIBUTION_MATERIALIZED",
  "WORKBENCH_POLICY_REVIEW",
  "WORKBENCH_PROFILE_CONTEXT",
  "WORKBENCH_WORKSPACE_CONTEXT",
  "WORKBENCH_TOOLCHAIN",
  "WORKBENCH_TOOLCHAIN_ROOT",
  "WORKBENCH_COMPATIBILITY_RUNTIME",
  "WORKBENCH_COMPATIBILITY_VERSION",
  "WORKBENCH_OFFLINE",
  "WORKBENCH_PREPARED",
  "WORKBENCH_DEVCONTAINER",
  "WORKBENCH_SHELL_ENVIRONMENT",
  "WORKBENCH_SHELL_ROOT",
  "WORKBENCH_CI_TARGET",
  "WORKBENCH_CONTAINER_CHECKOUT",
  "WORKBENCH_LOCAL_CI_IMAGE",
  "WORKBENCH_COVERAGE_BASE",
  "WORKBENCH_MAX_JOBS",
  "WORKBENCH_CPUS",
  "WORKBENCH_CPU_BUDGET",
  "WORKBENCH_RELEASE_OUTPUT",
  "WORKBENCH_RELEASE_FORMAT",
  "WORKBENCH_RELEASE_BUILDER",
  "WORKBENCH_RELEASE_PLATFORM",
  "WORKBENCH_RELEASE_ARTIFACT",
  // Instrumented distributions collect their subprocess evidence across language-independent CLI fixtures.
  "NODE_V8_COVERAGE",
  "WORKBENCH_SUBPROCESS_COVERAGE",
];
const hostCommands = [
  "git",
  "sh",
  "bash",
  "env",
  "tar",
  "gzip",
  "xz",
  "zstd",
  "curl",
  "make",
  "pkg-config",
  "gpg",
  "ssh",
  "rsync",
  "patch",
  "unzip",
  "zip",
  "direnv",
  "docker",
  "nix",
  "guix",
  "pwsh",
  "powershell.exe",
  "cmd.exe",
  // Clang on Windows uses the installed Windows SDK and MSVC linker.
  ...(process.platform === "win32" ? ["rc.exe", "mt.exe", "link.exe"] : []),
];
const languageBudgets: Record<string, string[]> = {
  typescript: ["UV_THREADPOOL_SIZE", "npm_config_child_concurrency"],
  javascript: ["UV_THREADPOOL_SIZE", "npm_config_child_concurrency"],
  python: ["UV_CONCURRENT_BUILDS", "UV_CONCURRENT_INSTALLS", "PYTEST_XDIST_AUTO_NUM_WORKERS"],
  rust: ["CARGO_BUILD_JOBS", "NEXTEST_TEST_THREADS", "RUST_TEST_THREADS", "RAYON_NUM_THREADS"],
  c: ["CMAKE_BUILD_PARALLEL_LEVEL", "CTEST_PARALLEL_LEVEL", "VCPKG_MAX_CONCURRENCY"],
  cpp: ["CMAKE_BUILD_PARALLEL_LEVEL", "CTEST_PARALLEL_LEVEL", "VCPKG_MAX_CONCURRENCY"],
  go: ["GOMAXPROCS", "GOFLAGS"],
};

function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== "win32" && !name.startsWith("npm_config_"))
    return Object.hasOwn(env, name) ? env[name] : undefined;
  const key = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

const gitExecutables = new Map<string, string>();
function hostExecutable(name: string, path: string, env: NodeJS.ProcessEnv): string {
  const actual = realpathSync(path);
  if (process.platform !== "win32" || name !== "git") return actual;
  const previous = gitExecutables.get(actual);
  if (previous) return previous;
  const selected = windowsGitExecutable(actual, env);
  gitExecutables.set(actual, selected);
  return selected;
}

/** Canonical executable destinations avoid depending on agent-added PATH directories or profile aliases. */
function hostEnvironment(env: NodeJS.ProcessEnv): { PATH: string; MSYSTEM?: string } {
  const paths = new Set<string>([dirname(realpathSync(process.execPath))]);
  const search = (value(env, "PATH") ?? "").split(delimiter).filter(Boolean);
  const suffixes =
    process.platform === "win32" ? ["", ...(value(env, "PATHEXT") ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  const find = (directory: string, name: string) =>
    suffixes
      .map((suffix) => resolve(directory, name + suffix))
      .find((file) => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      });
  let msystem: string | undefined;
  if (process.platform === "win32") {
    const git = search.map((directory) => find(directory, "git")).find(Boolean);
    if (git) {
      const runtime = windowsGitDirectories(hostExecutable("git", git, env));
      if (runtime[0]) {
        search.unshift(...runtime);
        msystem = basename(dirname(runtime[0])).toUpperCase();
      }
    }
  }
  const pending = new Set(hostCommands);
  // Preserve caller precedence outside the selected Windows Git runtime, which hooks also require.
  for (const directory of search)
    for (const name of pending) {
      const found = find(directory, name);
      if (found) {
        paths.add(dirname(hostExecutable(name, found, env)));
        pending.delete(name);
      }
    }
  const system =
    process.platform === "win32"
      ? [join(value(env, "SystemRoot") ?? "C:\\Windows", "System32"), value(env, "SystemRoot") ?? "C:\\Windows"]
      : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"];
  for (const path of system) if (existsSync(path)) paths.add(path);
  return { PATH: [...paths].join(delimiter), ...(msystem ? { MSYSTEM: msystem } : {}) };
}

export function checkHostPath(env: NodeJS.ProcessEnv): string {
  return hostEnvironment(env).PATH;
}

export function checkLanguages(root: string, directory: string): string[] {
  return readLanguageRoots(root)
    .filter((entry) => resolve(root, entry.path) === directory)
    .map((entry) => entry.language);
}

/** One caller allowlist feeds both execution and fingerprinting. Adapters add authoritative tool settings afterward. */
export function checkBaseEnvironment(
  root: string,
  directory: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const languages = checkLanguages(root, directory);
  const requested = readConfig(root).checks?.pass_environment ?? [];
  const names = new Set([...platformNames, ...contextNames, ...declaredCheckEnvironment(root, languages)]);
  const count = value(source, "GIT_CONFIG_COUNT");
  if (count !== undefined) {
    if (!/^\d+$/.test(count) || Number(count) > 128) throw new Error("GIT_CONFIG_COUNT must be between 0 and 128");
    for (let index = 0; index < Number(count); index++) {
      names.add(`GIT_CONFIG_KEY_${String(index)}`);
      names.add(`GIT_CONFIG_VALUE_${String(index)}`);
    }
  }
  const env = Object.create(null) as NodeJS.ProcessEnv;
  for (const name of names) {
    const entry = value(source, name);
    if (entry !== undefined) env[name] = entry;
  }
  env.HOME ??= homedir();
  env.TMPDIR ??= tmpdir();
  if (process.platform === "win32") normalizeWindowsPaths(env);
  for (const kind of ["config", "data", "cache", "state"] as const)
    env[`WORKBENCH_${kind.toUpperCase()}_HOME`] = userDirectory(kind);
  Object.assign(env, requested.includes("PATH") ? { PATH: value(source, "PATH") ?? "" } : hostEnvironment(source));
  return env;
}

export function nativeCheckEnvironment(
  root: string,
  directory: string,
  selection: CompilerSelection = {},
  cpus = executionResources(root).cpusPerJob,
  paths: BuildPaths = buildPaths(root, directory, "native", selection),
): NodeJS.ProcessEnv {
  const base = checkBaseEnvironment(root, directory);
  const languages = checkLanguages(root, directory);
  const budgetNames = new Set([
    "WORKBENCH_CPUS",
    "WORKBENCH_CPU_BUDGET",
    ...languages.flatMap((language) => languageBudgets[language] ?? []),
  ]);
  const budget = Object.fromEntries(
    Object.entries(cpuEnvironment(cpus, base)).filter(([name]) => budgetNames.has(name)),
  );
  const env: NodeJS.ProcessEnv = {
    ...nativeEnvironment(directory, distributionRoot(root), selection, base),
    ...budget,
    ...buildEnvironment(paths, base),
    WORKBENCH_PROJECT_ROOT: root,
    WORKBENCH_DISTRIBUTION_ROOT: distributionRoot(root),
    // The selected check group already owns its workspace and toolchain selection.
    WORKBENCH_PROFILE_CONTEXT: "",
    WORKBENCH_WORKSPACE_CONTEXT: undefined,
  };
  if (languages.includes("go")) {
    env.GOENV = "off";
    env.GOTOOLCHAIN = "local";
  }
  if (languages.includes("python")) {
    env.PYTHONNOUSERSITE = "1";
    env.UV_PYTHON_DOWNLOADS = "never";
  }
  return env;
}

/** Existing manager configuration remains usable, but its bytes are explicit cache inputs. */
export function checkConfigurationFiles(root: string, directory: string, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? homedir(),
    languages = checkLanguages(root, directory);
  const config = env.XDG_CONFIG_HOME ?? join(home, ".config");
  const files = new Set([
    env.GIT_CONFIG_GLOBAL ?? join(home, ".gitconfig"),
    env.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig",
    join(config, "git/config"),
  ]);
  const add = (...paths: (string | undefined)[]) => {
    for (const path of paths) if (path) files.add(isAbsolute(path) ? path : resolve(directory, path));
  };
  for (const configured of readConfig(root).checks?.environment_files ?? []) {
    const path = configured.replace(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}/g, (_match: string, name: string) => {
      const entry = Object.hasOwn(env, name) ? env[name] : undefined;
      if (entry === undefined) throw new Error(`checks.environment_files: ${name} is not in the tool environment`);
      return entry;
    });
    if (path.includes("${") || path.includes("\0"))
      throw new Error("checks.environment_files: invalid path expression");
    files.add(isAbsolute(path) ? resolve(path) : resolve(root, path));
  }
  add(env.SSL_CERT_FILE, env.CURL_CA_BUNDLE, env.GIT_SSL_CAINFO, env.NODE_EXTRA_CA_CERTS);
  if (languages.some((language) => ["typescript", "javascript"].includes(language)))
    add(join(home, ".npmrc"), env.npm_config_userconfig, env.npm_config_globalconfig, env.NODE_EXTRA_CA_CERTS);
  if (languages.includes("python")) add(join(config, "uv/uv.toml"), "/etc/uv/uv.toml", env.UV_CONFIG_FILE);
  if (languages.includes("rust")) {
    const cargo = env.CARGO_HOME ?? join(home, ".cargo");
    add(join(cargo, "config"), join(cargo, "config.toml"), env.CARGO_HTTP_CAINFO);
    for (let parent = directory; ; parent = dirname(parent)) {
      // Missing ancestor candidates have no effect; snapshot ancestor names differ from the checkout's.
      for (const name of ["config", "config.toml"]) {
        const path = join(parent, ".cargo", name);
        if (existsSync(path)) add(path);
      }
      if (dirname(parent) === parent) break;
    }
  }
  if (languages.includes("java")) add(join(home, ".m2/settings.xml"), join(home, ".m2/toolchains.xml"));
  if (languages.includes("ruby")) add(join(home, ".gemrc"), join(home, ".bundle/config"), env.GEMRC);
  if (languages.includes("php")) {
    add(env.COMPOSER_CAFILE);
    if (env.PHPRC) add(env.PHPRC.endsWith(".ini") ? env.PHPRC : join(env.PHPRC, "php.ini"));
  }
  for (const name of ["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"]) {
    const command = env[name];
    if (!command) continue;
    const candidates =
      isAbsolute(command) || /[/\\]/.test(command)
        ? [resolve(directory, command)]
        : (env.PATH ?? "").split(delimiter).map((path) => resolve(path, command));
    const executable = candidates.find((path) => existsSync(path));
    if (!executable) throw new Error(`${name}: wrapper identity is unavailable`);
    add(executable);
  }
  return [...new Set([...files].map((path) => (isAbsolute(path) ? path : resolve(directory, path))))].sort();
}
