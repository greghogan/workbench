import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { prepareVcpkg } from "../src/vcpkg.ts";
import { execute } from "../src/tool-downloads.ts";
import { buildPaths, prepareBuild } from "../src/builds.ts";

let temporary;
afterEach(() => {
  vi.unstubAllEnvs();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

test("vcpkg refuses mutable recipes and unsafe build paths without altering the checkout", () => {
  temporary = mkdtempSync(join(tmpdir(), "workbench-vcpkg-"));
  const root = join(temporary, "project");
  mkdirSync(root);
  const cache = join(temporary, "cache");
  vi.stubEnv("WORKBENCH_DATA_HOME", join(temporary, "data"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", cache);
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  const paths = buildPaths(root, root, "native");
  prepareBuild(paths);
  vi.stubEnv("WORKBENCH_BUILD_DIR", paths.directory);
  const source = join(root, "source");
  mkdirSync(source);
  const git = (args) => execute("git", args, { cwd: source, capture: true });
  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(source, "recipe"), "pinned");
  git(["add", "recipe"]);
  git(["commit", "-m", "fixture"]);
  const revision = git(["rev-parse", "HEAD"]).trim();
  const installation = join(cache, "toolchains/vcpkg", revision, `${process.platform}-${process.arch}`);
  execute("git", ["clone", source, installation], { capture: true });
  if (process.platform === "win32")
    execute("git", ["config", "--local", "core.longpaths", "false"], { cwd: installation });
  writeFileSync(join(installation, process.platform === "win32" ? "vcpkg.exe" : "vcpkg"), "fixture");
  const build = join(paths.directory, "debug");
  writeFileSync(join(root, ".vcpkg-version"), "latest");
  expect(() => prepareVcpkg(root, build)).toThrow(/complete Git commit/);
  writeFileSync(join(root, ".vcpkg-version"), revision);
  writeFileSync(join(root, "vcpkg.json"), JSON.stringify({ "builtin-baseline": "latest" }));
  expect(() => prepareVcpkg(root, build)).toThrow(/immutable default-registry baseline/);
  writeFileSync(join(root, "vcpkg.json"), JSON.stringify({ "builtin-baseline": revision }));
  expect(() => prepareVcpkg(root, root)).toThrow(/child/);
  expect(() => prepareVcpkg(root, join(root, "../outside"))).toThrow(/child/);
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), build, process.platform === "win32" ? "junction" : "dir");
  expect(() => prepareVcpkg(root, build)).toThrow(/symlink/);
  rmSync(build);
  writeFileSync(join(installation, "recipe"), "unreviewed changes");
  expect(() => prepareVcpkg(root, build)).toThrow(/modified or incomplete/);
  expect(readFileSync(join(installation, "recipe"), "utf8")).toBe("unreviewed changes");
  expect(existsSync(build)).toBe(false);
  writeFileSync(join(installation, "recipe"), "pinned");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["clang", "clang++", "gcc", "g++"]) {
    const path = join(bin, process.platform === "win32" ? `${name}.exe` : name);
    writeFileSync(path, "fixture");
    chmodSync(path, 0o755);
  }
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
  prepareVcpkg(root, build);
  prepareVcpkg(root, build);
  expect(readFileSync(join(build, "workbench-compiler.cmake"), "utf8")).toContain("clang++");
  if (process.platform === "win32") {
    expect(
      execute("git", ["config", "--local", "--get", "core.longpaths"], { cwd: installation, capture: true }).trim(),
    ).toBe("true");
    const port = join(build, "vcpkg_buildtrees", "versioning_", "versions", "a".repeat(80), "b".repeat(80));
    const globalConfig = join(temporary, "empty-gitconfig");
    writeFileSync(globalConfig, "");
    mkdirSync(port, { recursive: true });
    // Git resolves its working directory before loading local config; test long output paths after startup.
    execute(
      "git",
      [
        "--git-dir",
        join(installation, ".git"),
        "--work-tree",
        installation,
        "checkout-index",
        "-af",
        `--prefix=${port.replaceAll("\\", "/")}/`,
      ],
      {
        capture: true,
        env: { ...process.env, GIT_CONFIG_COUNT: "0", GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
    expect(readFileSync(join(port, "recipe"), "utf8")).toBe("pinned");
    const chainload = readFileSync(join(build, "workbench-compiler.cmake"), "utf8");
    expect(chainload).toContain('set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")');
    expect(chainload).not.toContain("toolchains/windows.cmake");
    expect(readFileSync(join(build, "workbench-vcpkg.cmake"), "utf8")).toContain("VCPKG_KEEP_ENV_VARS");
    const sanitized = join(paths.directory, "sanitized");
    prepareVcpkg(root, sanitized, "clang", true);
    expect(readFileSync(join(sanitized, "workbench-compiler.cmake"), "utf8")).toContain("-fsanitize=address");
    expect(readFileSync(join(sanitized, "workbench-vcpkg.cmake"), "utf8")).toContain("clang-asan-windows");
  }
  const gccBuild = join(paths.directory, "gcc");
  prepareVcpkg(root, gccBuild, "gcc");
  const gcc = readFileSync(join(gccBuild, "workbench-compiler.cmake"), "utf8");
  expect(gcc).toContain("g++");
  expect(gcc).not.toContain("clang");
  expect(readFileSync(join(gccBuild, "workbench-vcpkg.cmake"), "utf8")).toContain("workbench-gcc");
  vi.stubEnv("WORKBENCH_COMPILER", "gcc");
  vi.stubEnv("WORKBENCH_CXX", join(bin, "g++"));
  vi.stubEnv("WORKBENCH_CXX_STANDARD", "23");
  const analysis = join(paths.directory, "analysis");
  prepareVcpkg(root, analysis, "clang");
  const analyzer = readFileSync(join(analysis, "workbench-compiler.cmake"), "utf8");
  expect(analyzer).toContain("clang++");
  expect(analyzer).toContain("--gcc-toolchain=");
  expect(analyzer).not.toContain("CMAKE_CXX_STANDARD");
  expect(analyzer).not.toContain("CMAKE_C_STANDARD");
  expect(existsSync(join(build, "workbench-vcpkg.cmake"))).toBe(true);
  expect(execute("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: installation, capture: true })).toBe(
    "",
  );
});
