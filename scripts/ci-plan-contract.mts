import { compilerFamilies, isCompilerFamily } from "../app/src/core/toolchains/compiler-catalog.mjs";
import { isRecord as object, isStringArray as strings } from "../app/src/core/runtime/values.mjs";
import type { CompatibilityRuntime } from "../app/src/core/execution/ci/support/ci-contract.mjs";
import type { CIPackageJob } from "../app/src/core/execution/ci/ci-packages.ts";
interface HostedTarget extends Record<string, unknown> {
  path: string;
  paths: string[];
  msvc: boolean;
}
export interface HostedPlan {
  native: { include: (HostedTarget & { os: string; architecture: string; runner: string; node: string })[] };
  compatibility: {
    include: (HostedTarget & {
      runtime: CompatibilityRuntime;
      version: string;
      architecture?: string;
      runner?: string;
      node?: string;
      roles?: string[];
    })[];
  };
  environments: {
    include: (HostedTarget & { environment: string; architecture: string; runner: string; node: string })[];
  };
  devcontainer: { paths: string[] };
  packages?: { include: (CIPackageJob & Record<string, unknown>)[]; excluded: { id: string; reason: string }[] };
}
interface MatrixShape {
  native: { include: Record<string, unknown>[] };
  compatibility: { include: Record<string, unknown>[] };
  environments: { include: Record<string, unknown>[] };
  devcontainer: { paths: string[] };
  packages?: { include: Record<string, unknown>[]; excluded: Record<string, unknown>[] };
}
function fail(path: string): never {
  throw new Error(`Invalid CI plan: ${path}`);
}
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");
function uniqueStrings(value: unknown, path: string, nonempty = false): asserts value is string[] {
  if (!strings(value) || value.some((entry) => !text(entry)) || (nonempty && !value.length))
    fail(`${path} must contain ${nonempty ? "one or more " : ""}nonempty strings`);
  if (new Set(value).size !== value.length) fail(`${path} must not contain duplicates`);
}

/** Check the fields the workflow uses before it can expand a matrix or install tools. */
function hostedTargets(value: MatrixShape): asserts value is HostedPlan {
  for (const name of ["native", "compatibility", "environments"] as const)
    for (const [index, entry] of value[name].include.entries()) {
      const location = `${name}.include[${String(index)}]`;
      uniqueStrings(entry.paths, `${location}.paths`, true);
      if (!text(entry.path) || !entry.paths.includes(entry.path)) fail(`${location}.path must belong to paths`);
      if (typeof entry.msvc !== "boolean") fail(`${location}.msvc must be Boolean`);
      if (name === "native") {
        if (!(typeof entry.os === "string" && ["linux", "macos", "windows"].includes(entry.os)))
          fail(`${location}.os is unknown`);
        if (!(typeof entry.architecture === "string" && ["x64", "arm64"].includes(entry.architecture)))
          fail(`${location}.architecture is unknown`);
        for (const key of ["runner", "node"]) if (!text(entry[key])) fail(`${location}.${key} must be nonempty`);
      } else if (name === "compatibility") {
        if (!(
          typeof entry.runtime === "string" &&
          ["node", "python", "go", "rust", "java", "ruby", "php", ...compilerFamilies].includes(entry.runtime)
        ))
          fail(`${location}.runtime is unknown`);
        if (!text(entry.version)) fail(`${location}.version must be nonempty`);
        if (
          entry.architecture !== undefined &&
          !(typeof entry.architecture === "string" && ["x64", "arm64"].includes(entry.architecture))
        )
          fail(`${location}.architecture is unknown`);
        for (const key of ["runner", "node"])
          if (entry[key] !== undefined && !text(entry[key])) fail(`${location}.${key} must be nonempty`);
        if (entry.roles !== undefined || isCompilerFamily(entry.runtime))
          uniqueStrings(entry.roles, `${location}.roles`, true);
      } else {
        if (!(typeof entry.environment === "string" && ["nix", "guix", "nix-docker"].includes(entry.environment)))
          fail(`${location}.environment is unknown`);
        if (entry.architecture !== "x64" && entry.architecture !== "arm64") fail(`${location}.architecture is unknown`);
        for (const key of ["runner", "node"]) if (!text(entry[key])) fail(`${location}.${key} must be nonempty`);
      }
    }
  uniqueStrings(value.devcontainer.paths, "devcontainer.paths");
  if (value.packages) {
    uniqueStrings(
      value.packages.include.map(({ id }) => id),
      "packages.include IDs",
    );
    uniqueStrings(
      value.packages.excluded.map(({ id }) => id),
      "packages.excluded IDs",
    );
    for (const { reason } of value.packages.excluded)
      if (!text(reason) || !reason.trim()) fail("packages.excluded requires a reason");
    const assigned: string[] = [];
    for (const [index, job] of value.packages.include.entries()) {
      const location = `packages.include[${String(index)}]`;
      uniqueStrings(job.packages, `${location}.packages`, true);
      uniqueStrings(job.paths, `${location}.paths`, true);
      if (job.builder !== "native" && job.builder !== "nix" && job.builder !== "guix")
        fail(`${location}.builder is unknown`);
      if (job.abi !== undefined && !text(job.abi)) fail(`${location}.abi must be nonempty`);
      const paths = job.paths;
      if (
        !value.native.include.some(
          (native) =>
            native.os === job.os &&
            native.architecture === job.architecture &&
            native.runner === job.runner &&
            paths.every((path) => strings(native.paths) && native.paths.includes(path)),
        )
      )
        fail(`${location} requires a matching native runner and check roots`);
      assigned.push(...job.packages);
    }
    uniqueStrings(assigned, "Assigned release packages");
  }
}

function assertMatrix(matrix: unknown): asserts matrix is MatrixShape {
  if (!object(matrix)) fail("expected a matrix object");
  for (const name of ["native", "compatibility", "environments"] as const) {
    const group = matrix[name];
    const entries = object(group) ? group.include : undefined;
    if (!Array.isArray(entries) || !entries.every(object)) fail(`${name}.include must contain objects`);
  }
  if (!object(matrix.devcontainer) || !strings(matrix.devcontainer.paths))
    fail("devcontainer.paths must contain strings");
  if (matrix.packages !== undefined) {
    if (!object(matrix.packages)) fail("packages must be an object");
    for (const key of ["include", "excluded"] as const) {
      const entries = matrix.packages[key];
      if (!Array.isArray(entries) || !entries.every(object)) fail(`packages.${key} must contain objects`);
    }
  }
}

/** The planner and aggregate status agree on which empty groups intentionally skip. */
export function matrixJobGroups(matrix: unknown): Record<string, boolean> {
  assertMatrix(matrix);
  return {
    native: matrix.native.include.length > 0,
    environments: matrix.environments.include.length > 0,
    devcontainer: matrix.devcontainer.paths.length > 0,
    ...(matrix.packages ? { "release-packages": matrix.packages.include.length > 0 } : {}),
  };
}

/** Validate data crossing the CLI/GitHub-output boundary without changing its format. */
export function readHostedPlan(value: unknown): HostedPlan {
  assertMatrix(value);
  hostedTargets(value);
  for (const target of value.compatibility.include)
    for (const path of target.paths)
      if (
        !value.native.include.some(
          (job) =>
            job.os === "linux" && job.architecture === (target.architecture ?? "x64") && job.paths.includes(path),
        )
      )
        fail(`compatibility for ${path} requires a matching native Linux job`);
  return value;
}
