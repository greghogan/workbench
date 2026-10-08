import { required } from "./invariants.js";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { distributionRoot, readLanguageRoots, readText, readToml } from "./core.js";
import { exactVersion, guardToolchains, standaloneTools, resolveCheckCommand } from "./toolchains.js";
import { execute, installAsset, type ToolAsset } from "./tool-downloads.js";
import { userDirectory } from "./storage.js";
import { miriToolchain, miriToolchainFile } from "./miri.js";
import { selectedCompiler, compilerEnvironment, type CompilerSelection } from "./compilers.js";
import { buildEnvironment, buildPaths, prepareBuild, withBuildLock } from "./builds.js";

interface Tool {
  name: string;
  version: string;
  source: string;
}
const files = { node: ".node-version", python: ".python-version", go: ".go-version", llvm: ".llvm-version" };

export function nativeTools(directory: string, distribution?: string, selection: CompilerSelection = {}): Tool[] {
  const tools: Tool[] = [];
  for (const [name, file] of Object.entries(files)) {
    const path = join(directory, file);
    if (existsSync(path)) tools.push({ name, version: exactVersion(readText(path).trim(), path), source: file });
  }
  const compiler = selectedCompiler(directory, selection);
  if (
    compiler &&
    (compiler.family === "gcc" || compiler.version !== tools.find((tool) => tool.name === "llvm")?.version)
  )
    tools.push({
      name: compiler.family,
      version: compiler.version,
      source: compiler.family === "gcc" ? ".gcc-version / compiler selection" : "compiler selection",
    });
  const rust = join(directory, "rust-toolchain.toml");
  if (existsSync(rust))
    tools.push({
      name: "rust",
      version: exactVersion((readToml(rust) as { toolchain?: { channel?: unknown } }).toolchain?.channel, rust),
      source: "rust-toolchain.toml",
    });
  const miri = miriToolchain(directory);
  if (miri) tools.push({ name: "miri", version: miri.channel, source: miriToolchainFile });
  for (const [name, version] of standaloneTools(directory)) {
    if (tools.some((tool) => tool.name === name))
      throw new Error(`${directory}: duplicate native authority for ${name}`);
    tools.push({ name, version, source: ".tool-versions" });
  }
  if (distribution && !tools.some((tool) => tool.name === "node")) {
    const path = join(distribution, ".node-version");
    tools.push({ name: "node", version: exactVersion(readText(path).trim(), path), source: "Workbench .node-version" });
  }
  return tools;
}

function assetFor(distribution: string, tool: Tool): ToolAsset | undefined {
  const platform = `${process.platform}-${process.arch}`;
  if (tool.name === "llvm" || tool.name === "clang") {
    const assets = JSON.parse(readText(join(distribution, "scripts/llvm-assets.json"))) as Record<
      string,
      Record<string, { name: string; sha256: string }>
    >;
    const asset = assets[tool.version]?.[platform];
    return asset
      ? {
          url: `https://github.com/llvm/llvm-project/releases/download/llvmorg-${tool.version}/${asset.name}`,
          sha256: asset.sha256,
          format: "tar",
          strip: 1,
          bin: "bin",
        }
      : undefined;
  }
  const assets = JSON.parse(readText(join(distribution, "scripts/native-assets.json"))) as Record<
    string,
    Record<string, Record<string, ToolAsset>>
  >;
  return assets[tool.name]?.[tool.version]?.[platform];
}

function toolDirectory(tool: Tool, asset: ToolAsset): string {
  return join(
    userDirectory("data"),
    "toolchains",
    tool.name,
    tool.version,
    `${process.platform}-${process.arch}`,
    asset.sha256.slice(0, 16),
  );
}

/** Read-only selection: absent installations retain host discovery and the existing exact-version guard. */
export function nativeEnvironment(
  directory: string,
  distribution: string,
  selection: CompilerSelection = {},
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...compilerEnvironment(directory, selection) };
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
      const asset = assetFor(distribution, tool);
      if (asset) {
        const directory = toolDirectory(tool, asset);
        const receipt = join(directory, ".workbench-artifact");
        if (existsSync(receipt) && readText(receipt).trim() === asset.sha256) {
          if (tool.name === "clang" || tool.name === "gcc") {
            env.WORKBENCH_CC = join(directory, asset.bin, tool.name === "gcc" ? "gcc" : "clang");
            env.WORKBENCH_CXX = join(directory, asset.bin, tool.name === "gcc" ? "g++" : "clang++");
            if (tool.name === "gcc") {
              paths.unshift(join(directory, asset.bin));
              env.LD_LIBRARY_PATH = [join(directory, "lib64"), join(directory, "lib"), env.LD_LIBRARY_PATH ?? ""]
                .filter(Boolean)
                .join(delimiter);
            }
          } else paths.push(join(directory, asset.bin));
          if (tool.name === "go") env.GOROOT = directory;
          if (tool.name === "llvm") {
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

export function listNativeTools(root: string, selected?: string): void {
  const distribution = distributionRoot(root);
  for (const path of roots(root, selected)) {
    console.log(`${path}:`);
    for (const tool of nativeTools(resolve(root, path), distribution)) {
      const asset = ["rust", "miri", "python"].includes(tool.name) ? undefined : assetFor(distribution, tool);
      const location = asset
        ? toolDirectory(tool, asset)
        : tool.name === "rust" || tool.name === "miri"
          ? "rustup"
          : tool.name === "python"
            ? "uv python dir"
            : "no bundled installer; provide on PATH";
      console.log(`  ${tool.name} ${tool.version} (${tool.source}): ${location}`);
    }
  }
}

export async function installNativeTools(
  root: string,
  selected?: string,
  selection: CompilerSelection = {},
): Promise<void> {
  if ((selection.compiler !== undefined || selection.compilerVersion !== undefined) && selected === undefined)
    throw new Error("compiler overrides require --path");
  const distribution = distributionRoot(root);
  const plan = roots(root, selected).map((path) => ({
    directory: resolve(root, path),
    tools: nativeTools(resolve(root, path), distribution, selection),
  }));
  // Diagnose unsupported pins before making any installation changes.
  for (const { tools } of plan)
    for (const tool of tools) {
      if (!["rust", "miri", "python"].includes(tool.name) && !assetFor(distribution, tool))
        throw new Error(
          `no verified ${tool.name} ${tool.version} artifact for ${process.platform}/${process.arch}; add reviewed artifact metadata or provide the tools yourself`,
        );
      if (tool.name === "python" && !tools.some((entry) => entry.name === "uv"))
        throw new Error("Python installation requires an exact uv pin in .tool-versions");
    }
  for (const { directory, tools } of plan) {
    console.log(`Installing declared native tools for ${directory}`);
    for (const tool of tools) {
      if (["rust", "miri", "python"].includes(tool.name)) continue;
      const asset = required(assetFor(distribution, tool), "expected assetFor(distribution, tool)");
      await installAsset(toolDirectory(tool, asset), asset);
    }
    let env = nativeEnvironment(directory, distribution, selection);
    for (const tool of tools) {
      if (tool.name === "rust" || tool.name === "miri") {
        const pin = (
          readToml(join(directory, tool.source)) as {
            toolchain: { profile?: string; components?: string[]; targets?: string[] };
          }
        ).toolchain;
        if (spawnSync("rustup", ["--version"], { env, stdio: "ignore" }).status !== 0) {
          const bootstrap = JSON.parse(readText(join(distribution, "scripts/bootstrap-tools.json"))) as Record<
            string,
            string
          >;
          const installer = {
            name: "rustup-init",
            version: exactVersion(bootstrap["rustup-init"], "bootstrap-tools.json"),
            source: "bootstrap-tools.json",
          };
          const artifact = assetFor(distribution, installer);
          if (!artifact) throw new Error("no verified rustup installer for this platform");
          const destination = toolDirectory(installer, artifact);
          await installAsset(destination, artifact);
          execute(
            join(destination, required(artifact.executable, "expected artifact.executable")),
            ["-y", "--no-modify-path", "--default-toolchain", "none", "--profile", "minimal"],
            { env },
          );
          env = nativeEnvironment(directory, distribution, selection);
        }
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
    const command = guardToolchains(directory, ["true"], false, selection);
    execute(required(command[0], "expected command[0]"), command.slice(1), { cwd: directory, env });
  }
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
  const command = resolveCheckCommand(distribution, ["{packageManager}", "install", "--frozen-lockfile"]);
  const paths = buildPaths(root, distribution, "native", {}, false);
  withBuildLock(paths, () => {
    prepareBuild(paths);
    execute("node", [join(distribution, "bin/workbench.mjs"), "dependency-setup", "--", ...command], {
      cwd: distribution,
      env: {
        ...nativeEnvironment(distribution, distribution),
        ...buildEnvironment(paths),
        WORKBENCH_PROJECT_ROOT: root,
      },
    });
  });
}
