import { required } from "../src/invariants.ts";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { compilerPolicy, selectedCompiler, compilerEnvironment } from "../src/compilers.ts";
import { nativeEnvironment } from "../src/native-tools.ts";
import { nativeTools } from "../src/native-assets.ts";
import { buildPaths, prepareBuild, assertBuildOutput } from "../src/builds.ts";
import { guardToolchains } from "../src/toolchains.ts";
import { spawnSync } from "node:child_process";

const temporary: (string | undefined)[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0))
    rmSync(required(root, "Fixture value root"), { recursive: true, force: true });
});
function fixture() {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", resolve(import.meta.dirname, ".."));
  const root = mkdtempSync(join(tmpdir(), "workbench-compilers-"));
  temporary.push(root);
  mkdirSync(join(root, "workbench"));
  const registry = `[[project]]
id = "app"
path = "."
[[language_root]]
language = "cpp"
path = "."
standard = "20"
compiler = "clang"
compilers.clang = { minimum = "22.1.8", ci_versions = ["22.1.8", "23.1.3"] }
compilers.gcc = { minimum = "14.4.0", ci_versions = ["14.4.0", "16.2.0"] }
`;
  writeFileSync(join(root, "workbench/projects.toml"), registry);
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(join(root, ".llvm-version"), "23.1.3");
  writeFileSync(join(root, ".gcc-version"), "16.2.0");
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", join(root, "..", `${basename(root)}-storage`));
  temporary.push(process.env.WORKBENCH_STORAGE_ROOT);
  return {
    root,
    registry,
    save: (body: string | NodeJS.ArrayBufferView) => {
      writeFileSync(join(root, "workbench/projects.toml"), body);
    },
  };
}

test("LLVM is always selected, GCC is required only for the selected family, and compatibility overrides preserve pins", () => {
  const { root, registry, save } = fixture();
  expect(nativeTools(root).map((tool) => tool.name)).toEqual(
    process.platform === "linux" ? ["llvm", "llvm-runtime"] : ["llvm"],
  );
  expect(selectedCompiler(root)).toEqual({
    family: "clang",
    version: "23.1.3",
    minimum: "22.1.8",
    standard: "20",
    standards: { cpp: "20" },
  });
  const selection = { compiler: "gcc", compilerVersion: "14.4.0" };
  expect(nativeTools(root, undefined, selection).map((tool) => [tool.name, tool.version])).toEqual([
    ["llvm", "23.1.3"],
    ...(process.platform === "linux" ? [["llvm-runtime", "70.1-2"]] : []),
    ["gcc", "14.4.0"],
  ]);
  expect(readFileSync(join(root, ".gcc-version"), "utf8")).toBe("16.2.0");
  expect(compilerEnvironment(root, selection).WORKBENCH_LANGUAGE_STANDARD).toBe("20");
  save(registry.replace('compiler = "clang"', 'compiler = "gcc"'));
  expect(nativeTools(root).map((tool) => tool.name)).toEqual(
    process.platform === "linux" ? ["llvm", "llvm-runtime", "gcc"] : ["llvm", "gcc"],
  );
  expect(() => selectedCompiler(root, { compiler: "gcc", compilerVersion: "13.4.0" })).toThrow(/below/);
  expect(() => selectedCompiler(root, { compilerVersion: "14.4.0" })).toThrow(/requires --compiler/);
  expect(() => selectedCompiler(root, { compiler: "msvc" })).toThrow(/supported family/);
});

test.skipIf(process.platform !== "linux")(
  "paths inspects the named compiler profile without creating build storage",
  () => {
    const { root } = fixture();
    writeFileSync(
      join(root, "workbench/config.toml"),
      'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[[toolchains.profiles]]\nname="gcc-current"\npaths=["."]\ncompiler="gcc"\n',
    );
    const selected = buildPaths(root, root, "native", { toolchain: "gcc-current" });
    const ordinary = buildPaths(root, root, "native");
    expect(selected.directory).not.toBe(ordinary.directory);
    const result = spawnSync(
      process.execPath,
      [
        join(resolve(import.meta.dirname, ".."), "bin/workbench.mjs"),
        "paths",
        "--environment",
        "native",
        "--toolchain",
        "gcc-current",
      ],
      { cwd: root, env: { ...process.env, WORKBENCH_PROJECT_ROOT: root }, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as { variables: Record<string, string> }).variables.WORKBENCH_DIST_DIR).toBe(
      join(selected.directory, "dist"),
    );
    expect(existsSync(selected.base)).toBe(false);
  },
);

test("invalid compiler policies fail before tool installation or cache creation", () => {
  const { root, registry, save } = fixture();
  for (const [body, error] of [
    [registry.replace('standard = "20"', 'standard = "bogus"'), /standard/],
    [registry.replace('"14.4.0", "16.2.0"', '"14.4.0", "14.4.0"'), /duplicates/],
    [registry.replace('ci_versions = ["14.4.0", "16.2.0"]', "ci_versions = []"), /nonempty/],
    [registry.replace('"14.4.0", "16.2.0"', '"13.4.0", "16.2.0"'), /below/],
    [registry.replace('language = "cpp"', 'language = "python"'), /C\/C\+\+/],
    [registry.replace('minimum = "14.4.0"', 'minimum = "14"'), /exact/],
    [registry.replace('minimum = "14.4.0"', 'ci_architectures = [], minimum = "14.4.0"'), /at least one selection/],
    [registry.replace('minimum = "14.4.0"', 'ci_architectures = ["arm"], minimum = "14.4.0"'), /x64 or arm64/],
    [registry.replace('minimum = "14.4.0"', 'ci_architectures = ["arm64", "arm64"], minimum = "14.4.0"'), /duplicate/],
    [
      registry.replace('compiler = "clang"', 'compiler = "gcc"').replace(/compilers.gcc = .*\n/, ""),
      /declared compiler/,
    ],
  ] as const) {
    save(required(body, "Fixture value body"));
    expect(() => compilerPolicy(root)).toThrow(error);
  }
  save(registry);
  rmSync(join(root, ".llvm-version"));
  expect(() => compilerPolicy(root)).toThrow(/requires .llvm-version/);
});

test("C and C++ sharing one root retain independent standards and require matching compiler policies", () => {
  const { root, registry, save } = fixture();
  const c = registry
    .slice(registry.indexOf("[[language_root]]"))
    .replace('language = "cpp"', 'language = "c"')
    .replace('standard = "20"', 'standard = "17"');
  save(registry + c);
  const env = compilerEnvironment(root);
  expect(env.WORKBENCH_C_STANDARD).toBe("17");
  expect(env.WORKBENCH_CXX_STANDARD).toBe("20");
  save(registry + c.replace('compiler = "clang"', 'compiler = "gcc"'));
  expect(() => compilerPolicy(root)).toThrow(/agree on compiler policy/);
  save(registry + c.replace('minimum = "14.4.0"', 'ci_architectures = ["arm64"], minimum = "14.4.0"'));
  expect(() => compilerPolicy(root)).toThrow(/agree on compiler policy/);
  save(registry + c.replace('minimum = "14.4.0"', 'ci_architectures = ["x64"], minimum = "14.4.0"'));
  expect(required(compilerPolicy(root), "Expected fixture value: compilerPolicy(root)").standards).toEqual({
    cpp: "20",
    c: "17",
  });
});

test("compiler families, versions, and language standards isolate both external and local builds", () => {
  const { root, registry, save } = fixture();
  const clang = buildPaths(root, root, "native");
  const gcc = buildPaths(root, root, "native", { compiler: "gcc" });
  const older = buildPaths(root, root, "native", { compiler: "gcc", compilerVersion: "14.4.0" });
  expect(new Set([clang.directory, gcc.directory, older.directory]).size).toBe(3);
  expect(clang.dependencies).not.toBe(gcc.dependencies);
  save(registry.replace('standard = "20"', 'standard = "23"'));
  expect(buildPaths(root, root, "native").directory).not.toBe(clang.directory);
  save(registry + 'lto = "full"\n');
  const full = buildPaths(root, root, "native");
  expect(full.directory).not.toBe(clang.directory);
  expect(full.dependencies).not.toBe(clang.dependencies);
  expect(compilerEnvironment(root).WORKBENCH_LTO).toBe("full");
  save(registry + 'lto = "thin"\n');
  expect(buildPaths(root, root, "native").directory).not.toBe(full.directory);
  expect(compilerEnvironment(root).WORKBENCH_LTO).toBe("thin");
  save(registry);
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "false");
  const local = buildPaths(root, root, "native");
  prepareBuild(local);
  vi.stubEnv("WORKBENCH_BUILD_DIR", local.directory);
  expect(() => {
    assertBuildOutput(join(local.directory, "debug"));
  }).not.toThrow();
});

test("native build identities change with tool-cache locations and artifact filter policy", () => {
  const { root } = fixture();
  const native = buildPaths(root, root, "native");
  const guix = buildPaths(root, root, "guix");
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "tool-cache"));
  const relocated = buildPaths(root, root, "native");
  expect(relocated.directory).not.toBe(native.directory);
  expect(buildPaths(root, root, "guix").directory).toBe(guix.directory);
  const definition = join(root, "workbench/languages/cpp");
  cpSync(
    join(
      required(process.env.WORKBENCH_DISTRIBUTION_ROOT, "Fixture value process.env.WORKBENCH_DISTRIBUTION_ROOT"),
      "languages/cpp",
    ),
    definition,
    { recursive: true },
  );
  const filterPath = join(definition, "llvm-filter.json");
  const filter = JSON.parse(readFileSync(filterPath, "utf8")) as { revision: number };
  filter.revision += 1;
  writeFileSync(filterPath, JSON.stringify(filter));
  expect(buildPaths(root, root, "native").directory).not.toBe(relocated.directory);
});

test("native selection keeps the LLVM tool family on PATH while selecting a different compiler", () => {
  const { root } = fixture();
  const distribution = join(root, "distribution");
  mkdirSync(join(distribution, "scripts"), { recursive: true });
  writeFileSync(join(distribution, ".node-version"), "24.21.0");
  writeFileSync(join(distribution, "scripts/llvm-assets.json"), "{}");
  writeFileSync(join(distribution, "scripts/native-assets.json"), "{}");
  vi.stubEnv("WORKBENCH_CC", "/stale/gcc");
  expect(nativeEnvironment(root, distribution).WORKBENCH_CC).toBeUndefined();
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["clang", "clang++", "clang-format", "clang-tidy", "llvm-cov", "llvm-profdata"])
    writeFileSync(join(bin, name), "#!/bin/sh\nprintf 'version 23.1.3\\n'\n", { mode: 0o755 });
  for (const name of ["gcc", "g++"])
    writeFileSync(
      join(bin, name),
      "#!/bin/sh\nif [ \"$1\" = '-dumpfullversion' ]; then echo 16.2.0; else echo 'gcc 16.2.0'; fi\n",
      { mode: 0o755 },
    );
  const command = guardToolchains(root, ["true"], false, { compiler: "gcc" });
  expect(command.every((argument) => Buffer.byteLength(argument) <= 4096)).toBe(true);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKBENCH_CC: join(bin, "gcc"),
    WORKBENCH_CXX: join(bin, "g++"),
    PATH: `${bin}${delimiter}${String(process.env.PATH)}`,
  };
  delete env.CPATH;
  delete env.C_INCLUDE_PATH;
  delete env.CPLUS_INCLUDE_PATH;
  delete env.LIBRARY_PATH;
  expect(spawnSync(required(command[0], "Compiler command"), command.slice(1), { env }).status).toBe(0);
  writeFileSync(join(bin, "g++"), "#!/bin/sh\necho 15.3.0\n", { mode: 0o755 });
  expect(spawnSync(required(command[0], "Compiler command"), command.slice(1), { env }).status).not.toBe(0);
});
