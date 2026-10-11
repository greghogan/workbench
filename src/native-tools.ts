import { inspectDistribution, distributionManifest } from "./distribution-manifest.js";
import { userDirectory } from "./storage.js";
import { withCacheLockSync } from "./cache-lock.js";
import { packageManagerCommand } from "./package-manager.js";
import { required } from "./invariants.js";
import { existsSync, realpathSync, mkdirSync, copyFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { distributionRoot, readLanguageRoots, readText, readToml, safeRelative } from "./core.js";
import { exactVersion, guardToolchains } from "./toolchains.js";
import { execute, installAsset } from "./tool-downloads.js";
import { compilerEnvironment, type CompilerSelection } from "./compilers.js";
import { acquisitionIdentity } from "./artifact-policy.js";
import { nativeTools, assetFor, toolDirectory, type Tool } from "./native-assets.js";
import { probePrelude, probeScript, toolProbes } from "./tool-probes.js";
import type { ToolAsset } from "./tool-downloads.js";

/** Read-only selection: absent installations retain host discovery and the existing exact-version guard. */
export function nativeEnvironment(
  directory: string,
  distribution: string,
  selection: CompilerSelection = {},
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...compilerEnvironment(directory, selection) };
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
    if (tool.name === "rust" || tool.name === "miri") {
      rustBin = join(env.CARGO_HOME ?? join(homedir(), ".cargo"), "bin");
      if (tool.name === "rust") env.RUSTUP_TOOLCHAIN = tool.version;
    } else if (tool.name !== "python") {
      const asset = assetFor(distribution, tool, directory);
      if (asset) {
        const directory = toolDirectory(tool, asset);
        const receipt = join(directory, ".workbench-artifact");
        if (existsSync(receipt) && readText(receipt).trim() === asset.sha256) {
          if (tool.name === "php" && process.platform === "win32") {
            env.PHPRC = directory;
            env.PHP_INI_SCAN_DIR = "";
          }
          if (tool.name === "clang" || tool.name === "gcc") {
            env.WORKBENCH_CC = join(directory, asset.bin, tool.name === "gcc" ? "gcc" : "clang");
            env.WORKBENCH_CXX = join(directory, asset.bin, tool.name === "gcc" ? "g++" : "clang++");
            if (tool.name === "gcc") {
              paths.unshift(join(directory, asset.bin));
              env.LD_LIBRARY_PATH = [join(directory, "lib64"), join(directory, "lib"), env.LD_LIBRARY_PATH ?? ""]
                .filter(Boolean)
                .join(delimiter);
              // Cached GCC builds still use the current host SDK; Debian puts startup objects and headers in multiarch directories.
              const triple = process.arch === "x64" ? "x86_64-linux-gnu" : "aarch64-linux-gnu";
              for (const [name, path] of [
                ["LIBRARY_PATH", `/usr/lib/${triple}`],
                ["C_INCLUDE_PATH", `/usr/include/${triple}`],
                ["CPLUS_INCLUDE_PATH", `/usr/include/${triple}`],
              ] as const) {
                if (existsSync(path)) env[name] = [env[name], path].filter(Boolean).join(delimiter);
              }
            }
          } else if (["llvm-runtime", "llvm-xml-runtime"].includes(tool.name)) {
            env.LD_LIBRARY_PATH = [join(directory, asset.bin), env.LD_LIBRARY_PATH ?? ""]
              .filter(Boolean)
              .join(delimiter);
          } else paths.push(join(directory, asset.bin));
          if (tool.name === "go") env.GOROOT = directory;
          if (tool.name === "java") env.JAVA_HOME = resolve(directory, asset.bin, "..");
          if (tool.name === "llvm") {
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
  return env;
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
  selection: CompilerSelection = {},
  onlyTool?: string,
) {
  const distribution = distributionRoot(root);
  return roots(root, selected).map((path) => {
    const directory = resolve(root, path);
    const declared = nativeTools(directory, distribution, selection);
    if (onlyTool !== undefined && !declared.some((tool) => tool.name === onlyTool))
      throw new Error(`${path}: no declared native tool '${onlyTool}'`);
    const dependencies =
      onlyTool === "python"
        ? ["uv"]
        : ["llvm", "clang"].includes(onlyTool ?? "")
          ? ["llvm-runtime", "llvm-xml-runtime"]
          : [];
    const tools = declared
      .filter((tool) => onlyTool === undefined || tool.name === onlyTool || dependencies.includes(tool.name))
      .map((tool) => {
        const asset = ["rust", "miri", "python"].includes(tool.name)
          ? undefined
          : assetFor(distribution, tool, directory);
        return { tool, asset, destination: asset ? toolDirectory(tool, asset) : undefined };
      });
    return { path, directory, declared, tools };
  });
}

export function nativeInstallationPlan(root: string, selected?: string, selection: CompilerSelection = {}) {
  return resolveNativeInstallation(root, selected, selection).flatMap(({ path, tools }) =>
    tools.map(({ tool, asset, destination }) => ({
      root: path,
      tool: tool.name,
      version: tool.version,
      ...(asset
        ? {
            directory: required(destination, "artifact destination"),
            filtered: Boolean(asset.filter),
            policy: acquisitionIdentity(asset),
          }
        : { manager: tool.name === "python" ? "uv" : "rustup" }),
    })),
  );
}

export function listNativeTools(
  root: string,
  selected?: string,
  json = false,
  selection: CompilerSelection = {},
): void {
  if (json) {
    console.log(JSON.stringify(nativeInstallationPlan(root, selected, selection), null, 2));
    return;
  }
  for (const { path, tools } of resolveNativeInstallation(root, selected, selection)) {
    console.log(`${path}:`);
    for (const { tool, asset, destination } of tools) {
      const location = asset
        ? required(destination, "artifact destination")
        : tool.name === "rust" || tool.name === "miri"
          ? "rustup"
          : tool.name === "python"
            ? "uv python dir"
            : "no bundled installer; provide on PATH";
      let state = "";
      if (asset) {
        const receipt = join(location, ".workbench-artifact");
        const status = existsSync(receipt)
          ? readText(receipt).trim() === asset.sha256
            ? "installed"
            : "receipt mismatch"
          : existsSync(location)
            ? "incomplete installation"
            : "not installed";
        state = ` [${status}]`;
      }
      console.log(`  ${tool.name} ${tool.version} (${tool.source}): ${location}${state}`);
    }
  }
}

export async function installNativeTools(
  root: string,
  selected?: string,
  selection: CompilerSelection = {},
  onlyTool?: string,
): Promise<void> {
  if ((selection.compiler !== undefined || selection.compilerVersion !== undefined) && selected === undefined)
    throw new Error("compiler overrides require --path");
  const distribution = distributionRoot(root);
  const plan = resolveNativeInstallation(root, selected, selection, onlyTool);
  // Diagnose unsupported pins before making any installation changes.
  for (const { tools, declared } of plan)
    for (const { tool, asset } of tools) {
      toolProbes(tool); // Reject packages without executable contracts before downloading or installing anything.
      if (!["rust", "miri", "python"].includes(tool.name) && !asset)
        throw new Error(
          `no verified ${tool.name} ${tool.version} artifact for ${process.platform}/${process.arch}; add reviewed artifact metadata or provide the tools yourself`,
        );
      if (tool.name === "python" && !declared.some((entry) => entry.name === "uv"))
        throw new Error("Python installation requires an exact uv pin in .tool-versions");
    }
  for (const { directory, tools } of plan) {
    console.log(`Installing declared native tools for ${directory}`);
    for (const { tool, asset, destination } of tools) {
      if (["rust", "miri", "python"].includes(tool.name)) continue;
      await installAsset(required(destination, "artifact destination"), required(asset, "artifact metadata"));
    }
    let env = nativeEnvironment(directory, distribution, selection);
    for (const { tool } of tools) {
      if (tool.name === "rust" || tool.name === "miri") {
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
            "--profile",
            pin.profile ?? "minimal",
            ...(pin.components ?? []).flatMap((component) => ["--component", component]),
            ...(pin.targets ?? []).flatMap((target) => ["--target", target]),
          ],
          { cwd: directory, env },
        );
      }
      if (tool.name === "python") execute("uv", ["python", "install", tool.version], { cwd: directory, env });
    }
    env = nativeEnvironment(directory, distribution, selection);
    for (const { tool, asset, destination } of tools) verifyInstalledTool(directory, tool, asset, destination, env);
    if (onlyTool === undefined) {
      const command = guardToolchains(directory, ["true"], false, selection);
      execute(required(command[0], "expected command[0]"), command.slice(1), { cwd: directory, env });
    }
  }
}

/** Probe the selected installation directly, even when a different tool is earlier on the host PATH. */
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
      const installation = realpathSync(required(destination, "artifact destination"));
      executable = realpathSync(
        join(
          installation,
          asset.bin,
          `${probe.executable}${process.platform === "win32" ? (probe.windowsSuffix ?? ".exe") : ""}`,
        ),
      );
      safeRelative(installation, executable); // Contained upstream executable symlinks are valid; escaping ones are not.
    } else if (tool.name === "python") {
      executable = execute("uv", ["python", "find", "--managed-python", "--system", tool.version], {
        cwd: directory,
        env,
        capture: true,
      }).trim();
      if (!executable) throw new Error(`${tool.source}: uv did not resolve the installed managed Python interpreter`);
    } else {
      // Resolve rustup's selected toolchain to the actual binary, rather than probing a PATH shim.
      executable = execute("rustup", ["which", "--toolchain", tool.version, probe.executable], {
        cwd: directory,
        env,
        capture: true,
      }).trim();
      if (!executable) throw new Error(`${tool.source}: rustup did not resolve ${probe.executable}`);
    }
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
  if (spawnSync("rustup", ["--version"], { env, stdio: "ignore" }).status === 0) return env;
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

const containerInputs = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs"];

/** Host CLI dependencies must survive a guest rewiring the workspace's package links. */
export function containerToolsDirectory(distribution: string): string {
  const identity = existsSync(join(distribution, distributionManifest))
    ? inspectDistribution(distribution).pin.sha256
    : createHash("sha256")
        .update(JSON.stringify(containerInputs.map((name) => [name, readText(join(distribution, name))])))
        .digest("hex");
  return join(userDirectory("cache"), "container-tools", `${process.platform}-${process.arch}`, identity);
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
  const directory = containerToolsDirectory(distribution);
  withCacheLockSync(directory, () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of containerInputs) copyFileSync(join(distribution, name), join(directory, name));
    const command = [...packageManagerCommand(directory, distribution), "install", "--frozen-lockfile"];
    execute(required(command[0], "container tool installer"), command.slice(1), {
      cwd: directory,
      env: {
        ...nativeEnvironment(distribution, distribution),
        PNPM_CONFIG_STORE_DIR: join(userDirectory("cache"), "downloads/pnpm"),
        PNPM_CONFIG_VIRTUAL_STORE_DIR: join(directory, "virtual-store"),
        PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false",
      },
    });
  });
}
