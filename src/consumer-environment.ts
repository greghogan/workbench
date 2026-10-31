import { join, delimiter } from "node:path";
import { checkHostPath } from "./check-environment.js";
import type { VerifiedWorkbenchPackage } from "./package-verify.js";
/** Use a clean consumer context while reusing only the explicitly selected, verified tool/download cache. */
export function consumerEnvironment(installed: VerifiedWorkbenchPackage, cache: string): NodeJS.ProcessEnv {
  const env = { ...installed.environment };
  const budgets = Object.fromEntries(
    Object.entries(env).filter(([name]) =>
      ["WORKBENCH_CPUS", "WORKBENCH_CPU_BUDGET", "WORKBENCH_MAX_JOBS"].includes(name),
    ),
  );
  for (const name of Object.keys(env))
    if (
      /^(?:WORKBENCH_|GIT_|NODE_OPTIONS$|NODE_V8_COVERAGE$|MAKEFLAGS$|MAKEOVERRIDES$|MFLAGS$|MAKELEVEL$|ROOT$|PROJECT$|ENVIRONMENT$|CHECK_|RUNTIME|COMPILER|PNPM_CONFIG_|npm_config_|GUIX_ENVIRONMENT$|IN_NIX_SHELL$|RUSTUP_|CARGO_|UV_|GEM_|BUNDLE_|COMPOSER_|MAVEN_|JAVA_HOME$|PYTHON|GOPATH$|GOMODCACHE$|GOCACHE$|GOPROXY$|GOSUMDB$|GOFLAGS$|GOTOOLCHAIN$)/i.test(
        name,
      )
    )
      Reflect.deleteProperty(env, name);
  for (const kind of ["config", "data", "state"])
    env[`WORKBENCH_${kind.toUpperCase()}_HOME`] = join(installed.temporary, kind);
  env.WORKBENCH_CACHE_HOME = cache;
  Object.assign(env, budgets);
  env.RUSTUP_HOME = join(cache, "consumer-toolchains", "rustup");
  env.CARGO_HOME = join(cache, "consumer-toolchains", "cargo");
  env.UV_PYTHON_INSTALL_DIR = join(cache, "consumer-toolchains", "python");
  env.WORKBENCH_STORAGE_EXTERNAL = "true";
  env.WORKBENCH_STORAGE_ROOT = join(installed.temporary, "build-cache");
  const hostPath = checkHostPath(env, installed.languages);
  for (const name of Object.keys(env)) if (name.toUpperCase() === "PATH") Reflect.deleteProperty(env, name);
  env.PATH = [process.platform === "win32" ? installed.prefix : join(installed.prefix, "bin"), hostPath].join(
    delimiter,
  );
  env.GIT_CONFIG_GLOBAL = join(installed.temporary, "gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_COUNT = "4";
  for (const [index, [name, value]] of [
    ["core.autocrlf", "false"],
    ["core.symlinks", "true"],
    ["commit.gpgsign", "false"],
    ["core.longpaths", "true"],
  ].entries()) {
    env[`GIT_CONFIG_KEY_${String(index)}`] = name;
    env[`GIT_CONFIG_VALUE_${String(index)}`] = value;
  }
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "Workbench integration fixture";
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = "integration@example.invalid";
  env.npm_config_cache = join(installed.temporary, "npm-cache");
  return env;
}
