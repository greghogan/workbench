import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Fixture projects choose their own Make targets and selectors, independently of the outer gate.
for (const name of ["MAKEFLAGS", "MAKEOVERRIDES", "MFLAGS", "MAKELEVEL", "ROOT", "PROJECT", "ENVIRONMENT", "WORKBENCH"])
  delete process.env[name];

for (const name of [
  "WORKBENCH_EPHEMERAL_CHECKOUT",
  "WORKBENCH_SHELL_ENVIRONMENT",
  "WORKBENCH_SHELL_ROOT",
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
afterAll(() => rmSync(storage, { recursive: true, force: true }));
