import { recordNativeArtifact } from "./native-artifact-records.js";
import { withConfigurationSnapshot } from "./configuration-snapshot.js";
import { currentExecutionEnvironment } from "./execution-context.js";
import { toolAdapter } from "./tool-adapters.js";
import { MicrosoftSDKResolver, microsoftEnvironment, resolveMicrosoftSDK, type ResolvedMicrosoftSDK } from "./mvsc.js";
import { resolveNativeTool, type NativeInstallation } from "./native-installation.js";
import { installContainerCLI } from "./container-tools.js";
import { required } from "./invariants.js";
import { existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { distributionRoot } from "./project-context.js";
import { readLanguageRoots } from "./project-configuration.js";
import { readText, readToml, safeRelative } from "./files.js";
import { exactVersion, guardToolchains } from "./toolchains.js";
import { installAsset, type ToolAsset } from "./tool-downloads.js";
import { execute } from "./tool-execution.js";
import { compilerEnvironment, type CompilerSelection } from "./compilers.js";
import { acquisitionIdentity } from "./artifact-policy.js";
import { nativeTools, assetFor, toolDirectory, type Tool } from "./native-assets.js";
import { NativeToolUnavailable, probePrelude, probeScript, toolProbes } from "./tool-probes.js";
import { assertAssetHost } from "./tool-host.js";
import { toolProfile, toolProfileEnvironment } from "./tool-profiles.js";
import { withToolCacheUse, withToolCacheUseAsync } from "./tool-cache-lock.js";
import { toolRequirement } from "./tool-requirements.js";
import { managerInstallations, recordManagerInstallations } from "./managed-installations.js";
import { invalidateCacheSize } from "./cache-size.js";

export type NativeToolSelection = CompilerSelection & { excludeTool?: string[] };

/** Read-only selection requires verified managed artifacts; provisioning may inspect an incomplete installation. */
export function nativeEnvironment(
  directory: string,
  distribution: string,
  selection: CompilerSelection = {},
  base: NodeJS.ProcessEnv = currentExecutionEnvironment(),
  microsoft?: ResolvedMicrosoftSDK,
  provisioning = false,
): NodeJS.ProcessEnv {
  const env = {
    ...base,
    ...toolProfileEnvironment(directory, selection.toolchain),
    ...compilerEnvironment(directory, selection),
  };
  // Node forwards only the first case-insensitive PATH key to Windows children.
  // Plain object environments must remove inherited `Path` before adding the selected tools.
  if (process.platform === "win32") {
    const inherited = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1];
    for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") Reflect.deleteProperty(env, key);
    env.PATH = inherited;
  }
  delete env.WORKBENCH_CC;
  delete env.WORKBENCH_CXX;
  const paths: string[] = [];
  let rustBin: string | undefined;
  const tools = nativeTools(directory, distribution, selection);
  for (const tool of tools) {
    if (
      tool.name === "node" &&
      (tool.source === "Workbench .node-version" ||
        (env.WORKBENCH_COMPATIBILITY_RUNTIME === "node" &&
          env.WORKBENCH_COMPATIBILITY_VERSION === process.versions.node &&
          tool.version === process.versions.node))
    ) {
      // Workbench keeps its running interpreter when the consumer has no Node pin, or explicitly tests this runtime.
      // Never rediscover that interpreter through the caller's PATH.
      paths.push(dirname(process.execPath));
      continue;
    }
    const adapter = toolAdapter(tool);
    if (adapter.environment === "rustup") {
      rustBin = join(env.CARGO_HOME ?? join(homedir(), ".cargo"), "bin");
      if (tool.name === "rust") env.RUSTUP_TOOLCHAIN = tool.version;
    } else if (adapter.environment === "artifact") {
      const installation = resolveNativeTool(distribution, directory, tool);
      const asset = installation.provider === "artifact" ? installation.asset : undefined;
      if (!asset && !provisioning)
        throw new NativeToolUnavailable(
          `Pinned ${tool.name} ${tool.version} has no verified artifact metadata; restore its installation metadata or add a reviewed artifact definition. System PATH fallback is disabled.`,
        );
      if (asset) {
        const directory = toolDirectory(tool, asset);
        const receipt = join(directory, ".workbench-artifact");
        if (existsSync(receipt) && readText(receipt).trim() === asset.sha256) {
          assertAssetHost(asset);
          if (!provisioning) for (const probe of toolProbes(tool)) artifactExecutable(directory, asset, probe);
          if (adapter.artifactEnvironment === "php" && process.platform === "win32") {
            env.PHPRC = directory;
            env.PHP_INI_SCAN_DIR = "";
          }
          if (adapter.artifactEnvironment === "compiler") {
            env.WORKBENCH_CC = join(directory, asset.bin, tool.name === "gcc" ? "gcc" : "clang");
            env.WORKBENCH_CXX = join(directory, asset.bin, tool.name === "gcc" ? "g++" : "clang++");
            if (tool.name === "gcc") {
              paths.unshift(join(directory, asset.bin));
              env.LD_LIBRARY_PATH = [join(directory, "lib64"), join(directory, "lib"), env.LD_LIBRARY_PATH ?? ""]
                .filter(Boolean)
                .join(delimiter);
            }
          } else if (adapter.artifactEnvironment === "libraries") {
            env.LD_LIBRARY_PATH = [join(directory, asset.bin), env.LD_LIBRARY_PATH ?? ""]
              .filter(Boolean)
              .join(delimiter);
          } else paths.push(join(directory, asset.bin));
          if (adapter.artifactEnvironment === "go") env.GOROOT = directory;
          if (adapter.artifactEnvironment === "java") env.JAVA_HOME = resolve(directory, asset.bin, "..");
          if (adapter.artifactEnvironment === "llvm") {
            if (process.platform === "win32") {
              const runtime = join(directory, "lib", "clang", tool.version.split(".")[0] ?? "", "lib", "windows");
              // ASan DLLs must match the selected compiler, ahead of the host SDK's copies.
              if (existsSync(runtime)) paths.push(runtime);
            }
            for (const name of [
              "CPATH",
              "C_INCLUDE_PATH",
              "CPLUS_INCLUDE_PATH",
              "OBJC_INCLUDE_PATH",
              "OBJCPLUS_INCLUDE_PATH",
              "LIBRARY_PATH",
              "LD_LIBRARY_PATH",
              "GCC_EXEC_PREFIX",
              "CMAKE_PREFIX_PATH",
            ]) {
              if (env[name])
                env[name] = env[name]
                  .split(delimiter)
                  .filter((path) => !/\/gnu\/store\/|\/nix\/store\/|\/\.guix-profile\//.test(`${path}/`))
                  .join(delimiter);
              if (!env[name]) Reflect.deleteProperty(env, name);
            }
          }
        } else if (!provisioning) {
          throw new NativeToolUnavailable(
            `Pinned ${tool.name} ${tool.version} is not installed in its managed cache; run workbench tools install. System PATH fallback is disabled.`,
          );
        }
      }
    }
  }
  env.PATH = [...paths, ...(rustBin ? [rustBin] : []), env.PATH ?? ""].join(delimiter);
  const python = tools.find((tool) => tool.name === "python");
  if (python) {
    const found = spawnSync("uv", ["python", "find", "--managed-python", "--system", python.version], {
      env: { ...env, UV_PYTHON_DOWNLOADS: "never" },
      encoding: "utf8",
    });
    if (found.status === 0 && found.stdout.trim()) {
      env.WORKBENCH_PYTHON = found.stdout.trim();
      env.PATH = `${dirname(found.stdout.trim())}${delimiter}${env.PATH}`;
    }
  }
  const microsoftVersion = tools.find((tool) => tool.name === "mvsc")?.version;
  if (!microsoftVersion) return env;
  const prepared = microsoftEnvironment(
    microsoft ?? resolveMicrosoftSDK(directory, microsoftVersion, base),
    env,
    env.WORKBENCH_COMPILER === "clang" ? paths : [],
  );
  // Microsoft supplies Clang's target SDK, while the selected LLVM installation remains the compiler authority.
  if (env.WORKBENCH_COMPILER === "clang") {
    prepared.WORKBENCH_CC = env.WORKBENCH_CC;
    prepared.WORKBENCH_CXX = env.WORKBENCH_CXX;
  }
  return prepared;
}

function roots(root: string, selected?: string): string[] {
  const paths = [...new Set(readLanguageRoots(root).map((entry) => entry.path))];
  if (selected !== undefined && !paths.includes(selected))
    throw new Error(`--path must name a registered language root: '${selected}'`);
  return selected === undefined ? paths : [selected];
}

/** Resolve declarations and artifact metadata once; inspection projects this same installation plan. */
function resolveNativeInstallation(
  root: string,
  selected?: string,
  selection: NativeToolSelection = {},
  onlyTool?: string,
) {
  if (onlyTool !== undefined && selection.excludeTool?.length) throw new Error("select --tool or --exclude-tool");
  const distribution = distributionRoot(root);
  const profile = toolProfile(root, selection.toolchain);
  if (profile && selected !== undefined && !profile.paths.includes(selected))
    throw new Error(`tool profile '${profile.name}' does not select '${selected}'`);
  return roots(root, selected)
    .filter((path) => !profile || profile.paths.includes(path))
    .map((path) => {
      const directory = resolve(root, path);
      const declared = nativeTools(directory, distribution, selection);
      if (onlyTool !== undefined && !declared.some((tool) => tool.name === onlyTool))
        throw new Error(`${path}: no declared native tool '${onlyTool}'`);
      const dependencies =
        onlyTool === undefined
          ? []
          : toolAdapter({ name: onlyTool, version: "", source: "tool selection" }).dependencies;
      const tools = declared
        .filter((tool) => !selection.excludeTool?.includes(tool.name))
        .filter((tool) => onlyTool === undefined || tool.name === onlyTool || dependencies.includes(tool.name))
        .map((tool) => resolveNativeTool(distribution, directory, tool));
      return { path, directory, declared, tools };
    });
}

export function nativeInstallationPlan(root: string, selected?: string, selection: NativeToolSelection = {}) {
  return resolveNativeInstallation(root, selected, selection).flatMap(({ path, tools }) =>
    tools.map((installation) => installationPlan(path, installation)),
  );
}

function installationPlan(path: string, { tool, asset, destination, provider }: NativeInstallation) {
  return {
    root: path,
    tool: tool.name,
    version: tool.version,
    ...(asset
      ? {
          directory: required(destination, "artifact destination"),
          filtered: Boolean(asset.filter),
          policy: acquisitionIdentity(asset),
        }
      : { manager: provider }),
  };
}

export const NativeArtifactState = {
  Installed: "installed",
  Mismatch: "receipt mismatch",
  Incomplete: "incomplete installation",
  Missing: "not installed",
} as const;
export type NativeArtifactState = (typeof NativeArtifactState)[keyof typeof NativeArtifactState];
export interface NativeArtifactInspection {
  state: NativeArtifactState;
  binPaths: string[];
  executables: { name: string; path: string }[];
  verification: string;
}

/** Inventory belongs to inspection; maintenance can call the shared planner while holding admission. */
export function nativeToolInspection(root: string, selected?: string, selection: NativeToolSelection = {}) {
  return withToolCacheUse(() =>
    resolveNativeInstallation(root, selected, selection).flatMap(({ path, tools }) =>
      tools.map((installation) => ({
        ...installationPlan(path, installation),
        source: installation.tool.source,
        environment: "native" as const,
        ...(installation.asset
          ? describeArtifact(required(installation.destination, "artifact destination"), installation.asset)
          : { state: "manager-owned" as const, binPaths: [], executables: [] }),
      })),
    ),
  );
}

/** Inspect receipts and SDK contents without executing tools, provisioning, or taking a source build lock. */
function describeArtifact(directory: string, asset: ToolAsset): NativeArtifactInspection {
  const receipt = join(directory, ".workbench-artifact");
  const state = existsSync(receipt)
    ? readText(receipt).trim() === asset.sha256
      ? NativeArtifactState.Installed
      : NativeArtifactState.Mismatch
    : existsSync(directory)
      ? NativeArtifactState.Incomplete
      : NativeArtifactState.Missing;
  const bin = join(directory, asset.bin);
  const executables: { name: string; path: string }[] = [];
  if (state === NativeArtifactState.Installed && existsSync(bin)) {
    const canonical = realpathSync(directory);
    for (const name of readdirSync(bin).sort()) {
      try {
        const path = realpathSync(join(bin, name));
        safeRelative(canonical, path);
        const stat = statSync(path);
        if (
          stat.isFile() &&
          (process.platform === "win32" ? /\.(?:exe|cmd|bat)$/i.test(name) : (stat.mode & 0o111) !== 0)
        )
          executables.push({ name, path });
      } catch {
        // Broken links and entries outside the selected installation are not usable SDK executables.
      }
    }
  }
  return { state, binPaths: [bin], executables, verification: "installation receipt; executables are not run" };
}

export function listNativeTools(
  root: string,
  selected?: string,
  json = false,
  selection: NativeToolSelection = {},
): void {
  const entries = nativeToolInspection(root, selected, selection);
  if (json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  let previous: string | undefined;
  for (const entry of entries) {
    if (entry.root !== previous) {
      console.log(`${entry.root}:`);
      previous = entry.root;
    }
    const artifact = "directory" in entry;
    const location = artifact
      ? entry.directory
      : {
          rustup: "rustup",
          "visual-studio": "Visual Studio Installer (pinned toolset and Windows SDK)",
          uv: "uv python dir",
          unavailable: "no verified artifact metadata",
        }[entry.manager];
    console.log(
      `  ${entry.tool} ${entry.version} (${entry.source}): ${location}${artifact ? ` [${entry.state}]` : ""}`,
    );
    if (entry.binPaths.length) console.log(`    bin: ${entry.binPaths.join(delimiter)}`);
  }
}

export async function installNativeTools(
  root: string,
  selected?: string,
  selection: NativeToolSelection = {},
  onlyTool?: string,
): Promise<void> {
  await withConfigurationSnapshot(async () => {
    if ((selection.compiler !== undefined || selection.compilerVersion !== undefined) && selected === undefined)
      throw new Error("compiler overrides require --path");
    const plan = resolveNativeInstallation(root, selected, selection, onlyTool);
    const tools = plan.flatMap((entry) =>
      entry.tools.map(({ tool, destination }) => toolRequirement(tool, destination)),
    );
    await withToolCacheUseAsync(() => installDeclaredTools(root, plan, selection, onlyTool === undefined), tools);
  });
}

async function installDeclaredTools(
  root: string,
  plan: ReturnType<typeof resolveNativeInstallation>,
  selection: NativeToolSelection,
  verifyAll: boolean,
): Promise<void> {
  const distribution = distributionRoot(root);
  const resolver = new MicrosoftSDKResolver();
  const sdks = new Map<string, ResolvedMicrosoftSDK>();
  // Diagnose unsupported pins before making any installation changes.
  for (const { tools, declared, directory } of plan)
    for (const { tool, asset, provider } of tools) {
      toolProbes(tool); // Reject packages without executable contracts before downloading or installing anything.
      if (asset) assertAssetHost(asset);
      if (provider === "visual-studio") sdks.set(directory, resolver.resolve(directory, tool.version));
      if (provider === "unavailable")
        throw new Error(
          `no verified ${tool.name} ${tool.version} artifact for ${process.platform}/${process.arch}; restore its installation metadata or add reviewed artifact metadata`,
        );
      if (tool.name === "python" && !declared.some((entry) => entry.name === "uv"))
        throw new Error("Python installation requires an exact uv pin in .tool-versions");
    }
  for (const { directory, tools } of plan) {
    console.log(`Installing declared native tools for ${directory}`);
    for (const installation of tools) {
      if (installation.provider === "artifact") await installAsset(installation.destination, installation.asset);
    }
    let env = nativeEnvironment(
      directory,
      distribution,
      selection,
      currentExecutionEnvironment(),
      sdks.get(directory),
      true,
    );
    const previous = new Map<"rustup" | "uv", Set<string>>();
    for (const { provider } of tools)
      if (provider === "rustup" || provider === "uv")
        if (!previous.has(provider)) previous.set(provider, managerInstallations(provider, env));
    for (const directories of previous.values()) for (const path of directories) invalidateCacheSize(path);
    try {
      for (const { tool, provider } of tools) {
        if (provider === "rustup") {
          const pin = (
            readToml(join(directory, tool.source)) as {
              toolchain: { profile?: string; components?: string[]; targets?: string[] };
            }
          ).toolchain;
          env = await ensureRustup(distribution, env);
          execute(
            "rustup",
            [
              "toolchain",
              "install",
              tool.version,
              "--no-self-update",
              "--no-update",
              "--profile",
              pin.profile ?? "minimal",
            ],
            { cwd: directory, env },
          );
          // --no-update skips additions to an existing toolchain; ask rustup to reconcile them explicitly.
          if (pin.components?.length)
            execute("rustup", ["component", "add", "--toolchain", tool.version, ...pin.components], {
              cwd: directory,
              env,
            });
          if (pin.targets?.length)
            execute("rustup", ["target", "add", "--toolchain", tool.version, ...pin.targets], { cwd: directory, env });
        }
        if (provider === "uv") execute("uv", ["python", "install", tool.version], { cwd: directory, env });
      }
    } finally {
      for (const directories of previous.values()) for (const path of directories) invalidateCacheSize(path);
    }
    env = nativeEnvironment(
      directory,
      distribution,
      selection,
      currentExecutionEnvironment(),
      sdks.get(directory),
      true,
    );
    for (const { tool, asset, destination } of tools) {
      verifyInstalledTool(directory, tool, asset, destination, env);
      if (asset) recordNativeArtifact(tool, asset);
    }
    for (const [provider, before] of previous)
      recordManagerInstallations(
        provider,
        before,
        env,
        tools.filter((entry) => entry.provider === provider).map((entry) => entry.tool.version),
      );
    if (verifyAll) {
      const command = guardToolchains(directory, ["true"], false, selection);
      execute(required(command[0], "expected command[0]"), command.slice(1), { cwd: directory, env });
    }
  }
}

/** Probe the selected installation directly, even when a different tool is earlier on the host PATH. */
function artifactExecutable(
  destination: string,
  asset: ToolAsset,
  probe: ReturnType<typeof toolProbes>[number],
): string {
  try {
    const installation = realpathSync(destination);
    const executable = realpathSync(
      join(
        installation,
        asset.bin,
        `${probe.executable}${process.platform === "win32" ? (probe.windowsSuffix ?? ".exe") : ""}`,
      ),
    );
    safeRelative(installation, executable);
    return executable;
  } catch (error) {
    throw new NativeToolUnavailable(
      `Managed installation is missing or does not contain ${probe.executable}; run workbench tools install. System PATH fallback is disabled.`,
      { cause: error },
    );
  }
}

export function verifyInstalledTool(
  directory: string,
  tool: Tool,
  asset: ToolAsset | undefined,
  destination: string | undefined,
  environment: NodeJS.ProcessEnv,
  purpose: "development" | "compatibility" = "development",
): void {
  const env: NodeJS.ProcessEnv = {
    ...environment,
    GOTOOLCHAIN: "local",
    RUSTUP_AUTO_INSTALL: "0",
    UV_PYTHON_DOWNLOADS: "never",
    ...(["rust", "miri"].includes(tool.name) ? { RUSTUP_TOOLCHAIN: tool.version } : {}),
  };
  for (const probe of toolProbes(tool, purpose)) {
    let executable: string;
    if (asset) {
      executable = artifactExecutable(required(destination, "artifact destination"), asset, probe);
    } else if (tool.name === "python") {
      executable = execute("uv", ["python", "find", "--managed-python", "--system", tool.version], {
        cwd: directory,
        env,
        capture: true,
      }).trim();
      if (!executable) throw new Error(`${tool.source}: uv did not resolve the installed managed Python interpreter`);
    } else if (tool.name === "mvsc") {
      executable = required(env.WORKBENCH_MVSC_CC, "selected MSVC SDK compiler");
    } else if (tool.name === "rust" || tool.name === "miri") {
      // Resolve rustup's selected toolchain to the actual binary, rather than probing a PATH shim.
      executable = execute("rustup", ["which", "--toolchain", tool.version, probe.executable], {
        cwd: directory,
        env,
        capture: true,
      }).trim();
      if (!executable) throw new Error(`${tool.source}: rustup did not resolve ${probe.executable}`);
    } else throw new Error(`${tool.source}: no verified installation provider for ${tool.name}`);
    const lines = probeScript(probe, [executable.replaceAll("\\", "/"), ...probe.args], tool.source, true);
    const output = execute("sh", ["-eu", "-c", [probePrelude, ...lines].join("\n")], {
      cwd: directory,
      env,
      capture: true,
    });
    console.log(output.trimEnd());
  }
}

/** Bootstrap rustup once without installing an unrelated development toolchain. */
export async function ensureRustup(distribution: string, environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env = { ...environment };
  const cargo = join(env.CARGO_HOME ?? join(homedir(), ".cargo"), "bin");
  env.PATH = `${cargo}${delimiter}${env.PATH ?? ""}`;
  const rustup = join(cargo, process.platform === "win32" ? "rustup.exe" : "rustup");
  // A host rustup can manage a separate toolchain store without creating this Cargo home's proxies.
  if (spawnSync(rustup, ["--version"], { env, stdio: "ignore" }).status === 0) return env;
  const bootstrap = JSON.parse(readText(join(distribution, "scripts/bootstrap-tools.json"))) as Record<string, string>;
  const tool = {
    name: "rustup-init",
    version: exactVersion(bootstrap["rustup-init"], "bootstrap-tools.json"),
    source: "bootstrap-tools.json",
  };
  const artifact = required(assetFor(distribution, tool), "no verified rustup installer for this platform");
  const destination = toolDirectory(tool, artifact);
  await installAsset(destination, artifact);
  execute(
    join(destination, required(artifact.executable, "rustup installer executable")),
    ["-y", "--no-modify-path", "--default-toolchain", "none", "--profile", "minimal"],
    { env },
  );
  return env;
}

export async function installContainerTools(root: string): Promise<void> {
  const distribution = distributionRoot(root);
  const tool = required(
    nativeTools(distribution).find((tool) => tool.name === "node"),
    'expected nativeTools(distribution).find((tool) => tool.name === "node")',
  );
  const asset = assetFor(distribution, tool);
  if (!asset) throw new Error("no verified Workbench Node artifact for this platform");
  await installAsset(toolDirectory(tool, asset), asset);
  installContainerCLI(
    distribution,
    nativeEnvironment(distribution, distribution, {}, currentExecutionEnvironment(), undefined, true),
  );
}
