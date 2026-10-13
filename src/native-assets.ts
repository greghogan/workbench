import { required } from "./invariants.js";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readText, readToml } from "./core.js";
import { exactVersion, standaloneTools } from "./toolchains.js";
import type { ToolAsset } from "./tool-downloads.js";
import { userDirectory } from "./storage.js";
import { miriToolchain, miriToolchainFile } from "./miri.js";
import { selectedCompiler, type CompilerSelection } from "./compilers.js";
import { catalog } from "./language-config.js";
import { ownedPath } from "./paths.js";
import { acquisitionIdentity, filterIdentity, type ArchiveFilter } from "./artifact-policy.js";
import { exactJavaVersion } from "./java-config.js";
import { createHash } from "node:crypto";
import { release } from "node:os";
import { selectedToolProfile } from "./tool-profiles.js";

export interface Tool {
  name: string;
  version: string;
  source: string;
}
const files = {
  node: ".node-version",
  python: ".python-version",
  go: ".go-version",
  llvm: ".llvm-version",
  java: ".java-version",
  ruby: ".ruby-version",
  php: ".php-version",
};

export function nativeTools(
  directory: string,
  distribution?: string,
  selection: CompilerSelection = {},
  platform: NodeJS.Platform = process.platform,
): Tool[] {
  const tools: Tool[] = [];
  for (const [name, file] of Object.entries(files)) {
    const path = join(directory, file);
    if (existsSync(path))
      tools.push({
        name,
        version: (name === "java" ? exactJavaVersion : exactVersion)(readText(path).trim(), path),
        source: file,
      });
  }
  const llvm = tools.find((tool) => tool.name === "llvm");
  const compiler = selectedCompiler(directory, selection);
  const clangVersion = compiler?.family === "clang" ? compiler.version : llvm?.version;
  const needsXML = clangVersion !== undefined && /^(21|22)\./.test(clangVersion);
  if (platform === "linux" && (llvm?.version.startsWith("23.") || needsXML))
    tools.push({ name: "llvm-runtime", version: "70.1-2", source: "LLVM Linux runtime dependency" });
  if (platform === "linux" && needsXML)
    tools.push({
      name: "llvm-xml-runtime",
      version: "2.9.13+dfsg-1ubuntu0.14",
      source: "LLVM 21/22 linker runtime dependency",
    });
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
  const profile = selectedToolProfile(directory, selection.toolchain);
  if (!profile) return tools;
  for (const name of Object.keys(profile.tools ?? {}))
    if (!["clang", "gcc"].includes(name) && !tools.some((tool) => tool.name === name))
      throw new Error(`tool profile '${profile.name}': ${name} is not declared in ${directory}`);
  return tools.map((tool) => {
    const version = (profile.tools as Record<string, string> | undefined)?.[tool.name];
    return version ? { ...tool, version, source: `tool profile '${profile.name}'` } : tool;
  });
}

export function assetFor(
  distribution: string,
  tool: Tool,
  directory?: string,
  platform = `${process.platform}-${process.arch}`,
): ToolAsset | undefined {
  if (tool.name === "llvm" || tool.name === "clang") {
    const assets = JSON.parse(readText(join(distribution, "scripts/llvm-assets.json"))) as Record<
      string,
      Record<
        string,
        { name: string; sha256: string; signers?: string[]; attestation?: string; zstdWindowLogMax?: number }
      >
    >;
    const asset = assets[tool.version]?.[platform];
    if (!asset) return undefined;
    const policy = directory ? selectedCompiler(directory) : undefined;
    const language = policy && Object.hasOwn(policy.standards, "cpp") ? "cpp" : "c";
    let projectRoot = directory ? resolve(directory) : distribution;
    while (!existsSync(join(projectRoot, "workbench/projects.toml")) && dirname(projectRoot) !== projectRoot)
      projectRoot = dirname(projectRoot);
    if (!existsSync(join(projectRoot, "workbench/projects.toml"))) projectRoot = distribution;
    const definition = required(
      catalog(projectRoot).find((entry) => entry.id === language),
      `missing ${language} definition`,
    );
    const filterPath = ownedPath(definition.directory, "llvm-filter.json");
    const filter = JSON.parse(readText(filterPath)) as ArchiveFilter;
    if (process.platform === "win32") filter.required = filter.required.map((path) => `${path}.exe`);
    return {
      url: `https://github.com/llvm/llvm-project/releases/download/llvmorg-${tool.version}/${asset.name}`,
      sha256: asset.sha256,
      format: "tar",
      strip: 1,
      bin: "bin",
      filter,
      ...(asset.zstdWindowLogMax === undefined ? {} : { zstdWindowLogMax: asset.zstdWindowLogMax }),
      ...(asset.signers
        ? {
            signature: {
              url: `https://github.com/llvm/llvm-project/releases/download/llvmorg-${tool.version}/${asset.name}.sig`,
              keys: readText(join(distribution, "scripts/keys/llvm.asc")),
              signers: asset.signers,
            },
          }
        : {}),
      ...(asset.attestation
        ? {
            attestation: {
              url: `https://github.com/llvm/llvm-project/releases/download/llvmorg-${tool.version}/${asset.name}.jsonl`,
              signer: asset.attestation,
              subject: asset.name,
              roots: readText(join(distribution, "scripts/keys/sigstore-trusted-root.jsonl")),
            },
          }
        : {}),
    };
  }
  const assets = JSON.parse(readText(join(distribution, "scripts/native-assets.json"))) as Record<
    string,
    Record<string, Record<string, ToolAsset>>
  >;
  const asset = assets[tool.name]?.[tool.version]?.[platform];
  if (!asset) return undefined;
  if (
    !asset.signature &&
    !asset.checksums &&
    !asset.attestation &&
    !asset.repository &&
    !asset.authenticationUnavailable
  )
    throw new Error(
      `${tool.name} ${tool.version}: artifact metadata must declare upstream authentication or its absence`,
    );
  if (asset.authenticationUnavailable && (asset.signature || asset.checksums || asset.attestation || asset.repository))
    throw new Error(`${tool.name} ${tool.version}: contradictory artifact authentication metadata`);
  const key = (path: string) => readText(ownedPath(distribution, path));
  if (asset.signature) asset.signature.keys = key(asset.signature.keys);
  if (asset.checksums) asset.checksums.signature.keys = key(asset.checksums.signature.keys);
  if (asset.attestation) asset.attestation.roots = key(asset.attestation.roots);
  if (asset.repository) asset.repository.signature.keys = key(asset.repository.signature.keys);
  return asset;
}

export function toolDirectory(tool: Tool, asset: ToolAsset): string {
  // Source builds bind to the host SDK/libc; Linux containers share a kernel but not a userspace ABI.
  const sourceBuild = asset.build !== undefined;
  const host = sourceBuild
    ? createHash("sha256")
        .update(process.platform === "linux" ? readText("/etc/os-release") : release())
        .digest("hex")
        .slice(0, 12)
    : undefined;
  return join(
    userDirectory("cache"),
    "toolchains",
    tool.name,
    tool.version,
    `${process.platform}-${process.arch}`,
    `${asset.sha256.slice(0, 16)}${sourceBuild ? `-${acquisitionIdentity(asset).slice(0, 16)}-${required(host, "source build host identity")}` : ""}${asset.filter ? `-${filterIdentity(asset.filter).slice(0, 16)}-${acquisitionIdentity(asset).slice(0, 16)}` : ""}`,
  );
}
