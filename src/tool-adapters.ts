import { compilerBaseline } from "../scripts/compiler-catalog.mjs";
import type { ToolProbe } from "./tool-probes.js";
export interface ProbeTool {
  name: string;
  version: string;
  source: string;
}
export interface ToolAdapter {
  installer: "artifact" | "rustup" | "uv" | "visual-studio";
  environment: "artifact" | "rustup" | "python" | "sdk";
  dependencies: readonly string[];
  artifactEnvironment?: "php" | "go" | "java" | "llvm" | "compiler" | "libraries";
  probes: (tool: ProbeTool, purpose: "development" | "compatibility") => ToolProbe[];
}
const probeFor =
  (version: string) =>
  (executable: string, label = executable): ToolProbe => ({
    name: label,
    executable,
    args: ["--version"],
    expected: version,
    match: "word",
  });
const adapters: Record<string, ToolAdapter> = {
  "chromium-headless-shell": {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [probe("chrome-headless-shell")];
    },
  },
  php: {
    artifactEnvironment: "php",
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [{ ...probe("php", "PHP"), args: ["-r", "echo PHP_VERSION;"], match: "exact" }];
    },
  },
  ruby: {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [
        {
          ...probe("ruby", "Ruby"),
          args: ["-rzlib", "-ropenssl", "-rpsych", "-e", "print RUBY_VERSION"],
          match: "exact",
        },
      ];
    },
  },
  java: {
    artifactEnvironment: "java",
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [
        { ...probe("java", "Java runtime"), expected: `build ${version}`, match: "llvm" },
        {
          ...probe("javac", "Java compiler"),
          expected: `javac ${version.split("+").shift() ?? version}`,
          match: "exact",
        },
      ];
    },
  },
  maven: {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [{ ...probe("mvn", "Maven"), expected: `Apache Maven ${version}`, match: "prefix", windowsSuffix: "" }];
    },
  },
  node: {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [{ ...probe("node", "Node.js"), expected: `v${version}`, match: "exact" }];
    },
  },
  go: {
    artifactEnvironment: "go",
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [{ ...probe("go", "Go"), args: ["version"], expected: `go version go${version} `, match: "prefix" }];
    },
  },
  python: {
    installer: "uv",
    environment: "python",
    dependencies: ["uv"],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [
        {
          ...probe("python3", "Python"),
          args: ["-B", "-c", "import platform; print(platform.python_implementation(), platform.python_version())"],
          expected: `CPython ${version}`,
          match: "exact",
          reportArgs: ["--version"],
        },
      ];
    },
  },
  rust: {
    installer: "rustup",
    environment: "rustup",
    dependencies: [],
    probes: ({ version }, purpose) => {
      const probe = probeFor(version);
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
    },
  },
  miri: {
    installer: "rustup",
    environment: "rustup",
    dependencies: [],
    probes: () => {
      return [{ name: "Miri", executable: "cargo", args: ["miri", "--version"] }];
    },
  },
  llvm: {
    artifactEnvironment: "llvm",
    installer: "artifact",
    environment: "artifact",
    dependencies: ["llvm-runtime", "llvm-xml-runtime"],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return ["clang", "clang++", "clang-format", "clang-tidy", "llvm-cov", "llvm-profdata"].map((executable) => ({
        ...probe(executable),
        expected: `version ${version}`,
        match: "llvm",
      }));
    },
  },
  clang: {
    artifactEnvironment: "compiler",
    installer: "artifact",
    environment: "artifact",
    dependencies: ["llvm-runtime", "llvm-xml-runtime"],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return ["clang", "clang++"].map((executable, index) => ({
        ...probe(executable),
        expected: `version ${version}`,
        match: "llvm",
        compilerVariable: index === 0 ? "WORKBENCH_CC" : "WORKBENCH_CXX",
      }));
    },
  },
  mvsc: {
    installer: "visual-studio",
    environment: "sdk",
    dependencies: [],
    probes: ({ version }) => {
      return [
        {
          name: `MSVC toolset ${version}`,
          executable: "cl",
          // The dash spelling avoids Git Bash/MSYS treating /? as a filesystem path.
          args: ["-?"],
          expected: `Version ${compilerBaseline("mvsc", version)}.`,
          match: "contains",
          compilerVariable: "WORKBENCH_MVSC_CC",
          showOutput: false,
        },
      ];
    },
  },
  gcc: {
    artifactEnvironment: "compiler",
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return ["gcc", "g++"].map((executable, index) => ({
        ...probe(executable),
        args: ["-dumpfullversion"],
        match: "exact",
        reportArgs: ["--version"],
        compilerVariable: index === 0 ? "WORKBENCH_CC" : "WORKBENCH_CXX",
      }));
    },
  },
  uv: {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [probe("uv")];
    },
  },
  cmake: {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [probe("cmake")];
    },
  },
  ninja: {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [{ ...probe("ninja"), match: "ninja" }];
    },
  },
  shellcheck: {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [probe("shellcheck")];
    },
  },
  shfmt: {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [probe("shfmt")];
    },
  },
  actionlint: {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [probe("actionlint")];
    },
  },
  "cargo-nextest": {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [probe("cargo-nextest")];
    },
  },
  "cargo-llvm-cov": {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [{ ...probe("cargo-llvm-cov"), args: ["llvm-cov", "--version"] }];
    },
  },
  "rustup-init": {
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: ({ version }) => {
      const probe = probeFor(version);
      return [probe("rustup-init")];
    },
  },
  "llvm-xml-runtime": {
    artifactEnvironment: "libraries",
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: () => {
      return [];
    },
  },
  "llvm-runtime": {
    artifactEnvironment: "libraries",
    installer: "artifact",
    environment: "artifact",
    dependencies: [],
    probes: () => {
      return [];
    },
  },
};
export function toolAdapter(tool: ProbeTool): ToolAdapter {
  const adapter = adapters[tool.name];
  if (!adapter) throw new Error(`${tool.source}: no explicit verification probes declared for ${tool.name}`);
  return adapter;
}
