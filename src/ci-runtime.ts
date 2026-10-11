import { delimiter, dirname, join, resolve } from "node:path";
import { ciMatrix } from "./ci.js";
import { distributionRoot } from "./core.js";
import { assetFor, toolDirectory } from "./native-assets.js";
import { ensureRustup, installNativeTools, nativeEnvironment, verifyInstalledTool } from "./native-tools.js";
import { acquisitionIdentity } from "./artifact-policy.js";
import { execute, installAsset } from "./tool-downloads.js";
import { required } from "./invariants.js";
import { buildPaths, prepareBuild, buildEnvironment, withBuildLock } from "./builds.js";
import { executionEnvironment } from "./execution-resources.js";
import { compatibilityArguments, compatibilityChecks } from "./compatibility-checks.js";
import { resolveCheckCommand } from "./toolchains.js";

/** Compatibility selection comes from the committed matrix, never arbitrary download arguments. */
export function compatibilityRuntimePlan(root: string, path: string, runtime: string, version: string) {
  if (
    !ciMatrix(root).compatibility.include.some(
      (target) => target.path === path && target.runtime === runtime && target.version === version,
    )
  )
    throw new Error(`${path}: ${runtime} ${version} is not a configured compatibility target`);
  const tool = { name: runtime, version, source: "configured CI compatibility target" };
  if (["rust", "python"].includes(runtime)) return { tool };
  if (!["node", "go", "java", "ruby", "php"].includes(runtime))
    throw new Error(`unsupported standalone compatibility runtime '${runtime}'`);
  const asset = required(
    assetFor(distributionRoot(root), tool),
    `no verified ${runtime} ${version} compatibility artifact`,
  );
  return { tool, asset, directory: toolDirectory(tool, asset), policy: acquisitionIdentity(asset) };
}

async function withCompatibilityRuntime(
  root: string,
  path: string,
  runtime: string,
  version: string,
  action: (directory: string, env: NodeJS.ProcessEnv) => void,
) {
  const plan = compatibilityRuntimePlan(root, path, runtime, version);
  const directory = resolve(root, path);
  const distribution = distributionRoot(root);
  if (runtime === "python") await installNativeTools(root, path, {}, "uv");
  if (runtime === "java") await installNativeTools(root, path, {}, "maven");
  let env = { ...nativeEnvironment(directory, distribution), ...executionEnvironment(root) };
  if (plan.asset) {
    await installAsset(required(plan.directory, "runtime installation directory"), plan.asset);
    env.PATH = `${join(required(plan.directory, "runtime installation directory"), plan.asset.bin)}${delimiter}${env.PATH ?? ""}`;
    if (runtime === "go") {
      env.GOROOT = plan.directory;
      env.GOTOOLCHAIN = "local";
      env.GOFLAGS = `${env.GOFLAGS ?? ""} -mod=readonly`.trim();
    }
    if (runtime === "java")
      env.JAVA_HOME = resolve(required(plan.directory, "Java installation directory"), plan.asset.bin, "..");
    verifyInstalledTool(directory, plan.tool, plan.asset, plan.directory, env);
  } else if (runtime === "rust") {
    env = await ensureRustup(distribution, env);
    env.RUSTUP_TOOLCHAIN = version;
    execute("rustup", ["toolchain", "install", version, "--no-self-update", "--profile", "minimal"], {
      cwd: directory,
      env,
    });
    verifyInstalledTool(directory, plan.tool, undefined, undefined, env, "compatibility");
  } else {
    execute("uv", ["python", "install", version], { cwd: directory, env });
    const python = execute("uv", ["python", "find", "--managed-python", "--system", version], {
      cwd: directory,
      env,
      capture: true,
    }).trim();
    if (!python) throw new Error(`uv did not resolve Python ${version}`);
    env.PATH = `${dirname(python)}${delimiter}${env.PATH ?? ""}`;
    env.WORKBENCH_PYTHON = python;
    env.UV_PYTHON = version;
    env.UV_PYTHON_DOWNLOADS = "never";
    verifyInstalledTool(directory, plan.tool, undefined, undefined, env);
  }
  const paths = buildPaths(root, directory, "native", {}, true, { name: runtime, version });
  withBuildLock(paths, () => {
    prepareBuild(paths);
    action(directory, {
      ...env,
      ...buildEnvironment(paths),
      WORKBENCH_PROJECT_ROOT: root,
      WORKBENCH_DISTRIBUTION_ROOT: distribution,
      WORKBENCH_COMPATIBILITY_RUNTIME: runtime,
      WORKBENCH_COMPATIBILITY_VERSION: version,
    });
  });
}

export async function executeCompatibilityRuntime(
  root: string,
  path: string,
  runtime: string,
  version: string,
  command: string[],
) {
  const executable = required(command[0], "compatibility runtime requires a command");
  await withCompatibilityRuntime(root, path, runtime, version, (_directory, env) => {
    execute(executable, command.slice(1), { cwd: root, env });
  });
}

export async function runCompatibilityChecks(root: string, path: string, runtime: string, version: string) {
  const checks = compatibilityChecks(root, path);
  await withCompatibilityRuntime(root, path, runtime, version, (directory, env) => {
    for (const check of checks) {
      let command = resolveCheckCommand(
        directory,
        compatibilityArguments(check.command, runtime, version),
        distributionRoot(root),
      );
      if (check.role === "compatibility-setup")
        command = ["node", join(distributionRoot(root), "bin/workbench.mjs"), "dependency-setup", "--", ...command];
      console.log(`Running configured compatibility check '${check.name}'...`);
      execute(required(command[0], "compatibility command"), command.slice(1), { cwd: directory, env });
    }
  });
}
