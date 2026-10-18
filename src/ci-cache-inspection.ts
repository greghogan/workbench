import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { distributionRoot, readConfig } from "./core.js";
import { nativeInstallationPlan, type NativeToolSelection } from "./native-tools.js";
import { compatibilityRuntimePlan } from "./ci-runtime.js";
import { packageManagerInstallationPlan } from "./package-manager.js";
import { distributionInputHash } from "./distribution-manifest.js";
import { required } from "./invariants.js";

export interface CacheInspectionRequest {
  target: {
    paths?: string[];
    selections?: { path: string; toolchain?: string }[];
    runtime?: string;
    version?: string;
    environment?: string;
  };
  sources: string[];
}

/** Resolve hosted cache inputs once, using the same read-only planners as installation. */
export function inspectCICache(root: string, { target, sources }: CacheInspectionRequest) {
  const distribution = distributionRoot(root);
  const paths = target.paths ?? ["."];
  const runtimeOnly = ["node", "go", "java", "ruby", "php"].includes(target.runtime ?? "");
  const managed = target.environment && target.environment !== "devcontainer";
  const selections: { path: string; toolchain?: string }[] =
    runtimeOnly || managed ? [] : (target.selections ?? paths.map((path) => ({ path })));
  const compiler: NativeToolSelection = ["clang", "gcc"].includes(target.runtime ?? "")
    ? {
        compiler: required(target.runtime, "compiler runtime"),
        compilerVersion: required(target.version, "compiler version"),
      }
    : {};
  const native = selections.map(({ path, toolchain }) => ({
    path,
    toolchain,
    plan: nativeInstallationPlan(root, path, {
      ...compiler,
      ...(toolchain ? { toolchain } : {}),
      excludeTool: ["miri"],
    }),
  }));
  const defaults = paths.map((path) => ({
    path,
    plan:
      target.environment === "devcontainer" || (!managed && !target.runtime) || target.runtime === "java"
        ? (native.find((entry) => entry.path === path && !entry.toolchain && !compiler.compiler)?.plan ??
          nativeInstallationPlan(root, path, { excludeTool: ["miri"] }))
        : [],
  }));
  return {
    retention: readConfig(root).ci?.cache?.artifacts ?? {},
    native,
    defaults,
    runtimes: runtimeOnly
      ? paths.map((path) => ({
          path,
          plan: compatibilityRuntimePlan(
            root,
            path,
            required(target.runtime, "compatibility runtime"),
            required(target.version, "compatibility version"),
          ),
        }))
      : [],
    managers: paths
      .filter(
        (path) =>
          (!target.runtime || target.runtime === "node") && !managed && existsSync(resolve(root, path, "package.json")),
      )
      .map((path) => packageManagerInstallationPlan(resolve(root, path), distribution)),
    sources: Object.fromEntries(sources.map((path) => [path, distributionInputHash(distribution, path)])),
  };
}
