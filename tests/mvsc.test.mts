import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { compilerEnvironment, selectedCompiler } from "../src/compilers.ts";
import { mvscLayout, microsoftEnvironment, MicrosoftSDKResolver, windowsSDKVersion } from "../src/mvsc.ts";
import { ciMatrix } from "../src/ci.ts";
import { ciTargets } from "../src/ci-targets.ts";
import { nativeInstallationPlan } from "../src/native-tools.ts";
import { validateToolProfiles } from "../src/profile-schema.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(standard = "20", lto = "full") {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", join(import.meta.dirname, ".."));
  const root = mkdtempSync(join(tmpdir(), "workbench-mvsc-"));
  temporary.push(root);
  mkdirSync(join(root, "workbench"));
  writeFileSync(join(root, ".llvm-version"), "23.1.4\n");
  writeFileSync(join(root, ".mvsc-version"), "14.44.35207\n");
  writeFileSync(join(root, ".windows-sdk-version"), "10.0.26100.0\n");
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    `[[project]]
id="app"
path="."
[[language_root]]
language="cpp"
path="."
compiler="clang"
standard="${standard}"
lto="${lto}"
compilers.clang={minimum="23.1.4",ci_versions=["23.1.4"]}
compilers.mvsc={minimum="14.44.35207",ci_versions=["14.44.35207"]}
`,
  );
  return root;
}

test("mvsc is an independent compiler selection with exact toolset and SDK pins", () => {
  const root = fixture();
  expect(selectedCompiler(root, { compiler: "mvsc" })).toMatchObject({
    family: "mvsc",
    version: "14.44.35207",
    standard: "20",
    lto: "full",
  });
  expect(compilerEnvironment(root, { compiler: "mvsc" })).toMatchObject({
    WORKBENCH_COMPILER: "mvsc",
    WORKBENCH_COMPILER_VERSION: "14.44.35207",
    WORKBENCH_CXX_STANDARD: "20",
  });
  expect(selectedCompiler(root)?.family).toBe("clang");
  expect(windowsSDKVersion(root)).toBe("10.0.26100.0");
  expect(nativeInstallationPlan(root, ".", { compiler: "mvsc" })).toContainEqual({
    root: ".",
    tool: "mvsc",
    version: "14.44.35207",
    manager: "visual-studio",
  });
  writeFileSync(join(root, ".windows-sdk-version"), "latest");
  expect(() => windowsSDKVersion(root)).toThrow(/exact four-component/);
  expect(() => selectedCompiler(root, { compiler: "msvc" })).toThrow(/supported family/);
  expect(() => selectedCompiler(root, { compiler: "mvsc", environment: "nix" })).toThrow(/native Windows/);
  expect(() => selectedCompiler(root, { compiler: "mvsc", compilerVersion: "14.43.34808" })).toThrow(/below/);
});

test("mvsc rejects unsupported standards and ThinLTO instead of silently changing the target", () => {
  for (const standard of ["98", "11", "23", "26"])
    expect(() => selectedCompiler(fixture(standard), { compiler: "mvsc" })).toThrow(/cannot enforce/);
  expect(() => selectedCompiler(fixture("20", "thin"), { compiler: "mvsc" })).toThrow(/thin LTO/);
  for (const platforms of [undefined, ["linux-x64"], ["windows-x64", "linux-x64"]])
    expect(() => {
      validateToolProfiles(
        [{ name: "mvsc", paths: ["."], compiler: "mvsc", ...(platforms ? { platforms } : {}) }],
        "test",
      );
    }).toThrow(/windows-x64/);
});

test("selected SDK paths and flags replace ambient compiler settings, preserving unrelated tools", () => {
  const layout = mvscLayout("C:\\Visual Studio", "14.44.35207", "D:\\Windows Kits\\10", "10.0.26100.0");
  const base = {
    Path: "C:\\Git\\bin;C:\\Node",
    CL: "/Dsurprise",
    _CL_: "/O1",
    LINK: "/DEBUG",
    include: "old",
    LIB: "old",
    CPATH: "/nix/store/headers",
    CXXFLAGS: "-O0",
    WORKBENCH_BUILD_DIR: "D:\\build",
  };
  const env = microsoftEnvironment(
    {
      layout,
      identity: { version: 2, toolset: layout.toolset, sdk: layout.sdk, components: [] },
      fingerprint: "binary-identity",
    },
    base,
  );
  expect(env.WORKBENCH_CC).toBe("C:/Visual Studio/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/cl.exe");
  expect(env.WORKBENCH_CXX).toBe(env.WORKBENCH_CC);
  expect(env.PATH?.endsWith(base.Path)).toBe(true);
  expect(env.Path).toBeUndefined();
  for (const key of ["CL", "_CL_", "LINK", "include", "CPATH", "CXXFLAGS"]) expect(env[key]).toBeUndefined();
  expect(env.INCLUDE).toContain("D:\\Windows Kits\\10\\Include\\10.0.26100.0\\ucrt");
  expect(env.LIB).not.toContain("old");
  expect(env.WORKBENCH_MVSC_IDENTITY).toBe("binary-identity");
  expect(env.WORKBENCH_BUILD_DIR).toBe(base.WORKBENCH_BUILD_DIR);
  expect(base.CL).toBe("/Dsurprise");
  expect(() => mvscLayout("C:\\VS", "14.44 & injected", "C:\\SDK", "10.0.26100.0")).toThrow(/exact/);
});

test.skipIf(process.platform === "win32")("SDK execution fails explicitly outside Windows", () => {
  expect(() => new MicrosoftSDKResolver().resolve(fixture(), "14.44.35207")).toThrow(/native Windows x64/);
});

test("Microsoft compatibility and development profiles select Windows runners for both languages", () => {
  const root = join(import.meta.dirname, "..");
  const targets = ciTargets(root).filter((target) => target.kind === "native" && target.toolchain === "mvsc");
  expect(targets.map((target) => [target.path, target.os, target.architecture])).toEqual([
    ["examples/languages/c", "windows", "x64"],
    ["examples/languages/cpp", "windows", "x64"],
  ]);
  expect(targets.every((target) => target.checks.some((check) => check.role === "sanitizers"))).toBe(true);
  const consumer = fixture();
  writeFileSync(
    join(consumer, "workbench/config.toml"),
    'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[ci]\noperating_systems=["windows"]\n',
  );
  writeFileSync(
    join(consumer, "workbench/automation.toml"),
    '[[check]]\nname="Tests"\nrole="test"\ncommand=["echo","test"]\n',
  );
  expect(ciMatrix(consumer).compatibility.include.filter((target) => target.runtime === "mvsc")).toEqual([
    expect.objectContaining({ runner: "windows-2025", architecture: "x64", version: "14.44.35207" }),
  ]);
});
