import { required } from "./invariants.js";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { readText } from "./core.js";
import { assertBuildOutput } from "./builds.js";
import { execute } from "./tool-downloads.js";
import { userDirectory } from "./storage.js";
import { type CompilerFamily } from "./compilers.js";

function cmake(value: string): string {
  if (/[\r\n;]/.test(value) || value.includes("]=]"))
    throw new Error("CMake tool paths cannot contain newlines, semicolons, or ]=]");
  return `[=[${value.replaceAll("\\", "/")}]=]`;
}

/** The checkout pins the bootstrap and recipes; manifests independently pin registry resolution. */
export function prepareVcpkg(
  directory: string,
  build: string,
  family: CompilerFamily = process.env.WORKBENCH_COMPILER === "gcc" ? "gcc" : "clang",
): void {
  directory = resolve(directory);
  build = resolve(build);
  assertBuildOutput(build);
  const revision = readText(join(directory, ".vcpkg-version")).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(".vcpkg-version must pin a complete Git commit");
  const manifest = JSON.parse(readText(join(directory, "vcpkg.json"))) as { "builtin-baseline"?: string };
  const configuration = join(directory, "vcpkg-configuration.json");
  const registry = existsSync(configuration)
    ? (JSON.parse(readText(configuration)) as { "default-registry"?: { baseline?: string } })["default-registry"]
    : undefined;
  if (!/^[a-f0-9]{40}$/.test(registry?.baseline ?? manifest["builtin-baseline"] ?? ""))
    throw new Error("vcpkg requires an immutable default-registry baseline or builtin-baseline");
  const installation = join(
    userDirectory("data"),
    "toolchains",
    "vcpkg",
    revision,
    `${process.platform}-${process.arch}`,
  );
  const executable = join(installation, process.platform === "win32" ? "vcpkg.exe" : "vcpkg");
  const downloads = resolve(process.env.VCPKG_DOWNLOADS ?? join(userDirectory("cache"), "vcpkg", "downloads"));
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VCPKG_DISABLE_METRICS: "1",
    VCPKG_FORCE_SYSTEM_BINARIES: "1",
    VCPKG_DOWNLOADS: downloads,
  };
  delete env.VCPKG_FORCE_DOWNLOADED_BINARIES;
  if (!existsSync(installation)) {
    mkdirSync(dirname(installation), { recursive: true, mode: 0o700 });
    const staging = `${installation}.${randomUUID()}.partial`;
    try {
      execute("git", [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "https://github.com/microsoft/vcpkg.git",
        staging,
      ]);
      execute("git", ["checkout", "--detach", revision], { cwd: staging });
      if (process.platform === "win32")
        execute("cmd.exe", ["/d", "/c", "bootstrap-vcpkg.bat", "-disableMetrics"], { cwd: staging, env });
      else execute("sh", ["bootstrap-vcpkg.sh", "-disableMetrics"], { cwd: staging, env });
      try {
        renameSync(staging, installation);
      } catch (error) {
        if (!existsSync(executable)) throw error;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  const head = execute("git", ["rev-parse", "HEAD"], { cwd: installation, capture: true }).trim();
  const changed = execute("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: installation,
    capture: true,
  }).trim();
  if (head !== revision || changed || !existsSync(executable))
    throw new Error(`${installation}: vcpkg must match its pinned checkout; refusing modified or incomplete tools`);
  const architecture = ({ x64: "x64", arm64: "arm64" } as Record<string, string>)[process.arch];
  const system = ({ linux: "linux", darwin: "osx", win32: "windows" } as Record<string, string>)[process.platform];
  if (!architecture || !system) throw new Error(`no vcpkg reference target for ${process.platform}/${process.arch}`);
  mkdirSync(build, { recursive: true });
  const compiler = (name: string) =>
    required(
      execute(
        process.platform === "win32" ? "where.exe" : "sh",
        process.platform === "win32" ? [name] : ["-c", 'command -v "$1"', "compiler", name],
        { capture: true },
      )
        .trim()
        .split(/\r?\n/)[0],
      'expected execute(\n      process.platform === "win32" ? "where.exe" : "sh",\n      process.platform === "win32" ? [name] : ["-c", \'command -v "$1"\', "compiler", name],\n      { capture: true },\n    )\n      .trim()\n      .split(/\\r?\\n/)[0]',
    );
  const chainload = join(build, "workbench-compiler.cmake");
  const gccSdk =
    family === "clang" && process.env.WORKBENCH_COMPILER === "gcc" && process.env.WORKBENCH_CXX
      ? dirname(dirname(process.env.WORKBENCH_CXX))
      : undefined;
  writeFileSync(
    chainload,
    [
      `set(CMAKE_C_COMPILER ${cmake(compiler(family === process.env.WORKBENCH_COMPILER && process.env.WORKBENCH_CC ? process.env.WORKBENCH_CC : family === "gcc" ? "gcc" : "clang"))})`,
      `set(CMAKE_CXX_COMPILER ${cmake(compiler(family === process.env.WORKBENCH_COMPILER && process.env.WORKBENCH_CXX ? process.env.WORKBENCH_CXX : family === "gcc" ? "g++" : "clang++"))})`,
      ...(process.env.WORKBENCH_C_STANDARD
        ? [`set(CMAKE_C_STANDARD ${cmake(process.env.WORKBENCH_C_STANDARD)} CACHE STRING "")`]
        : []),
      ...(process.env.WORKBENCH_CXX_STANDARD
        ? [`set(CMAKE_CXX_STANDARD ${cmake(process.env.WORKBENCH_CXX_STANDARD)} CACHE STRING "")`]
        : []),
      ...(gccSdk
        ? [
            `set(CMAKE_C_FLAGS_INIT ${cmake(`"--gcc-toolchain=${gccSdk}"`)})`,
            `set(CMAKE_CXX_FLAGS_INIT ${cmake(`"--gcc-toolchain=${gccSdk}"`)})`,
          ]
        : []),
      `include(${cmake(join(installation, `scripts/toolchains/${system}.cmake`))})`,
      "",
    ].join("\n"),
  );
  const triplet = `${architecture}-workbench-${family}-${system}`;
  const systemName = ({ linux: "Linux", osx: "Darwin", windows: "" } as Record<string, string>)[system];
  writeFileSync(
    join(build, `${triplet}.cmake`),
    [
      `set(VCPKG_TARGET_ARCHITECTURE ${architecture})`,
      `set(VCPKG_CMAKE_SYSTEM_NAME "${String(systemName)}")`,
      "set(VCPKG_LIBRARY_LINKAGE static)",
      "set(VCPKG_CRT_LINKAGE dynamic)",
      `set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE ${cmake(chainload)})`,
      'set(VCPKG_ENV_PASSTHROUGH "CPATH;C_INCLUDE_PATH;CPLUS_INCLUDE_PATH;LIBRARY_PATH;NIX_CFLAGS_COMPILE;NIX_LDFLAGS;SDKROOT;MACOSX_DEPLOYMENT_TARGET")',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(build, "workbench-vcpkg.cmake"),
    [
      `set(VCPKG_TARGET_TRIPLET ${triplet} CACHE STRING "")`,
      `set(VCPKG_HOST_TRIPLET ${triplet} CACHE STRING "")`,
      `set(VCPKG_OVERLAY_TRIPLETS ${cmake(build)} CACHE STRING "")`,
      `set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE ${cmake(chainload)} CACHE FILEPATH "")`,
      `set(VCPKG_INSTALLED_DIR ${cmake(join(build, "vcpkg_installed"))} CACHE PATH "")`,
      `set(ENV{VCPKG_DOWNLOADS} ${cmake(downloads)})`,
      `set(VCPKG_INSTALL_OPTIONS ${cmake(`--x-buildtrees-root=${join(build, "vcpkg_buildtrees")}`)} ${cmake(`--x-packages-root=${join(build, "vcpkg_packages")}`)})`,
      `include(${cmake(join(installation, "scripts/buildsystems/vcpkg.cmake"))})`,
      "",
    ].join("\n"),
  );
}
