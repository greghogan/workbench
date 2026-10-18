import assert from "node:assert/strict";
import type { SpawnSyncOptions } from "node:child_process";

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.cwd();
if (!process.argv[3]) throw new Error("Supply the pinned Workbench directory through the configured command");
const distribution = resolve(process.argv[3]);
const { cpuBudget } = (await import(
  pathToFileURL(join(distribution, "scripts/cpu-budget.mjs")).href
)) as typeof import("../../../../scripts/cpu-budget.mjs");

const { emitCheckDetail } = (await import(
  pathToFileURL(join(distribution, "scripts/check-detail-data.mjs")).href
)) as typeof import("../../../../scripts/check-detail-data.mjs");
const role = process.argv[2];
const configuredBuilds = process.env.WORKBENCH_BUILD_DIR;
if (!configuredBuilds) throw new Error("use Workbench checks or a configured Workbench shell for native builds");
const builds = configuredBuilds;
const debug = join(builds, "debug");
const policy = JSON.parse(readFileSync("workbench/quality.json", "utf8")) as {
  slow_test_seconds: number;
  coverage: Record<string, number>;
};
const suffix = process.platform === "win32" ? ".exe" : "";
const selectedCompiler = process.env.WORKBENCH_COMPILER ?? "clang";
const managed = process.env.WORKBENCH_MANAGED_COMPILER === "1";
const parallelism = String(cpuBudget());
process.env.CTEST_PARALLEL_LEVEL = parallelism;
function run(command: string, args: string[] = [], options: Omit<SpawnSyncOptions, "encoding"> = {}) {
  const result: import("node:child_process").SpawnSyncReturns<string | null> = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${String(result.error ?? result.status)}`);
  return result.stdout ?? "";
}
function collectCMakeFailureLogs(directory: string) {
  const detection = join(directory, "vcpkg_buildtrees", "detect_compiler");
  try {
    if (!existsSync(detection)) return;
    const output = join(root, "coverage", "cmake", relative(builds, directory).replaceAll(sep, "-"));
    for (const path of files(detection).filter((path: string) => path.endsWith(".log"))) {
      const destination = join(output, relative(detection, path));
      mkdirSync(join(destination, ".."), { recursive: true });
      copyFileSync(path, destination);
      if (/-(out|err)\.log$/.test(path))
        console.error(`${path}\n${readFileSync(path, "utf8").slice(-8192).split(/\r?\n/).slice(-40).join("\n")}`);
    }
    console.error(`Compiler detection logs: ${output}`);
  } catch (error) {
    console.error(`Could not retain compiler detection logs: ${String(error)}`);
  }
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
const sources = ["src", "include", "tests"].flatMap(files).filter((file) => /\.(?:c|cpp|h|hpp)$/.test(file));
function compilerArguments(compiler = selectedCompiler) {
  const executable = compiler === selectedCompiler ? process.env.WORKBENCH_CC : undefined;
  return [`-DCMAKE_C_COMPILER=${executable ?? (compiler === "gcc" ? "gcc" : "clang")}`];
}
function configure(directory: string, options: string[] = [], compiler = selectedCompiler) {
  if (!managed) {
    run(process.execPath, [
      join(distribution, "bin/workbench.mjs"),
      "vcpkg-prepare",
      root,
      directory,
      "--compiler",
      compiler,
      ...(options.includes("-DWORKBENCH_SANITIZERS=ON") ? ["--sanitizers"] : []),
    ]);
    process.env.VCPKG_DISABLE_METRICS = "1";
    process.env.VCPKG_FORCE_SYSTEM_BINARIES = "1";
    delete process.env.VCPKG_FORCE_DOWNLOADED_BINARIES;
    process.env.VCPKG_MAX_CONCURRENCY = parallelism;
  }
  try {
    run("cmake", [
      "-S",
      ".",
      "-B",
      directory,
      "-G",
      "Ninja",
      "-DCMAKE_BUILD_TYPE=Debug",
      "-DWORKBENCH_LTO=off",
      "-DWORKBENCH_COVERAGE=OFF",
      "-DWORKBENCH_SANITIZERS=OFF",
      "-DWORKBENCH_PORTABLE_ONLY=OFF",
      ...(managed
        ? compilerArguments(compiler)
        : [`-DCMAKE_TOOLCHAIN_FILE=${join(directory, "workbench-vcpkg.cmake")}`]),
      ...(process.env.WORKBENCH_LANGUAGE_STANDARD
        ? [`-DWORKBENCH_LANGUAGE_STANDARD=${process.env.WORKBENCH_LANGUAGE_STANDARD}`]
        : []),
      `-DWORKBENCH_COMPILER_FAMILY=${compiler}`,
      `-DWORKBENCH_COMPILER_MINIMUM=${compiler === selectedCompiler ? (process.env.WORKBENCH_COMPILER_MINIMUM ?? "") : ""}`,
      ...(process.platform === "win32" && options.includes("-DWORKBENCH_SANITIZERS=ON")
        ? ["-DCMAKE_BUILD_TYPE=RelWithDebInfo"]
        : []),
      ...options,
    ]);
  } catch (error) {
    collectCMakeFailureLogs(directory);
    throw error;
  }
}
function test(directory: string, profiles?: string) {
  mkdirSync("coverage", { recursive: true });
  const results = join(root, "coverage", `tests-${directory.slice(builds.length + 1).replaceAll(sep, "-")}.xml`);
  run("cmake", ["--build", directory, "--parallel", parallelism]);
  run("ctest", ["--test-dir", directory, "--output-on-failure", "--no-tests=error", "--output-junit", results], {
    env: { ...process.env, ...(profiles ? { LLVM_PROFILE_FILE: join(profiles, "%p-%m.profraw") } : {}) },
  });
  const report = readFileSync(results, "utf8");
  for (const match of report.matchAll(/<testcase\b([^>]+)>/g)) {
    assert.ok(match[1], "Missing testcase attributes");
    const name = /\bname="([^"]+)"/.exec(match[1])?.[1];
    const elapsed = Number(/\btime="([^"]+)"/.exec(match[1])?.[1]);
    if (role !== "coverage" && elapsed > policy.slow_test_seconds) {
      emitCheckDetail({
        version: 1,
        kind: "slow",
        scope: "test",
        name: String(name),
        elapsedSeconds: elapsed,
        thresholdSeconds: policy.slow_test_seconds,
      });
      console.error(
        `SLOW test ${String(name)}: ${String(elapsed)}s (soft cap ${String(policy.slow_test_seconds)}s; advisory only)`,
      );
    }
  }
}

function verifyRelease(directory: string) {
  test(directory);
  run(process.execPath, [fileURLToPath(new URL("./release-verify.mjs", import.meta.url)), directory]);
}

function rejectLto(name: string, options: string[], diagnostic: RegExp) {
  // Reuse the verified off-mode dependency installation, without reinstalling dependencies.
  const result: import("node:child_process").SpawnSyncReturns<string | null> = spawnSync(
    "cmake",
    [
      "-S",
      ".",
      "-B",
      join(builds, `lto-reject-${name}`),
      "-G",
      "Ninja",
      ...(managed
        ? compilerArguments()
        : [
            `-DCMAKE_TOOLCHAIN_FILE=${join(builds, "lto-off", "workbench-vcpkg.cmake")}`,
            "-DVCPKG_MANIFEST_INSTALL=OFF",
          ]),
      "-DCMAKE_BUILD_TYPE=Release",
      "-DWORKBENCH_LTO=full",
      ...options,
    ],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error || result.status === null || result.status === 0 || !diagnostic.test(output))
    throw new Error(`Expected LTO rejection for ${name}: ${result.error ?? output}`);
  console.log(`Verified LTO rejection: ${name}`);
}

if (role === "format" || role === "format-write") {
  run("clang-format", [...(role === "format" ? ["--dry-run", "--Werror"] : ["-i"]), ...sources]);
} else if (role === "lint") {
  run("clang-tidy", ["--verify-config"]);
  const analysis = selectedCompiler === "clang" ? debug : join(builds, "analysis-clang");
  configure(analysis, [], "clang");
  run("cmake", ["--build", analysis, "--parallel", parallelism]);
  for (const source of sources.filter((file) => /\.(?:c|cpp)$/.test(file))) run("clang-tidy", ["-p", analysis, source]);
} else if (role === "build" || role === "release") {
  const directory = role === "release" ? join(builds, "release") : debug;
  configure(
    directory,
    role === "release" ? ["-DCMAKE_BUILD_TYPE=Release", `-DWORKBENCH_LTO=${process.env.WORKBENCH_LTO ?? "off"}`] : [],
  );
  if (role === "release") {
    verifyRelease(directory);
    const output = resolve(process.env.WORKBENCH_RELEASE_OUTPUT ?? process.env.WORKBENCH_DIST_DIR ?? "dist");
    mkdirSync(output, { recursive: true });
    copyFileSync(join(directory, `count${suffix}`), join(output, `count${suffix}`));
    copyFileSync("LICENSE", join(output, "LICENSE"));
  } else run("cmake", ["--build", directory, "--parallel", parallelism]);
} else if (role === "lto") {
  for (const mode of selectedCompiler === "clang" ? ["off", "thin", "full"] : ["off", "full"]) {
    const directory = join(builds, `lto-${mode}`);
    configure(directory, ["-DCMAKE_BUILD_TYPE=Release", `-DWORKBENCH_LTO=${mode}`]);
    verifyRelease(directory);
  }
  rejectLto("invalid", ["-DWORKBENCH_LTO=unknown"], /must select off, thin, or full/);
  rejectLto("debug", ["-DCMAKE_BUILD_TYPE=Debug"], /separate optimized single-configuration build/);
  rejectLto("coverage", ["-DWORKBENCH_COVERAGE=ON"], /separate LTO build from coverage and sanitizers/);
  rejectLto("sanitizers", ["-DWORKBENCH_SANITIZERS=ON"], /separate LTO build from coverage and sanitizers/);
  if (selectedCompiler === "gcc")
    rejectLto("thin", ["-DWORKBENCH_LTO=thin"], /does not support the requested LTO mode/);
  else rejectLto("tool-version", [`-Dlto_linker=${process.execPath}`], /must match Clang/);
} else if (role === "test") {
  configure(debug);
  test(debug);
} else if (role === "coverage") {
  if (existsSync("coverage") && lstatSync("coverage").isSymbolicLink())
    throw new Error("coverage must be a real directory");
  mkdirSync("coverage", { recursive: true });
  for (const name of readdirSync("coverage"))
    if (name !== "coverage-summary.json") rmSync(join("coverage", name), { recursive: true, force: true });
  if (selectedCompiler !== "clang") {
    configure(debug);
    test(debug);
  }
  const instrumented = join(builds, "coverage");
  configure(instrumented, ["-DWORKBENCH_COVERAGE=ON"], "clang");
  const temporary = mkdtempSync(join(instrumented, "profiles-"));
  try {
    test(instrumented, temporary);
    const profiles = files(temporary).filter((file: string) => file.endsWith(".profraw"));
    if (!profiles.length) throw new Error("coverage produced no execution profiles");
    const merged = join(temporary, "merged.profdata");
    run("llvm-profdata", ["merge", "-sparse", ...profiles, "-o", merged]);
    const sourceFiles = sources.filter((file) => !file.startsWith(`tests${sep}`));
    const coverageArgs = [
      join(instrumented, `count_test${suffix}`),
      "-object",
      join(instrumented, `count${suffix}`),
      `-instr-profile=${merged}`,
      ...sourceFiles,
    ];
    run("llvm-cov", ["report", ...coverageArgs]);
    const report = JSON.parse(run("llvm-cov", ["export", ...coverageArgs], { stdio: "pipe" })) as {
      data: { totals: Record<string, { count: number; percent: number }> }[];
    };
    writeFileSync("coverage/report.json", JSON.stringify(report));
    assert.ok(report.data[0], "LLVM coverage did not report totals");
    const total = report.data[0].totals;
    for (const [metric, minimum] of Object.entries(policy.coverage)) {
      if (!total[metric] || total[metric].count === 0 || total[metric].percent < minimum)
        throw new Error(
          `${metric} coverage ${String(total[metric]?.percent ?? "missing")}% is below ${String(minimum)}%`,
        );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
} else if (role === "sanitizers") {
  configure(join(builds, "sanitizers"), ["-DWORKBENCH_SANITIZERS=ON"]);
  test(join(builds, "sanitizers"));
  configure(join(builds, "portable"), ["-DWORKBENCH_SANITIZERS=ON", "-DWORKBENCH_PORTABLE_ONLY=ON"]);
  test(join(builds, "portable"));
} else {
  throw new Error("expected build, release, format, format-write, lint, test, coverage, sanitizers, or lto");
}
