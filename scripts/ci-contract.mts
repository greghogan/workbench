export type CompilerRuntime = "clang" | "gcc";
export type StandaloneRuntime = "node" | "go" | "rust" | "python" | "java" | "ruby" | "php";
export type CompatibilityRuntime = CompilerRuntime | StandaloneRuntime;
export type CIPhase =
  | "native-install"
  | "native-check"
  | "release"
  | "compiler-install"
  | "compiler"
  | "python"
  | "compatibility"
  | "environment";
interface NoRuntime {
  runtime?: never;
  version?: never;
  roles?: never;
}
export type TargetSelection =
  | ({ kind: "native"; release: boolean; toolchain?: string } & NoRuntime)
  | ({ kind: "environment"; release: false } & NoRuntime)
  | { kind: "compatibility"; runtime: CompilerRuntime; version: string; roles: string[]; release: false }
  | { kind: "compatibility"; runtime: StandaloneRuntime; version: string; roles: string[]; release: false };
export const compilerCompatibilityRoles: string[] = ["test", "sanitizers", "lto"];

/** These phases are also the installation/cache boundaries used by hosted CI. */
export function targetPhases(target: TargetSelection): CIPhase[] {
  const kind: string = target.kind;
  if (target.kind === "native")
    return target.release ? ["native-install", "native-check", "release"] : ["native-install", "native-check"];
  if (target.kind === "environment") return ["environment"];
  if (kind !== "compatibility") throw new Error(`Unknown CI target kind: ${kind}`);
  if (["clang", "gcc"].includes(target.runtime)) return ["compiler-install", "compiler"];
  if (target.runtime === "python") return ["python"];
  if (["node", "go", "rust", "java", "ruby", "php"].includes(target.runtime)) return ["compatibility"];
  throw new Error(`Unknown compatibility runtime: ${target.runtime}`);
}

export function targetEnvironment(
  target: TargetSelection & { id: string; path: string; environment: string },
): Record<string, string> {
  return {
    WORKBENCH_CI_TARGET: target.id,
    CHECK_ROOTS: JSON.stringify([target.path]),
    ...(target.kind === "native" && target.toolchain ? { CHECK_TOOLCHAIN: target.toolchain } : {}),
    ...(target.kind === "environment" ? { CHECK_ENVIRONMENT: target.environment } : {}),
    ...(target.kind === "compatibility"
      ? {
          RUNTIME: target.runtime,
          RUNTIME_VERSION: target.version,
          COMPILER: target.runtime,
          COMPILER_VERSION: target.version,
          CHECK_ROLES: JSON.stringify(target.roles),
          PYTHON_VERSION: target.version,
        }
      : {}),
  };
}

import type { CITarget } from "../src/ci-targets.js";
import { records, string, strings } from "./values.mjs";

/** The hosted and container adapters consume the same configured target contract. */
export function readCITargets(value: unknown): CITarget[] {
  return records(value, "Invalid CI targets").map((entry) => {
    const context = "Invalid CI target";
    const kind = string(entry.kind, context);
    if (typeof entry.release !== "boolean") throw new Error(context);
    let selection: TargetSelection;
    if (kind === "native")
      selection = {
        kind,
        release: entry.release,
        ...(entry.toolchain === undefined ? {} : { toolchain: string(entry.toolchain, context) }),
      };
    else if (kind === "environment" && !entry.release) selection = { kind, release: false };
    else if (kind === "compatibility" && !entry.release) {
      const runtime = string(entry.runtime, context);
      if (
        runtime !== "node" &&
        runtime !== "python" &&
        runtime !== "go" &&
        runtime !== "rust" &&
        runtime !== "java" &&
        runtime !== "ruby" &&
        runtime !== "php" &&
        runtime !== "clang" &&
        runtime !== "gcc"
      )
        throw new Error(context);
      selection = {
        kind,
        release: false,
        runtime,
        version: string(entry.version, context),
        roles: strings(entry.roles, context),
      };
    } else throw new Error(context);
    const phases = targetPhases(selection);
    if (JSON.stringify(entry.phases) !== JSON.stringify(phases)) throw new Error("Invalid CI target phases");
    return {
      ...selection,
      id: string(entry.id, context),
      path: string(entry.path, context),
      os: string(entry.os, context),
      architecture: string(entry.architecture, context),
      environment: string(entry.environment, context),
      phases,
      checks: records(entry.checks, context).map((check) => ({
        name: string(check.name, context),
        role: string(check.role, context),
        command: strings(check.command, context),
        source: check.source === undefined ? undefined : string(check.source, context),
      })),
    };
  });
}
