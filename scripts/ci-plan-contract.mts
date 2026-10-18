import { isRecord as object, isStringArray as strings } from "./values.mjs";
import type { CompatibilityRuntime } from "./ci-contract.mjs";
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
  environments: { include: (HostedTarget & { environment: string; node: string })[] };
  devcontainer: { paths: string[] };
}
interface MatrixShape {
  native: { include: Record<string, unknown>[] };
  compatibility: { include: Record<string, unknown>[] };
  environments: { include: Record<string, unknown>[] };
  devcontainer: { paths: string[] };
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
          ["node", "python", "go", "rust", "java", "ruby", "php", "clang", "gcc"].includes(entry.runtime)
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
        if (entry.roles !== undefined || entry.runtime === "clang" || entry.runtime === "gcc")
          uniqueStrings(entry.roles, `${location}.roles`, true);
      } else {
        if (!(typeof entry.environment === "string" && ["nix", "guix", "nix-docker"].includes(entry.environment)))
          fail(`${location}.environment is unknown`);
        if (!text(entry.node)) fail(`${location}.node must be nonempty`);
      }
    }
  uniqueStrings(value.devcontainer.paths, "devcontainer.paths");
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
}

/** The planner and aggregate status agree on which empty groups intentionally skip. */
export function matrixJobGroups(matrix: unknown): Record<"native" | "environments" | "devcontainer", boolean> {
  assertMatrix(matrix);
  return {
    native: matrix.native.include.length > 0,
    environments: matrix.environments.include.length > 0,
    devcontainer: matrix.devcontainer.paths.length > 0,
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
