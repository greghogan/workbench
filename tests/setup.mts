import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Hooks export repository-specific locations; fixture repositories own their Git context.
for (const name of [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
])
  Reflect.deleteProperty(process.env, name);

// Fixture Git behavior must not inherit a developer's hooks, signing, or global ignore rules.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

// Worker environments are case-sensitive, including on Windows; native child processes require a canonical PATH.
if (process.platform === "win32") {
  const path = Object.entries(process.env).find(([name]) => name.toUpperCase() === "PATH")?.[1];
  if (path !== undefined) process.env.PATH = path;
  // Git canonicalizes DOS short names; fixtures and source maps need the same path spelling.
  const temporary = realpathSync.native(tmpdir());
  process.env.TMP = temporary;
  process.env.TEMP = temporary;
  // Fixture repositories deliberately ignore global Git configuration. Retain the
  // platform checkout contract used by the hosted workflow in their isolated environment.
  process.env.GIT_CONFIG_COUNT = "3";
  process.env.GIT_CONFIG_KEY_0 = "core.symlinks";
  process.env.GIT_CONFIG_VALUE_0 = "true";
  process.env.GIT_CONFIG_KEY_1 = "core.autocrlf";
  process.env.GIT_CONFIG_VALUE_1 = "false";
  process.env.GIT_CONFIG_KEY_2 = "core.longpaths";
  process.env.GIT_CONFIG_VALUE_2 = "true";
}

// Node reads this setting at startup: changing it here captures child CLIs without a second worker report.
if (process.env.WORKBENCH_SUBPROCESS_COVERAGE) process.env.NODE_V8_COVERAGE = process.env.WORKBENCH_SUBPROCESS_COVERAGE;

// Fixture projects choose their own Make targets and selectors, independently of the outer gate.
for (const name of ["MAKEFLAGS", "MAKEOVERRIDES", "MFLAGS", "MAKELEVEL", "ROOT", "PROJECT", "ENVIRONMENT", "WORKBENCH"])
  Reflect.deleteProperty(process.env, name);

const inheritedOptions = new Set(
  [
    "WORKBENCH_OFFLINE",
    "WORKBENCH_CHECK_INPUTS",
    "WORKBENCH_CHECK_INPUT_ROOT",
    "WORKBENCH_MANAGED_COMPILER",
    "WORKBENCH_ENVIRONMENTS",
    "npm_config_offline",
    "npm_config_registry",
    "PNPM_CONFIG_REGISTRY",
    "UV_OFFLINE",
    "UV_NO_INDEX",
    "UV_FIND_LINKS",
    "GOPROXY",
    "GOSUMDB",
    "GOTOOLCHAIN",
    "CARGO_NET_OFFLINE",
    "COMPOSER_DISABLE_NETWORK",
    "MAVEN_ARGS",
    "WORKBENCH_EXECUTING_SPEC",
    "WORKBENCH_PREPARED",
    "WORKBENCH_DEVCONTAINER",
    "WORKBENCH_GUIX_TIME_MACHINE_PROFILE",
    "WORKBENCH_TOOLCHAIN",
    "WORKBENCH_TOOLCHAIN_ROOT",
    "PNPM_CONFIG_OFFLINE",
    "WORKBENCH_EPHEMERAL_CHECKOUT",
    "WORKBENCH_COLLECTIONS_MATERIALIZED",
    "WORKBENCH_DISTRIBUTION_MATERIALIZED",
    "WORKBENCH_DISTRIBUTION_ROOT",
    "WORKBENCH_PROJECT_ROOT",
    "WORKBENCH_CI_TARGET",
    "WORKBENCH_CI_TARGETS",
    "WORKBENCH_CHECK_EVENTS",
    "WORKBENCH_CHECK_DETAILS",
    "WORKBENCH_MAX_JOBS",
    "WORKBENCH_CPU_BUDGET",
    "WORKBENCH_CI_DOCKER",
    "CHECK_ROOTS",
    "CHECK_TOOLCHAIN",
    "CHECK_ENVIRONMENT",
    "RUNTIME",
    "RUNTIME_VERSION",
    "COMPILER",
    "COMPILER_VERSION",
    "CHECK_ROLES",
    "PYTHON_VERSION",
    "WORKBENCH_SHELL_ENVIRONMENT",
    "WORKBENCH_SHELL_ROOT",
    "WORKBENCH_SHELL_NODE",
    "WORKBENCH_SHELL_LABEL",
    "WORKBENCH_PROFILE_CONTEXT",
    "WORKBENCH_WORKSPACE_CONTEXT",
    "WORKBENCH_POLICY_REVIEW",
    "WORKBENCH_DEVELOPMENT_PROFILE",
    "WORKBENCH_RELEASE_OUTPUT",
    "WORKBENCH_RELEASE_FORMAT",
    "WORKBENCH_RELEASE_BUILDER",
    "WORKBENCH_RELEASE_PLATFORM",
    "WORKBENCH_LOCAL_CONFIG_ROOT",
    "WORKBENCH_BUILD_DIR",
    "WORKBENCH_DIST_DIR",
    "WORKBENCH_RELEASE_ARTIFACT",
    "WORKBENCH_STORAGE_EXTERNAL",
    "WORKBENCH_STORAGE_ROOT",
    "WORKBENCH_STORAGE_PROJECT",
    "WORKBENCH_DEPENDENCIES_DIR",
    "WORKBENCH_COVERAGE_BASE",
    "GITHUB_STEP_SUMMARY",
    "PNPM_CONFIG_VIRTUAL_STORE_DIR",
    "PNPM_CONFIG_STORE_DIR",
    "PNPM_CONFIG_VIRTUAL_STORE_TYPE",
    "UV_PROJECT_ENVIRONMENT",
    "WORKBENCH_CONTAINER_CHECKOUT",
    "WORKBENCH_LOCAL_CI_IMAGE",
    "CARGO_TARGET_DIR",
    "PYTHONPYCACHEPREFIX",
    "MYPY_CACHE_DIR",
    "RUFF_CACHE_DIR",
    "PYTEST_ADDOPTS",
    "COVERAGE_FILE",
    "UV_BUILD_OUT_DIR",
    "npm_execpath",
  ].map((name) => name.toUpperCase()),
);
for (const name of Object.keys(process.env))
  if (inheritedOptions.has(name.toUpperCase())) Reflect.deleteProperty(process.env, name);

// Tests and their CLI subprocesses must not inspect or alter a developer's tool installations.
const storage = mkdtempSync(join(tmpdir(), "workbench-test-storage-"));
process.env.WORKBENCH_CONFIG_HOME = join(storage, "config");
process.env.WORKBENCH_DATA_HOME = join(storage, "data");
process.env.WORKBENCH_CACHE_HOME = join(storage, "cache");
process.env.WORKBENCH_STATE_HOME = join(storage, "state");
process.env.RUSTUP_HOME = join(storage, "rustup");
process.env.UV_PYTHON_INSTALL_DIR = join(storage, "python");
process.env.GUIX_STATE_DIRECTORY = join(storage, "guix");
// Cache inspection must not inventory or mutate the developer's Docker engine from CLI fixtures.
process.env.DOCKER_CONFIG = join(storage, "docker");
delete process.env.DOCKER_CONTEXT;
process.env.DOCKER_HOST =
  process.platform === "win32"
    ? `npipe:////./pipe/workbench-tests-${String(process.pid)}`
    : `unix://${join(storage, "docker.sock")}`;
// The test matrix exercises this interpreter. CLI fixtures must retain it rather than acquire another SDK.
process.env.WORKBENCH_COMPATIBILITY_RUNTIME = "node";
process.env.WORKBENCH_COMPATIBILITY_VERSION = process.versions.node;
// Local policy discovery must not inherit standards installed on the test host.
process.env.XDG_DATA_DIRS = join(storage, "system");
afterAll(() => {
  rmSync(storage, { recursive: true, force: true });
});
