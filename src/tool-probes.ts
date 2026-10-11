/** Package-owned executable contracts. Package names never imply executable names or arguments. */
export interface ToolProbe {
  name: string;
  executable: string;
  args: string[];
  expected?: string;
  match?: "exact" | "prefix" | "word" | "llvm" | "ninja";
  windowsSuffix?: string;
  reportArgs?: string[];
  compilerVariable?: "WORKBENCH_CC" | "WORKBENCH_CXX";
}

interface ProbeTool {
  name: string;
  version: string;
  source: string;
}

export function toolProbes(tool: ProbeTool, purpose: "development" | "compatibility" = "development"): ToolProbe[] {
  const { name, version } = tool;
  const probe = (executable: string, label = executable): ToolProbe => ({
    name: label,
    executable,
    args: ["--version"],
    expected: version,
    match: "word",
  });
  switch (name) {
    case "php":
      return [{ ...probe("php", "PHP"), args: ["-r", "echo PHP_VERSION;"], match: "exact" }];
    case "ruby":
      return [
        {
          ...probe("ruby", "Ruby"),
          args: ["-rzlib", "-ropenssl", "-rpsych", "-e", "print RUBY_VERSION"],
          match: "exact",
        },
      ];
    case "java":
      return [
        { ...probe("java", "Java runtime"), expected: `build ${version}`, match: "llvm" },
        {
          ...probe("javac", "Java compiler"),
          expected: `javac ${version.split("+").shift() ?? version}`,
          match: "exact",
        },
      ];
    case "maven":
      return [{ ...probe("mvn", "Maven"), expected: `Apache Maven ${version}`, match: "prefix", windowsSuffix: "" }];
    case "node":
      return [{ ...probe("node", "Node.js"), expected: `v${version}`, match: "exact" }];
    case "go":
      return [{ ...probe("go", "Go"), args: ["version"], expected: `go version go${version} `, match: "prefix" }];
    case "python":
      return [
        {
          ...probe("python3", "Python"),
          args: ["-c", "import platform; print(platform.python_implementation(), platform.python_version())"],
          expected: `CPython ${version}`,
          match: "exact",
          reportArgs: ["--version"],
        },
      ];
    case "rust":
      return [
        { ...probe("rustc", "Rust"), expected: `rustc ${version} `, match: "prefix" },
        { ...probe("cargo", "Cargo"), expected: `cargo ${version} `, match: "prefix" },
        ...(purpose === "development"
          ? [
              { name: "rustfmt", executable: "rustfmt", args: ["--version"] },
              { name: "cargo-clippy", executable: "cargo-clippy", args: ["--version"] },
            ]
          : []),
      ];
    // rustup selects the dated nightly; Miri's own version is not the Rust release number.
    case "miri":
      return [{ name: "Miri", executable: "cargo", args: ["miri", "--version"] }];
    case "llvm":
      return ["clang", "clang++", "clang-format", "clang-tidy", "llvm-cov", "llvm-profdata"].map((executable) => ({
        ...probe(executable),
        expected: `version ${version}`,
        match: "llvm",
      }));
    case "clang":
      return ["clang", "clang++"].map((executable, index) => ({
        ...probe(executable),
        expected: `version ${version}`,
        match: "llvm",
        compilerVariable: index === 0 ? "WORKBENCH_CC" : "WORKBENCH_CXX",
      }));
    case "gcc":
      return ["gcc", "g++"].map((executable, index) => ({
        ...probe(executable),
        args: ["-dumpfullversion"],
        match: "exact",
        reportArgs: ["--version"],
        compilerVariable: index === 0 ? "WORKBENCH_CC" : "WORKBENCH_CXX",
      }));
    case "uv":
      return [probe("uv")];
    case "cmake":
      return [probe("cmake")];
    case "ninja":
      return [{ ...probe("ninja"), match: "ninja" }];
    case "shellcheck":
      return [probe("shellcheck")];
    case "shfmt":
      return [probe("shfmt")];
    case "actionlint":
      return [probe("actionlint")];
    case "cargo-nextest":
      return [probe("cargo-nextest")];
    case "cargo-llvm-cov":
      return [{ ...probe("cargo-llvm-cov"), args: ["llvm-cov", "--version"] }];
    case "rustup-init":
      return [probe("rustup-init")];
    // This package supplies shared libraries. Authentication/extraction validates it; it has no executable.
    case "llvm-xml-runtime":
    case "llvm-runtime":
      return [];
    default:
      throw new Error(`${tool.source}: no explicit verification probes declared for ${name}`);
  }
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Shared shell matcher, emitted once per guard to keep command arguments bounded. */
export const probePrelude = String.raw`workbench_probe() {
  tool_name=$1 tool_source=$2 tool_expected=$3 tool_mode=$4 tool_enforce=$5 tool_environment=$6 tool_output=$7
  shift 7
  tool_actual=$("$@") || { printf 'workbench: cannot execute %s for %s; run workbench tools install or supply matching tools on PATH\n' "$tool_name" "$tool_source" >&2; exit 1; }
  tool_actual=$(printf "%s" "$tool_actual" | tr -d "\r")
  if [ "$tool_enforce" = true ] && [ "$tool_mode" != none ]; then
    tool_match=false
    case "$tool_mode" in
      exact) case "$tool_actual" in "$tool_expected") tool_match=true;; esac;;
      prefix) case "$tool_actual" in "$tool_expected"*) tool_match=true;; esac;;
      llvm) case "$tool_actual" in *"$tool_expected"|*"$tool_expected"[!0-9.]*) tool_match=true;; esac;;
      word|ninja)
        set -f
        for tool_word in $tool_actual; do
          case "$tool_word" in "$tool_expected"|"v$tool_expected") tool_match=true;; esac
          if [ "$tool_mode" = ninja ]; then
            case "$tool_word" in "$tool_expected".git.kitware.*) tool_match=true;; esac
          fi
        done;;
    esac
    "$tool_match" || { printf 'workbench: %s must match %s: expected %s; run workbench tools install or supply matching tools on PATH\n%s\n' "$tool_name" "$tool_source" "$tool_expected" "$tool_actual" >&2; exit 1; }
  fi
  printf 'Toolchain (%s): %s\n' "$tool_environment" "$tool_name"
  if [ "$tool_output" = true ]; then printf '%s\n' "$tool_actual"; fi
}`;

/** Explicit executable arguments and version matching, shared by installation and environment checks. */
export function probeScript(
  probe: ToolProbe,
  command: string[],
  source: string,
  enforce: boolean,
  managed = false,
): string[] {
  const lines = [
    [
      "workbench_probe",
      probe.name,
      source,
      probe.expected ?? "",
      probe.expected === undefined ? "none" : (probe.match ?? "exact"),
      String(enforce),
      managed ? "pinned environment" : "host",
      String(!probe.reportArgs),
      ...command,
    ]
      .map(quote)
      .join(" "),
  ];
  if (probe.reportArgs)
    lines.push([...command.slice(0, command.length - probe.args.length), ...probe.reportArgs].map(quote).join(" "));
  return lines;
}
