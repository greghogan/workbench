import { required } from "./invariants.js";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readText, readToml } from "./core.js";
import { selectedCompiler, type CompilerSelection } from "./compilers.js";

/** Quote one literal shell argument; commands and metadata never become shell syntax. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function exactVersion(value: unknown, source: string): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value))
    throw new Error(`${source}: expected an exact major.minor.patch tool version`);
  return value;
}

function packageManager(directory: string): string[] {
  const path = join(directory, "package.json");
  const metadata = JSON.parse(readText(path)) as { packageManager?: unknown };
  const match =
    typeof metadata.packageManager === "string"
      ? /^(npm|pnpm|yarn)@(\d+\.\d+\.\d+)$/.exec(metadata.packageManager)
      : null;
  if (!match) throw new Error(`${path}: packageManager must pin npm, pnpm, or yarn to an exact version`);
  return [
    "npm",
    "exec",
    "--yes",
    `--package=${metadata.packageManager as string}`,
    "--",
    required(match[1], "expected match[1]"),
  ];
}

/** Resolve the package-manager pin from its native authority, not copied command strings. */
export function resolveCheckCommand(directory: string, command: string[], distribution?: string): string[] {
  command = command.map((part) => {
    if (!part.startsWith("{workbench}/")) return part;
    if (!distribution) throw new Error("a Workbench distribution is required to resolve {workbench}");
    return `${relative(directory, distribution).split(sep).join("/") || "."}/${part.slice("{workbench}/".length)}`;
  });
  return command[0] === "{packageManager}" ? [...packageManager(directory), ...command.slice(1)] : command;
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
  const check = (name: string, probe: string[], expected: string, source: string, prefix = false) => {
    lines.push(
      `tool_actual=$(${probe.map(quote).join(" ")}) || { printf '%s\\n' ${quote(`workbench: cannot inspect ${name} for ${source}`)} >&2; exit 1; }`,
      `case "$tool_actual" in ${quote(expected)}${prefix ? "*" : ""}) ;; *) printf '%s\\n' ${quote(`workbench: ${name} must match ${source}: expected ${expected}; run workbench tools install or supply matching tools on PATH`)} "actual: $tool_actual" >&2; exit 1;; esac`,
    );
  };
  const report = (name: string, probe: string[]) => {
    lines.push(
      `printf '%s\\n' ${quote(`Toolchain (${managed ? "pinned environment" : "host"}): ${name}`)}`,
      probe.map(quote).join(" "),
    );
  };
  const nodeFile = join(directory, ".node-version");
  if (existsSync(nodeFile)) {
    const version = exactVersion(readText(nodeFile).trim(), nodeFile);
    if (!managed) check("Node.js", ["node", "--version"], `v${version}`, ".node-version");
    report("Node.js", ["node", "--version"]);
  }
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
    lines.push(
      `tool_llvm_version=${quote(version)}`,
      "for tool_llvm in clang clang++ clang-format clang-tidy llvm-cov llvm-profdata; do",
    );
    if (!managed)
      lines.push(
        'tool_actual=$("$tool_llvm" --version)',
        `case "$tool_actual" in *"version $tool_llvm_version"|*"version $tool_llvm_version"[!0-9.]*) ;; *) printf '%s\\n' "workbench: $tool_llvm must match .llvm-version $tool_llvm_version; run workbench tools install or supply matching tools on PATH" >&2; exit 1;; esac`,
      );
    lines.push(
      `printf '%s\\n' "Toolchain (${managed ? "pinned environment" : "host"}): $tool_llvm"`,
      '"$tool_llvm" --version',
      "done",
    );
  }
  if (compiler) {
    const compilerTools: [string, string][] =
      compiler.family === "gcc"
        ? [
            ["WORKBENCH_CC", "gcc"],
            ["WORKBENCH_CXX", "g++"],
          ]
        : [
            ["WORKBENCH_CC", "clang"],
            ["WORKBENCH_CXX", "clang++"],
          ];
    for (const [variable, name] of compilerTools) {
      const probe = ["sh", "-c", `exec "\${${variable}:-${name}}" "$@"`, "workbench-compiler"];
      if (compiler.family === "gcc") {
        if (!managed || selection.compilerVersion !== undefined)
          check(name, [...probe, "-dumpfullversion"], compiler.version, ".gcc-version / compiler selection");
      } else if (!managed || selection.compilerVersion !== undefined) {
        lines.push(
          `tool_actual=$(${probe.map(quote).join(" ")} --version)`,
          `case "$tool_actual" in *${quote(`version ${compiler.version}`)}|*${quote(`version ${compiler.version}`)}[!0-9.]*) ;; *) printf '%s\\n' ${quote(`workbench: selected compiler must match ${compiler.version}`)} >&2; exit 1;; esac`,
        );
      }
      report(name, [...probe, "--version"]);
    }
  }
  const goFile = join(directory, ".go-version");
  if (existsSync(goFile)) {
    const version = exactVersion(readText(goFile).trim(), goFile);
    lines.push("export GOTOOLCHAIN=local");
    if (!managed) check("Go", ["go", "version"], `go version go${version} `, ".go-version", true);
    report("Go", ["go", "version"]);
  }
  const rustFile = join(directory, "rust-toolchain.toml");
  if (existsSync(rustFile)) {
    const data = readToml(rustFile) as { toolchain?: { channel?: unknown } };
    const version = exactVersion(data.toolchain?.channel, rustFile);
    lines.push("export RUSTUP_AUTO_INSTALL=0");
    if (!managed) {
      check("Rust", ["rustc", "--version"], `rustc ${version} `, "rust-toolchain.toml", true);
      check("Cargo", ["cargo", "--version"], `cargo ${version} `, "rust-toolchain.toml", true);
    }
    for (const tool of ["rustc", "cargo", "rustfmt", "cargo-clippy"]) report(tool, [tool, "--version"]);
  }
  const pythonFile = join(directory, ".python-version");
  if (existsSync(pythonFile)) {
    const version = exactVersion(readText(pythonFile).trim(), pythonFile);
    const python = ["sh", "-c", 'exec "${WORKBENCH_PYTHON:-python3}" "$@"', "workbench-python"];
    if (!managed)
      check(
        "Python",
        [...python, "-c", "import platform; print(platform.python_implementation(), platform.python_version())"],
        `CPython ${version}`,
        ".python-version",
      );
    report("Python", [...python, "--version"]);
    // Force uv to use the interpreter just verified, including when an old .venv exists.
    lines.push(
      "UV_PYTHON=$(\"${WORKBENCH_PYTHON:-python3}\" -c 'import os, sys; print(os.path.realpath(sys.executable))')",
      "export UV_PYTHON UV_PYTHON_DOWNLOADS=never",
    );
  }
  for (const [tool, version] of standaloneTools(directory)) {
    const probe = tool.startsWith("cargo-") ? ["cargo", tool.slice(6), "--version"] : [tool, "--version"];
    if (!managed)
      lines.push(
        `tool_actual=$(${probe.map(quote).join(" ")})`,
        "tool_match=false",
        "set -f",
        // The pinned PyPI Ninja wheel reports its upstream version plus Kitware's build suffix.
        `for tool_word in $tool_actual; do case "$tool_word" in ${quote(version)}|${quote(`v${version}`)}${tool === "ninja" ? `|${quote(`${version}.git.kitware.`)}*` : ""}) tool_match=true;; esac; done`,
        `"$tool_match" || { printf '%s\\n' ${quote(`workbench: ${tool} must match .tool-versions: expected ${version}; run workbench tools install or supply matching tools on PATH`)} "$tool_actual" >&2; exit 1; }`,
      );
    report(tool, probe);
  }
  if (!lines.length) return command;
  lines.push('exec "$@"');
  return ["sh", "-eu", "-c", lines.join("\n"), "workbench-toolchain", ...command];
}
