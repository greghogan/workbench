import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Worker environments are case-sensitive, including on Windows; native child processes require a canonical PATH.
if (process.platform === "win32") {
  const path = Object.entries(process.env).find(([name]) => name.toUpperCase() === "PATH")?.[1];
  if (path !== undefined) process.env.PATH = path;
}

// Node reads this setting at startup: changing it here captures child CLIs without a second worker report.
if (process.env.WORKBENCH_SUBPROCESS_COVERAGE) process.env.NODE_V8_COVERAGE = process.env.WORKBENCH_SUBPROCESS_COVERAGE;

// Fixture projects choose their own Make targets and selectors, independently of the outer gate.
for (const name of ["MAKEFLAGS", "MAKEOVERRIDES", "MFLAGS", "MAKELEVEL", "ROOT", "PROJECT", "ENVIRONMENT", "WORKBENCH"])
  delete process.env[name];

for (const name of [
  "WORKBENCH_EPHEMERAL_CHECKOUT",
  "WORKBENCH_COLLECTIONS_MATERIALIZED",
  "WORKBENCH_DISTRIBUTION_MATERIALIZED",
  "WORKBENCH_DISTRIBUTION_ROOT",
  "WORKBENCH_PROJECT_ROOT",
  "WORKBENCH_CI_TARGET",
  "WORKBENCH_CI_TARGETS",
  "WORKBENCH_CI_DOCKER",
  "CHECK_ROOTS",
  "CHECK_ENVIRONMENT",
  "RUNTIME",
  "RUNTIME_VERSION",
  "COMPILER",
  "COMPILER_VERSION",
  "CHECK_ROLES",
  "PYTHON_VERSION",
  "WORKBENCH_SHELL_ENVIRONMENT",
  "WORKBENCH_SHELL_ROOT",
  "WORKBENCH_PROFILE_CONTEXT",
  "WORKBENCH_DEVELOPMENT_PROFILE",
  "WORKBENCH_RELEASE_OUTPUT",
  "WORKBENCH_RELEASE_FORMAT",
  "WORKBENCH_RELEASE_BUILDER",
  "WORKBENCH_RELEASE_PLATFORM",
  "WORKBENCH_LOCAL_CONFIG_ROOT",
  "WORKBENCH_BUILD_DIR",
  "WORKBENCH_STORAGE_EXTERNAL",
  "WORKBENCH_STORAGE_ROOT",
  "WORKBENCH_DEPENDENCIES_DIR",
  "WORKBENCH_COVERAGE_BASE",
  "GITHUB_STEP_SUMMARY",
  "PNPM_CONFIG_VIRTUAL_STORE_DIR",
  "PNPM_CONFIG_STORE_DIR",
  "PNPM_CONFIG_VIRTUAL_STORE_TYPE",
  "UV_PROJECT_ENVIRONMENT",
  "WORKBENCH_CONTAINER_CHECKOUT",
  "CARGO_TARGET_DIR",
  "PYTHONPYCACHEPREFIX",
  "MYPY_CACHE_DIR",
  "RUFF_CACHE_DIR",
  "PYTEST_ADDOPTS",
  "COVERAGE_FILE",
  "UV_BUILD_OUT_DIR",
])
  delete process.env[name];

// Tests and their CLI subprocesses must not inspect or alter a developer's tool installations.
const storage = mkdtempSync(join(tmpdir(), "workbench-test-storage-"));
process.env.WORKBENCH_CONFIG_HOME = join(storage, "config");
process.env.WORKBENCH_DATA_HOME = join(storage, "data");
process.env.WORKBENCH_CACHE_HOME = join(storage, "cache");
// Local policy discovery must not inherit standards installed on the test host.
process.env.XDG_DATA_DIRS = join(storage, "system");
afterAll(() => rmSync(storage, { recursive: true, force: true }));
