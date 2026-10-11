import { required } from "./invariants.js";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { distributionRoot, readText, readToml } from "./core.js";
import { selectedCompiler, type CompilerSelection } from "./compilers.js";
import { probePrelude, probeScript, toolProbes } from "./tool-probes.js";
import { exactJavaVersion } from "./java-config.js";

/** Quote one literal shell argument; commands and metadata never become shell syntax. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function exactVersion(value: unknown, source: string): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value))
    throw new Error(`${source}: expected an exact major.minor.patch tool version`);
  return value;
}

export function packageManagerPin(directory: string): { name: string; version: string } {
  const path = join(directory, "package.json");
  const metadata = JSON.parse(readText(path)) as { packageManager?: unknown };
  const match =
    typeof metadata.packageManager === "string"
      ? /^(npm|pnpm|yarn)@(\d+\.\d+\.\d+)$/.exec(metadata.packageManager)
      : null;
  if (!match) throw new Error(`${path}: packageManager must pin npm, pnpm, or yarn to an exact version`);
  return { name: required(match[1], "package-manager name"), version: required(match[2], "package-manager version") };
}

function packageManager(directory: string, distribution: string): string[] {
  packageManagerPin(directory);
  return ["node", relative(directory, join(distribution, "bin/workbench.mjs")), "package-manager-exec", "--"];
}

/** Use the project's routing link for commands that also execute in a mounted workspace. */
export function distributionReference(directory: string, distribution: string): string {
  // Keep command paths inside the workspace facade when host and container directory depths differ.
  for (let ancestor = resolve(directory); ; ancestor = dirname(ancestor)) {
    const embedded = join(ancestor, ".workbench");
    if (existsSync(embedded) && realpathSync(embedded) === realpathSync(distribution)) {
      distribution = embedded;
      break;
    }
    if (dirname(ancestor) === ancestor) break;
  }
  return distribution;
}

/** Resolve the package-manager pin from its native authority, not copied command strings. */
export function resolveCheckCommand(directory: string, command: string[], distribution?: string): string[] {
  if (distribution) distribution = distributionReference(directory, distribution);
  command = command.map((part) => {
    if (part !== "{workbench}" && !part.startsWith("{workbench}/")) return part;
    if (!distribution) throw new Error("a Workbench distribution is required to resolve {workbench}");
    if (part === "{workbench}") return relative(directory, distribution).split(sep).join("/") || ".";
    return `${relative(directory, distribution).split(sep).join("/") || "."}/${part.slice("{workbench}/".length)}`;
  });
  return command[0] === "{packageManager}"
    ? [...packageManager(directory, distribution ?? distributionRoot(directory)), ...command.slice(1)]
    : command;
}

/** Standalone tool pins are shared by local enforcement and CI installation. */
export function standaloneTools(directory: string): Map<string, string> {
  const path = join(directory, ".tool-versions");
  const tools = new Map<string, string>();
  if (!existsSync(path)) return tools;
  for (const line of readText(path).split("\n")) {
    const [name, version, ...extra] = required(line.split("#")[0], 'expected line.split("#")[0]').trim().split(/\s+/);
    if (!name) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(name) || extra.length || tools.has(name))
      throw new Error(`${path}: each tool needs one unique name and exact version`);
    tools.set(name, exactVersion(version, path));
  }
  return tools;
}

/** Execute probes and the command in the SAME environment, without requiring Node inside it. */
export function guardToolchains(
  directory: string,
  command: string[],
  managed = false,
  selection: CompilerSelection = {},
): string[] {
  const lines: string[] = [];
  const add = (name: string, version: string, source: string, enforce = !managed) => {
    for (const probe of toolProbes({ name, version, source })) {
      const executable = probe.compilerVariable
        ? ["sh", "-c", `exec "\${${probe.compilerVariable}:-${probe.executable}}" "$@"`, "workbench-compiler"]
        : name === "python"
          ? ["sh", "-c", 'exec "${WORKBENCH_PYTHON:-python3}" "$@"', "workbench-python"]
          : [probe.executable];
      lines.push(...probeScript(probe, [...executable, ...probe.args], source, enforce, managed));
    }
  };
  const nodeFile = join(directory, ".node-version");
  if (existsSync(nodeFile)) add("node", exactVersion(readText(nodeFile).trim(), nodeFile), ".node-version");
  const javaFile = join(directory, ".java-version");
  if (existsSync(javaFile)) add("java", exactJavaVersion(readText(javaFile).trim(), javaFile), ".java-version");
  const phpFile = join(directory, ".php-version");
  if (existsSync(phpFile)) add("php", exactVersion(readText(phpFile).trim(), phpFile), ".php-version");
  const rubyFile = join(directory, ".ruby-version");
  if (existsSync(rubyFile)) add("ruby", exactVersion(readText(rubyFile).trim(), rubyFile), ".ruby-version");
  const llvmFile = join(directory, ".llvm-version");
  const compiler = selectedCompiler(directory, selection);
  if (existsSync(llvmFile)) {
    if (!managed)
      lines.push(
        'for tool_path in "${CPATH-}" "${C_INCLUDE_PATH-}" "${CPLUS_INCLUDE_PATH-}" "${LIBRARY_PATH-}"; do',
        'case "$tool_path" in */gnu/store/*|*/.guix-profile/*|*/nix/store/*)',
        "printf '%s\\n' 'workbench: native C/C++ checks inherited managed header/library paths; load the native environment (for example direnv exec .), or select guix/nix explicitly' >&2; exit 1;; esac; done",
      );
    const version = exactVersion(readText(llvmFile).trim(), llvmFile);
    add("llvm", version, `.llvm-version ${version}`);
  }
  if (compiler)
    add(
      compiler.family,
      compiler.version,
      compiler.family === "gcc" ? ".gcc-version / compiler selection" : "compiler selection",
      !managed || selection.compilerVersion !== undefined,
    );
  const goFile = join(directory, ".go-version");
  if (existsSync(goFile)) {
    lines.push("export GOTOOLCHAIN=local");
    add("go", exactVersion(readText(goFile).trim(), goFile), ".go-version");
  }
  const rustFile = join(directory, "rust-toolchain.toml");
  if (existsSync(rustFile)) {
    const data = readToml(rustFile) as { toolchain?: { channel?: unknown } };
    lines.push("export RUSTUP_AUTO_INSTALL=0");
    add("rust", exactVersion(data.toolchain?.channel, rustFile), "rust-toolchain.toml");
  }
  const pythonFile = join(directory, ".python-version");
  if (existsSync(pythonFile)) {
    add("python", exactVersion(readText(pythonFile).trim(), pythonFile), ".python-version");
    // Force uv to use the interpreter just verified, including when an old .venv exists.
    lines.push(
      "UV_PYTHON=$(\"${WORKBENCH_PYTHON:-python3}\" -c 'import os, sys; print(os.path.realpath(sys.executable))')",
      "export UV_PYTHON UV_PYTHON_DOWNLOADS=never",
    );
  }
  for (const [name, version] of standaloneTools(directory)) add(name, version, ".tool-versions");
  if (!lines.length) return command;
  lines.push('exec "$@"');
  return ["sh", "-eu", "-c", [probePrelude, ...lines].join("\n"), "workbench-toolchain", ...command];
}
