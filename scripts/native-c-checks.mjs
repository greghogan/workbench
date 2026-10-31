// Generated from native-c-checks.mts; edit the TypeScript source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  copyFileSync
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { compilerCatalog, isCompilerFamily } from "./compiler-catalog.mjs";
async function runNativeChecks(language, distribution, role) {
  const root = realpathSync.native(process.cwd());
  const { cpuBudget } = await import(pathToFileURL(join(distribution, "scripts/cpu-budget.mjs")).href);
  const { emitCheckDetail } = await import(pathToFileURL(join(distribution, "scripts/check-detail-data.mjs")).href);
  const configuredBuilds = process.env.WORKBENCH_BUILD_DIR;
  if (!configuredBuilds) throw new Error("use Workbench checks or a configured Workbench shell for native builds");
  const builds = configuredBuilds;
  const debug = join(builds, "debug");
  const policy = JSON.parse(readFileSync("workbench/quality.json", "utf8"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  const requestedCompiler = process.env.WORKBENCH_COMPILER ?? "clang";
  if (!isCompilerFamily(requestedCompiler)) throw new Error("Select a declared native compiler");
  const selectedCompiler = requestedCompiler;
  if (process.platform === "win32" && selectedCompiler === "mvsc" && role !== "format" && role !== "format-write" && process.env.WORKBENCH_NATIVE_UTF8_CONSOLE !== "1") {
    const { runWindowsUtf8Console } = await import("./windows-utf8-console.mjs");
    await runWindowsUtf8Console(process.argv.slice(1), builds);
    return;
  }
  const managed = process.env.WORKBENCH_MANAGED_COMPILER === "1";
  const parallelism = String(cpuBudget());
  process.env.CTEST_PARALLEL_LEVEL = parallelism;
  function run(command, args = [], options = {}) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: "inherit",
      cwd: root,
      ...options
    });
    if (result.error || result.status !== 0)
      throw new Error(`${command} failed: ${String(result.error ?? result.status)}`);
    return result.stdout ?? "";
  }
  function collectCMakeFailureLogs(directory) {
    const buildtrees = join(directory, "bt");
    try {
      const output = join(root, "coverage", "cmake", relative(builds, directory).replaceAll(sep, "-"));
      const portLogs = existsSync(buildtrees) ? files(buildtrees).filter((path) => path.endsWith(".log") && lstatSync(path).isFile()) : [];
      for (const path of portLogs) {
        const destination = join(output, "vcpkg_buildtrees", relative(buildtrees, path));
        mkdirSync(join(destination, ".."), { recursive: true });
        copyFileSync(path, destination);
        if (/-(out|err)\.log$/.test(path))
          console.error(`${path}
${readFileSync(path, "utf8").slice(-8192).split(/\r?\n/).slice(-40).join("\n")}`);
      }
      const manifest = join(directory, "vcpkg-manifest-install.log");
      if (existsSync(manifest) && lstatSync(manifest).isFile()) {
        mkdirSync(output, { recursive: true });
        copyFileSync(manifest, join(output, "vcpkg-manifest-install.log"));
        console.error(
          `${manifest}
${readFileSync(manifest, "utf8").slice(-8192).split(/\r?\n/).slice(-40).join("\n")}`
        );
      }
      if (portLogs.length || existsSync(manifest)) console.error(`CMake failure logs: ${output}`);
    } catch (error) {
      console.error(`Could not retain CMake failure logs: ${String(error)}`);
    }
  }
  function files(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(
      (entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]
    );
  }
  const sources = ["src", "include", "tests"].flatMap(files).filter((file) => /\.(?:c|cpp|h|hpp)$/.test(file));
  function compilerArguments(compiler = selectedCompiler) {
    const executable = compiler === selectedCompiler ? process.env[language === "c" ? "WORKBENCH_CC" : "WORKBENCH_CXX"] : void 0;
    return [
      `-DCMAKE_${language === "c" ? "C" : "CXX"}_COMPILER=${executable ?? compilerCatalog[compiler].executables[language]}`
    ];
  }
  function configure(directory, options = [], compiler = selectedCompiler) {
    if (!managed) {
      run(process.execPath, [
        join(distribution, "bin/workbench.mjs"),
        "vcpkg-prepare",
        root,
        directory,
        "--compiler",
        compiler,
        ...options.includes("-DWORKBENCH_SANITIZERS=ON") ? ["--sanitizers"] : []
      ]);
      process.env.VCPKG_DISABLE_METRICS = "1";
      process.env.VCPKG_FORCE_SYSTEM_BINARIES = "1";
      delete process.env.VCPKG_FORCE_DOWNLOADED_BINARIES;
      process.env.VCPKG_MAX_CONCURRENCY = parallelism;
    }
    try {
      run("cmake", [
        "-S",
        root,
        "-B",
        directory,
        "-G",
        "Ninja",
        "-DCMAKE_BUILD_TYPE=Debug",
        "-DWORKBENCH_LTO=off",
        "-DWORKBENCH_COVERAGE=OFF",
        "-DWORKBENCH_SANITIZERS=OFF",
        "-DWORKBENCH_PORTABLE_ONLY=OFF",
        ...managed ? compilerArguments(compiler) : [`-DCMAKE_TOOLCHAIN_FILE=${join(directory, "workbench-vcpkg.cmake")}`],
        ...process.env[language === "c" ? "WORKBENCH_C_STANDARD" : "WORKBENCH_CXX_STANDARD"] ?? process.env.WORKBENCH_LANGUAGE_STANDARD ? [
          `-DWORKBENCH_LANGUAGE_STANDARD=${process.env[language === "c" ? "WORKBENCH_C_STANDARD" : "WORKBENCH_CXX_STANDARD"] ?? process.env.WORKBENCH_LANGUAGE_STANDARD ?? ""}`
        ] : [],
        `-DWORKBENCH_COMPILER_FAMILY=${compiler}`,
        `-DWORKBENCH_COMPILER_MINIMUM=${compiler === selectedCompiler ? process.env.WORKBENCH_COMPILER_MINIMUM ?? "" : ""}`,
        ...process.platform === "win32" && options.includes("-DWORKBENCH_SANITIZERS=ON") ? ["-DCMAKE_BUILD_TYPE=RelWithDebInfo"] : [],
        ...options
      ]);
    } catch (error) {
      collectCMakeFailureLogs(directory);
      throw error;
    }
  }
  function test(directory, profiles) {
    mkdirSync("coverage", { recursive: true });
    const results = join(root, "coverage", `tests-${directory.slice(builds.length + 1).replaceAll(sep, "-")}.xml`);
    run("cmake", ["--build", directory, "--parallel", parallelism]);
    run("ctest", ["--test-dir", directory, "--output-on-failure", "--no-tests=error", "--output-junit", results], {
      env: { ...process.env, ...profiles ? { LLVM_PROFILE_FILE: join(profiles, "%p-%m.profraw") } : {} }
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
          thresholdSeconds: policy.slow_test_seconds
        });
        console.error(
          `SLOW test ${String(name)}: ${String(elapsed)}s (soft cap ${String(policy.slow_test_seconds)}s; advisory only)`
        );
      }
    }
  }
  function verifyRelease(directory) {
    test(directory);
    run(process.execPath, [join(root, "scripts/release-verify.mjs"), directory]);
  }
  function rejectLto(name, options, diagnostic) {
    const result = spawnSync(
      "cmake",
      [
        "-S",
        ".",
        "-B",
        join(builds, `lto-reject-${name}`),
        "-G",
        "Ninja",
        ...managed ? compilerArguments() : [
          `-DCMAKE_TOOLCHAIN_FILE=${join(builds, "lto-off", "workbench-vcpkg.cmake")}`,
          "-DVCPKG_MANIFEST_INSTALL=OFF"
        ],
        "-DCMAKE_BUILD_TYPE=Release",
        "-DWORKBENCH_LTO=full",
        ...options
      ],
      { encoding: "utf8" }
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.error || result.status === null || result.status === 0 || !diagnostic.test(output))
      throw new Error(`Expected LTO rejection for ${name}: ${result.error ?? output}`);
    console.log(`Verified LTO rejection: ${name}`);
  }
  if (role === "format" || role === "format-write") {
    run("clang-format", [...role === "format" ? ["--dry-run", "--Werror"] : ["-i"], ...sources]);
  } else if (role === "lint") {
    run("clang-tidy", ["--verify-config"]);
    const analysis = selectedCompiler === "clang" ? debug : join(builds, "analysis-clang");
    configure(analysis, [], "clang");
    run("cmake", ["--build", analysis, "--parallel", parallelism]);
    for (const source of sources.filter((file) => /\.(?:c|cpp)$/.test(file)))
      run("clang-tidy", ["-p", analysis, source]);
  } else if (role === "build" || role === "release") {
    const directory = role === "release" ? join(builds, "release") : debug;
    configure(
      directory,
      role === "release" ? ["-DCMAKE_BUILD_TYPE=Release", `-DWORKBENCH_LTO=${process.env.WORKBENCH_LTO ?? "off"}`] : []
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
    if (selectedCompiler !== "clang")
      rejectLto("thin", ["-DWORKBENCH_LTO=thin"], /does not support the requested LTO mode/);
    else rejectLto("tool-version", [`-Dlto_linker=${process.execPath}`], /must match Clang/);
  } else if (role === "test") {
    configure(debug);
    test(debug);
  } else if (role === "coverage") {
    const { nativeCoverageSources, assertNativeCoverageScope } = await import("./native-coverage.mjs");
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
      const profiles = files(temporary).filter((file) => file.endsWith(".profraw"));
      if (!profiles.length) throw new Error("coverage produced no execution profiles");
      const merged = join(temporary, "merged.profdata");
      run("llvm-profdata", ["merge", "-sparse", ...profiles, "-o", merged]);
      const sourceFiles = nativeCoverageSources(sources.filter((file) => !file.startsWith(`tests${sep}`)));
      const coverageArgs = [
        join(instrumented, `count_test${suffix}`),
        "-object",
        join(instrumented, `count${suffix}`),
        "-object",
        join(instrumented, `cpu_test${suffix}`),
        `-instr-profile=${merged}`,
        ...sourceFiles
      ];
      run("llvm-cov", ["report", ...coverageArgs]);
      const report = JSON.parse(run("llvm-cov", ["export", ...coverageArgs], { stdio: "pipe" }));
      writeFileSync("coverage/report.json", JSON.stringify(report));
      assert.ok(report.data[0], "LLVM coverage did not report totals");
      assertNativeCoverageScope(
        report.data[0].files.map((file) => file.filename),
        sourceFiles
      );
      const total = report.data[0].totals;
      for (const [metric, minimum] of Object.entries(policy.coverage)) {
        if (!total[metric] || total[metric].count === 0 || total[metric].percent < minimum)
          throw new Error(
            `${metric} coverage ${String(total[metric]?.percent ?? "missing")}% is below ${String(minimum)}%`
          );
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } else if (role === "sanitizers") {
    configure(join(builds, "a"), ["-DWORKBENCH_SANITIZERS=ON"]);
    test(join(builds, "a"));
    configure(join(builds, "p"), ["-DWORKBENCH_SANITIZERS=ON", "-DWORKBENCH_PORTABLE_ONLY=ON"]);
    test(join(builds, "p"));
  } else {
    throw new Error("expected build, release, format, format-write, lint, test, coverage, sanitizers, or lto");
  }
}
export {
  runNativeChecks
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5hdGl2ZS1jLWNoZWNrcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyB0eXBlIFNwYXduU3luY09wdGlvbnMsIHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbHN0YXRTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIG1rZGlyU3luYyxcbiAgbWtkdGVtcFN5bmMsXG4gIHJtU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbiAgY29weUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuaW1wb3J0IHsgY29tcGlsZXJDYXRhbG9nLCBpc0NvbXBpbGVyRmFtaWx5LCB0eXBlIENvbXBpbGVyRmFtaWx5IH0gZnJvbSBcIi4vY29tcGlsZXItY2F0YWxvZy5tanNcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bk5hdGl2ZUNoZWNrcyhsYW5ndWFnZTogXCJjXCIgfCBcImNwcFwiLCBkaXN0cmlidXRpb246IHN0cmluZywgcm9sZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJvb3QgPSByZWFscGF0aFN5bmMubmF0aXZlKHByb2Nlc3MuY3dkKCkpO1xuICBjb25zdCB7IGNwdUJ1ZGdldCB9ID0gKGF3YWl0IGltcG9ydChcbiAgICBwYXRoVG9GaWxlVVJMKGpvaW4oZGlzdHJpYnV0aW9uLCBcInNjcmlwdHMvY3B1LWJ1ZGdldC5tanNcIikpLmhyZWZcbiAgKSkgYXMgdHlwZW9mIGltcG9ydChcIi4vY3B1LWJ1ZGdldC5tanNcIik7XG5cbiAgY29uc3QgeyBlbWl0Q2hlY2tEZXRhaWwgfSA9IChhd2FpdCBpbXBvcnQoXG4gICAgcGF0aFRvRmlsZVVSTChqb2luKGRpc3RyaWJ1dGlvbiwgXCJzY3JpcHRzL2NoZWNrLWRldGFpbC1kYXRhLm1qc1wiKSkuaHJlZlxuICApKSBhcyB0eXBlb2YgaW1wb3J0KFwiLi9jaGVjay1kZXRhaWwtZGF0YS5tanNcIik7XG4gIGNvbnN0IGNvbmZpZ3VyZWRCdWlsZHMgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQlVJTERfRElSO1xuICBpZiAoIWNvbmZpZ3VyZWRCdWlsZHMpIHRocm93IG5ldyBFcnJvcihcInVzZSBXb3JrYmVuY2ggY2hlY2tzIG9yIGEgY29uZmlndXJlZCBXb3JrYmVuY2ggc2hlbGwgZm9yIG5hdGl2ZSBidWlsZHNcIik7XG4gIGNvbnN0IGJ1aWxkcyA9IGNvbmZpZ3VyZWRCdWlsZHM7XG4gIGNvbnN0IGRlYnVnID0gam9pbihidWlsZHMsIFwiZGVidWdcIik7XG4gIGNvbnN0IHBvbGljeSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKFwid29ya2JlbmNoL3F1YWxpdHkuanNvblwiLCBcInV0ZjhcIikpIGFzIHtcbiAgICBzbG93X3Rlc3Rfc2Vjb25kczogbnVtYmVyO1xuICAgIGNvdmVyYWdlOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xuICB9O1xuICBjb25zdCBzdWZmaXggPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcIi5leGVcIiA6IFwiXCI7XG4gIGNvbnN0IHJlcXVlc3RlZENvbXBpbGVyID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NPTVBJTEVSID8/IFwiY2xhbmdcIjtcbiAgaWYgKCFpc0NvbXBpbGVyRmFtaWx5KHJlcXVlc3RlZENvbXBpbGVyKSkgdGhyb3cgbmV3IEVycm9yKFwiU2VsZWN0IGEgZGVjbGFyZWQgbmF0aXZlIGNvbXBpbGVyXCIpO1xuICBjb25zdCBzZWxlY3RlZENvbXBpbGVyOiBDb21waWxlckZhbWlseSA9IHJlcXVlc3RlZENvbXBpbGVyO1xuICBpZiAoXG4gICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiICYmXG4gICAgc2VsZWN0ZWRDb21waWxlciA9PT0gXCJtdnNjXCIgJiZcbiAgICByb2xlICE9PSBcImZvcm1hdFwiICYmXG4gICAgcm9sZSAhPT0gXCJmb3JtYXQtd3JpdGVcIiAmJlxuICAgIHByb2Nlc3MuZW52LldPUktCRU5DSF9OQVRJVkVfVVRGOF9DT05TT0xFICE9PSBcIjFcIlxuICApIHtcbiAgICBjb25zdCB7IHJ1bldpbmRvd3NVdGY4Q29uc29sZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi93aW5kb3dzLXV0ZjgtY29uc29sZS5tanNcIik7XG4gICAgYXdhaXQgcnVuV2luZG93c1V0ZjhDb25zb2xlKHByb2Nlc3MuYXJndi5zbGljZSgxKSwgYnVpbGRzKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbWFuYWdlZCA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0NPTVBJTEVSID09PSBcIjFcIjtcbiAgY29uc3QgcGFyYWxsZWxpc20gPSBTdHJpbmcoY3B1QnVkZ2V0KCkpO1xuICBwcm9jZXNzLmVudi5DVEVTVF9QQVJBTExFTF9MRVZFTCA9IHBhcmFsbGVsaXNtO1xuICBmdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSA9IFtdLCBvcHRpb25zOiBPbWl0PFNwYXduU3luY09wdGlvbnMsIFwiZW5jb2RpbmdcIj4gPSB7fSkge1xuICAgIGNvbnN0IHJlc3VsdDogaW1wb3J0KFwibm9kZTpjaGlsZF9wcm9jZXNzXCIpLlNwYXduU3luY1JldHVybnM8c3RyaW5nIHwgbnVsbD4gPSBzcGF3blN5bmMoY29tbWFuZCwgYXJncywge1xuICAgICAgZW5jb2Rpbmc6IFwidXRmOFwiLFxuICAgICAgc3RkaW86IFwiaW5oZXJpdFwiLFxuICAgICAgY3dkOiByb290LFxuICAgICAgLi4ub3B0aW9ucyxcbiAgICB9KTtcbiAgICBpZiAocmVzdWx0LmVycm9yIHx8IHJlc3VsdC5zdGF0dXMgIT09IDApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhyZXN1bHQuZXJyb3IgPz8gcmVzdWx0LnN0YXR1cyl9YCk7XG4gICAgcmV0dXJuIHJlc3VsdC5zdGRvdXQgPz8gXCJcIjtcbiAgfVxuICBmdW5jdGlvbiBjb2xsZWN0Q01ha2VGYWlsdXJlTG9ncyhkaXJlY3Rvcnk6IHN0cmluZykge1xuICAgIGNvbnN0IGJ1aWxkdHJlZXMgPSBqb2luKGRpcmVjdG9yeSwgXCJidFwiKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgb3V0cHV0ID0gam9pbihyb290LCBcImNvdmVyYWdlXCIsIFwiY21ha2VcIiwgcmVsYXRpdmUoYnVpbGRzLCBkaXJlY3RvcnkpLnJlcGxhY2VBbGwoc2VwLCBcIi1cIikpO1xuICAgICAgY29uc3QgcG9ydExvZ3MgPSBleGlzdHNTeW5jKGJ1aWxkdHJlZXMpXG4gICAgICAgID8gZmlsZXMoYnVpbGR0cmVlcykuZmlsdGVyKChwYXRoKSA9PiBwYXRoLmVuZHNXaXRoKFwiLmxvZ1wiKSAmJiBsc3RhdFN5bmMocGF0aCkuaXNGaWxlKCkpXG4gICAgICAgIDogW107XG4gICAgICBmb3IgKGNvbnN0IHBhdGggb2YgcG9ydExvZ3MpIHtcbiAgICAgICAgY29uc3QgZGVzdGluYXRpb24gPSBqb2luKG91dHB1dCwgXCJ2Y3BrZ19idWlsZHRyZWVzXCIsIHJlbGF0aXZlKGJ1aWxkdHJlZXMsIHBhdGgpKTtcbiAgICAgICAgbWtkaXJTeW5jKGpvaW4oZGVzdGluYXRpb24sIFwiLi5cIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICBjb3B5RmlsZVN5bmMocGF0aCwgZGVzdGluYXRpb24pO1xuICAgICAgICBpZiAoLy0ob3V0fGVycilcXC5sb2ckLy50ZXN0KHBhdGgpKVxuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYCR7cGF0aH1cXG4ke3JlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikuc2xpY2UoLTgxOTIpLnNwbGl0KC9cXHI/XFxuLykuc2xpY2UoLTQwKS5qb2luKFwiXFxuXCIpfWApO1xuICAgICAgfVxuICAgICAgLy8gQ29tcGlsZXIgZGV0ZWN0aW9uIGNhbiBzdWNjZWVkIGJlZm9yZSBhIGRlcGVuZGVuY3kgZmFpbHMuIFByZXNlcnZlIHRoZSBtYW5pZmVzdCdzIGFjdHVhbCBlcnJvcixcbiAgICAgIC8vIGFuZCBwcmludCBpdCBsYXN0IHNvIGJvdW5kZWQgdGVybWluYWwgZXhjZXJwdHMgcmV0YWluIHRoZSBjYXVzZSByYXRoZXIgdGhhbiBjb21waWxlciB3YXJuaW5ncy5cbiAgICAgIGNvbnN0IG1hbmlmZXN0ID0gam9pbihkaXJlY3RvcnksIFwidmNwa2ctbWFuaWZlc3QtaW5zdGFsbC5sb2dcIik7XG4gICAgICBpZiAoZXhpc3RzU3luYyhtYW5pZmVzdCkgJiYgbHN0YXRTeW5jKG1hbmlmZXN0KS5pc0ZpbGUoKSkge1xuICAgICAgICBta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgY29weUZpbGVTeW5jKG1hbmlmZXN0LCBqb2luKG91dHB1dCwgXCJ2Y3BrZy1tYW5pZmVzdC1pbnN0YWxsLmxvZ1wiKSk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICAgICAgYCR7bWFuaWZlc3R9XFxuJHtyZWFkRmlsZVN5bmMobWFuaWZlc3QsIFwidXRmOFwiKS5zbGljZSgtODE5Mikuc3BsaXQoL1xccj9cXG4vKS5zbGljZSgtNDApLmpvaW4oXCJcXG5cIil9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChwb3J0TG9ncy5sZW5ndGggfHwgZXhpc3RzU3luYyhtYW5pZmVzdCkpIGNvbnNvbGUuZXJyb3IoYENNYWtlIGZhaWx1cmUgbG9nczogJHtvdXRwdXR9YCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYENvdWxkIG5vdCByZXRhaW4gQ01ha2UgZmFpbHVyZSBsb2dzOiAke1N0cmluZyhlcnJvcil9YCk7XG4gICAgfVxuICB9XG4gIGZ1bmN0aW9uIGZpbGVzKGRpcmVjdG9yeTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgIHJldHVybiByZWFkZGlyU3luYyhkaXJlY3RvcnksIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KS5mbGF0TWFwKChlbnRyeSkgPT5cbiAgICAgIGVudHJ5LmlzRGlyZWN0b3J5KCkgPyBmaWxlcyhqb2luKGRpcmVjdG9yeSwgZW50cnkubmFtZSkpIDogW2pvaW4oZGlyZWN0b3J5LCBlbnRyeS5uYW1lKV0sXG4gICAgKTtcbiAgfVxuICBjb25zdCBzb3VyY2VzID0gW1wic3JjXCIsIFwiaW5jbHVkZVwiLCBcInRlc3RzXCJdLmZsYXRNYXAoZmlsZXMpLmZpbHRlcigoZmlsZSkgPT4gL1xcLig/OmN8Y3BwfGh8aHBwKSQvLnRlc3QoZmlsZSkpO1xuICBmdW5jdGlvbiBjb21waWxlckFyZ3VtZW50cyhjb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSBzZWxlY3RlZENvbXBpbGVyKSB7XG4gICAgY29uc3QgZXhlY3V0YWJsZSA9XG4gICAgICBjb21waWxlciA9PT0gc2VsZWN0ZWRDb21waWxlciA/IHByb2Nlc3MuZW52W2xhbmd1YWdlID09PSBcImNcIiA/IFwiV09SS0JFTkNIX0NDXCIgOiBcIldPUktCRU5DSF9DWFhcIl0gOiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIFtcbiAgICAgIGAtRENNQUtFXyR7bGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJDXCIgOiBcIkNYWFwifV9DT01QSUxFUj0ke2V4ZWN1dGFibGUgPz8gY29tcGlsZXJDYXRhbG9nW2NvbXBpbGVyXS5leGVjdXRhYmxlc1tsYW5ndWFnZV19YCxcbiAgICBdO1xuICB9XG4gIGZ1bmN0aW9uIGNvbmZpZ3VyZShkaXJlY3Rvcnk6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10gPSBbXSwgY29tcGlsZXI6IENvbXBpbGVyRmFtaWx5ID0gc2VsZWN0ZWRDb21waWxlcikge1xuICAgIGlmICghbWFuYWdlZCkge1xuICAgICAgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICAgICAgam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwidmNwa2ctcHJlcGFyZVwiLFxuICAgICAgICByb290LFxuICAgICAgICBkaXJlY3RvcnksXG4gICAgICAgIFwiLS1jb21waWxlclwiLFxuICAgICAgICBjb21waWxlcixcbiAgICAgICAgLi4uKG9wdGlvbnMuaW5jbHVkZXMoXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCIpID8gW1wiLS1zYW5pdGl6ZXJzXCJdIDogW10pLFxuICAgICAgXSk7XG4gICAgICBwcm9jZXNzLmVudi5WQ1BLR19ESVNBQkxFX01FVFJJQ1MgPSBcIjFcIjtcbiAgICAgIHByb2Nlc3MuZW52LlZDUEtHX0ZPUkNFX1NZU1RFTV9CSU5BUklFUyA9IFwiMVwiO1xuICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LlZDUEtHX0ZPUkNFX0RPV05MT0FERURfQklOQVJJRVM7XG4gICAgICBwcm9jZXNzLmVudi5WQ1BLR19NQVhfQ09OQ1VSUkVOQ1kgPSBwYXJhbGxlbGlzbTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIHJ1bihcImNtYWtlXCIsIFtcbiAgICAgICAgXCItU1wiLFxuICAgICAgICByb290LFxuICAgICAgICBcIi1CXCIsXG4gICAgICAgIGRpcmVjdG9yeSxcbiAgICAgICAgXCItR1wiLFxuICAgICAgICBcIk5pbmphXCIsXG4gICAgICAgIFwiLURDTUFLRV9CVUlMRF9UWVBFPURlYnVnXCIsXG4gICAgICAgIFwiLURXT1JLQkVOQ0hfTFRPPW9mZlwiLFxuICAgICAgICBcIi1EV09SS0JFTkNIX0NPVkVSQUdFPU9GRlwiLFxuICAgICAgICBcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T0ZGXCIsXG4gICAgICAgIFwiLURXT1JLQkVOQ0hfUE9SVEFCTEVfT05MWT1PRkZcIixcbiAgICAgICAgLi4uKG1hbmFnZWRcbiAgICAgICAgICA/IGNvbXBpbGVyQXJndW1lbnRzKGNvbXBpbGVyKVxuICAgICAgICAgIDogW2AtRENNQUtFX1RPT0xDSEFJTl9GSUxFPSR7am9pbihkaXJlY3RvcnksIFwid29ya2JlbmNoLXZjcGtnLmNtYWtlXCIpfWBdKSxcbiAgICAgICAgLi4uKChwcm9jZXNzLmVudltsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIldPUktCRU5DSF9DX1NUQU5EQVJEXCIgOiBcIldPUktCRU5DSF9DWFhfU1RBTkRBUkRcIl0gPz9cbiAgICAgICAgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEKVxuICAgICAgICAgID8gW1xuICAgICAgICAgICAgICBgLURXT1JLQkVOQ0hfTEFOR1VBR0VfU1RBTkRBUkQ9JHtwcm9jZXNzLmVudltsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIldPUktCRU5DSF9DX1NUQU5EQVJEXCIgOiBcIldPUktCRU5DSF9DWFhfU1RBTkRBUkRcIl0gPz8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEID8/IFwiXCJ9YCxcbiAgICAgICAgICAgIF1cbiAgICAgICAgICA6IFtdKSxcbiAgICAgICAgYC1EV09SS0JFTkNIX0NPTVBJTEVSX0ZBTUlMWT0ke2NvbXBpbGVyfWAsXG4gICAgICAgIGAtRFdPUktCRU5DSF9DT01QSUxFUl9NSU5JTVVNPSR7Y29tcGlsZXIgPT09IHNlbGVjdGVkQ29tcGlsZXIgPyAocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NPTVBJTEVSX01JTklNVU0gPz8gXCJcIikgOiBcIlwifWAsXG4gICAgICAgIC4uLihwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgJiYgb3B0aW9ucy5pbmNsdWRlcyhcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIilcbiAgICAgICAgICA/IFtcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxXaXRoRGViSW5mb1wiXVxuICAgICAgICAgIDogW10pLFxuICAgICAgICAuLi5vcHRpb25zLFxuICAgICAgXSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbGxlY3RDTWFrZUZhaWx1cmVMb2dzKGRpcmVjdG9yeSk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbiAgZnVuY3Rpb24gdGVzdChkaXJlY3Rvcnk6IHN0cmluZywgcHJvZmlsZXM/OiBzdHJpbmcpIHtcbiAgICBta2RpclN5bmMoXCJjb3ZlcmFnZVwiLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCByZXN1bHRzID0gam9pbihyb290LCBcImNvdmVyYWdlXCIsIGB0ZXN0cy0ke2RpcmVjdG9yeS5zbGljZShidWlsZHMubGVuZ3RoICsgMSkucmVwbGFjZUFsbChzZXAsIFwiLVwiKX0ueG1sYCk7XG4gICAgcnVuKFwiY21ha2VcIiwgW1wiLS1idWlsZFwiLCBkaXJlY3RvcnksIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICAgIHJ1bihcImN0ZXN0XCIsIFtcIi0tdGVzdC1kaXJcIiwgZGlyZWN0b3J5LCBcIi0tb3V0cHV0LW9uLWZhaWx1cmVcIiwgXCItLW5vLXRlc3RzPWVycm9yXCIsIFwiLS1vdXRwdXQtanVuaXRcIiwgcmVzdWx0c10sIHtcbiAgICAgIGVudjogeyAuLi5wcm9jZXNzLmVudiwgLi4uKHByb2ZpbGVzID8geyBMTFZNX1BST0ZJTEVfRklMRTogam9pbihwcm9maWxlcywgXCIlcC0lbS5wcm9mcmF3XCIpIH0gOiB7fSkgfSxcbiAgICB9KTtcbiAgICBjb25zdCByZXBvcnQgPSByZWFkRmlsZVN5bmMocmVzdWx0cywgXCJ1dGY4XCIpO1xuICAgIGZvciAoY29uc3QgbWF0Y2ggb2YgcmVwb3J0Lm1hdGNoQWxsKC88dGVzdGNhc2VcXGIoW14+XSspPi9nKSkge1xuICAgICAgYXNzZXJ0Lm9rKG1hdGNoWzFdLCBcIk1pc3NpbmcgdGVzdGNhc2UgYXR0cmlidXRlc1wiKTtcbiAgICAgIGNvbnN0IG5hbWUgPSAvXFxibmFtZT1cIihbXlwiXSspXCIvLmV4ZWMobWF0Y2hbMV0pPy5bMV07XG4gICAgICBjb25zdCBlbGFwc2VkID0gTnVtYmVyKC9cXGJ0aW1lPVwiKFteXCJdKylcIi8uZXhlYyhtYXRjaFsxXSk/LlsxXSk7XG4gICAgICBpZiAocm9sZSAhPT0gXCJjb3ZlcmFnZVwiICYmIGVsYXBzZWQgPiBwb2xpY3kuc2xvd190ZXN0X3NlY29uZHMpIHtcbiAgICAgICAgZW1pdENoZWNrRGV0YWlsKHtcbiAgICAgICAgICB2ZXJzaW9uOiAxLFxuICAgICAgICAgIGtpbmQ6IFwic2xvd1wiLFxuICAgICAgICAgIHNjb3BlOiBcInRlc3RcIixcbiAgICAgICAgICBuYW1lOiBTdHJpbmcobmFtZSksXG4gICAgICAgICAgZWxhcHNlZFNlY29uZHM6IGVsYXBzZWQsXG4gICAgICAgICAgdGhyZXNob2xkU2Vjb25kczogcG9saWN5LnNsb3dfdGVzdF9zZWNvbmRzLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICBgU0xPVyB0ZXN0ICR7U3RyaW5nKG5hbWUpfTogJHtTdHJpbmcoZWxhcHNlZCl9cyAoc29mdCBjYXAgJHtTdHJpbmcocG9saWN5LnNsb3dfdGVzdF9zZWNvbmRzKX1zOyBhZHZpc29yeSBvbmx5KWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gdmVyaWZ5UmVsZWFzZShkaXJlY3Rvcnk6IHN0cmluZykge1xuICAgIHRlc3QoZGlyZWN0b3J5KTtcbiAgICBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4ocm9vdCwgXCJzY3JpcHRzL3JlbGVhc2UtdmVyaWZ5Lm1qc1wiKSwgZGlyZWN0b3J5XSk7XG4gIH1cblxuICBmdW5jdGlvbiByZWplY3RMdG8obmFtZTogc3RyaW5nLCBvcHRpb25zOiBzdHJpbmdbXSwgZGlhZ25vc3RpYzogUmVnRXhwKSB7XG4gICAgLy8gUmV1c2UgdGhlIHZlcmlmaWVkIG9mZi1tb2RlIGRlcGVuZGVuY3kgaW5zdGFsbGF0aW9uLCB3aXRob3V0IHJlaW5zdGFsbGluZyBkZXBlbmRlbmNpZXMuXG4gICAgY29uc3QgcmVzdWx0OiBpbXBvcnQoXCJub2RlOmNoaWxkX3Byb2Nlc3NcIikuU3Bhd25TeW5jUmV0dXJuczxzdHJpbmcgfCBudWxsPiA9IHNwYXduU3luYyhcbiAgICAgIFwiY21ha2VcIixcbiAgICAgIFtcbiAgICAgICAgXCItU1wiLFxuICAgICAgICBcIi5cIixcbiAgICAgICAgXCItQlwiLFxuICAgICAgICBqb2luKGJ1aWxkcywgYGx0by1yZWplY3QtJHtuYW1lfWApLFxuICAgICAgICBcIi1HXCIsXG4gICAgICAgIFwiTmluamFcIixcbiAgICAgICAgLi4uKG1hbmFnZWRcbiAgICAgICAgICA/IGNvbXBpbGVyQXJndW1lbnRzKClcbiAgICAgICAgICA6IFtcbiAgICAgICAgICAgICAgYC1EQ01BS0VfVE9PTENIQUlOX0ZJTEU9JHtqb2luKGJ1aWxkcywgXCJsdG8tb2ZmXCIsIFwid29ya2JlbmNoLXZjcGtnLmNtYWtlXCIpfWAsXG4gICAgICAgICAgICAgIFwiLURWQ1BLR19NQU5JRkVTVF9JTlNUQUxMPU9GRlwiLFxuICAgICAgICAgICAgXSksXG4gICAgICAgIFwiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIixcbiAgICAgICAgXCItRFdPUktCRU5DSF9MVE89ZnVsbFwiLFxuICAgICAgICAuLi5vcHRpb25zLFxuICAgICAgXSxcbiAgICAgIHsgZW5jb2Rpbmc6IFwidXRmOFwiIH0sXG4gICAgKTtcbiAgICBjb25zdCBvdXRwdXQgPSBgJHtyZXN1bHQuc3Rkb3V0ID8/IFwiXCJ9JHtyZXN1bHQuc3RkZXJyID8/IFwiXCJ9YDtcbiAgICBpZiAocmVzdWx0LmVycm9yIHx8IHJlc3VsdC5zdGF0dXMgPT09IG51bGwgfHwgcmVzdWx0LnN0YXR1cyA9PT0gMCB8fCAhZGlhZ25vc3RpYy50ZXN0KG91dHB1dCkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEV4cGVjdGVkIExUTyByZWplY3Rpb24gZm9yICR7bmFtZX06ICR7cmVzdWx0LmVycm9yID8/IG91dHB1dH1gKTtcbiAgICBjb25zb2xlLmxvZyhgVmVyaWZpZWQgTFRPIHJlamVjdGlvbjogJHtuYW1lfWApO1xuICB9XG5cbiAgaWYgKHJvbGUgPT09IFwiZm9ybWF0XCIgfHwgcm9sZSA9PT0gXCJmb3JtYXQtd3JpdGVcIikge1xuICAgIHJ1bihcImNsYW5nLWZvcm1hdFwiLCBbLi4uKHJvbGUgPT09IFwiZm9ybWF0XCIgPyBbXCItLWRyeS1ydW5cIiwgXCItLVdlcnJvclwiXSA6IFtcIi1pXCJdKSwgLi4uc291cmNlc10pO1xuICB9IGVsc2UgaWYgKHJvbGUgPT09IFwibGludFwiKSB7XG4gICAgcnVuKFwiY2xhbmctdGlkeVwiLCBbXCItLXZlcmlmeS1jb25maWdcIl0pO1xuICAgIGNvbnN0IGFuYWx5c2lzID0gc2VsZWN0ZWRDb21waWxlciA9PT0gXCJjbGFuZ1wiID8gZGVidWcgOiBqb2luKGJ1aWxkcywgXCJhbmFseXNpcy1jbGFuZ1wiKTtcbiAgICBjb25maWd1cmUoYW5hbHlzaXMsIFtdLCBcImNsYW5nXCIpO1xuICAgIHJ1bihcImNtYWtlXCIsIFtcIi0tYnVpbGRcIiwgYW5hbHlzaXMsIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICAgIGZvciAoY29uc3Qgc291cmNlIG9mIHNvdXJjZXMuZmlsdGVyKChmaWxlKSA9PiAvXFwuKD86Y3xjcHApJC8udGVzdChmaWxlKSkpXG4gICAgICBydW4oXCJjbGFuZy10aWR5XCIsIFtcIi1wXCIsIGFuYWx5c2lzLCBzb3VyY2VdKTtcbiAgfSBlbHNlIGlmIChyb2xlID09PSBcImJ1aWxkXCIgfHwgcm9sZSA9PT0gXCJyZWxlYXNlXCIpIHtcbiAgICBjb25zdCBkaXJlY3RvcnkgPSByb2xlID09PSBcInJlbGVhc2VcIiA/IGpvaW4oYnVpbGRzLCBcInJlbGVhc2VcIikgOiBkZWJ1ZztcbiAgICBjb25maWd1cmUoXG4gICAgICBkaXJlY3RvcnksXG4gICAgICByb2xlID09PSBcInJlbGVhc2VcIiA/IFtcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxlYXNlXCIsIGAtRFdPUktCRU5DSF9MVE89JHtwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTFRPID8/IFwib2ZmXCJ9YF0gOiBbXSxcbiAgICApO1xuICAgIGlmIChyb2xlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgdmVyaWZ5UmVsZWFzZShkaXJlY3RvcnkpO1xuICAgICAgY29uc3Qgb3V0cHV0ID0gcmVzb2x2ZShwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUkVMRUFTRV9PVVRQVVQgPz8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0RJU1RfRElSID8/IFwiZGlzdFwiKTtcbiAgICAgIG1rZGlyU3luYyhvdXRwdXQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29weUZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBgY291bnQke3N1ZmZpeH1gKSwgam9pbihvdXRwdXQsIGBjb3VudCR7c3VmZml4fWApKTtcbiAgICAgIGNvcHlGaWxlU3luYyhcIkxJQ0VOU0VcIiwgam9pbihvdXRwdXQsIFwiTElDRU5TRVwiKSk7XG4gICAgfSBlbHNlIHJ1bihcImNtYWtlXCIsIFtcIi0tYnVpbGRcIiwgZGlyZWN0b3J5LCBcIi0tcGFyYWxsZWxcIiwgcGFyYWxsZWxpc21dKTtcbiAgfSBlbHNlIGlmIChyb2xlID09PSBcImx0b1wiKSB7XG4gICAgZm9yIChjb25zdCBtb2RlIG9mIHNlbGVjdGVkQ29tcGlsZXIgPT09IFwiY2xhbmdcIiA/IFtcIm9mZlwiLCBcInRoaW5cIiwgXCJmdWxsXCJdIDogW1wib2ZmXCIsIFwiZnVsbFwiXSkge1xuICAgICAgY29uc3QgZGlyZWN0b3J5ID0gam9pbihidWlsZHMsIGBsdG8tJHttb2RlfWApO1xuICAgICAgY29uZmlndXJlKGRpcmVjdG9yeSwgW1wiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIiwgYC1EV09SS0JFTkNIX0xUTz0ke21vZGV9YF0pO1xuICAgICAgdmVyaWZ5UmVsZWFzZShkaXJlY3RvcnkpO1xuICAgIH1cbiAgICByZWplY3RMdG8oXCJpbnZhbGlkXCIsIFtcIi1EV09SS0JFTkNIX0xUTz11bmtub3duXCJdLCAvbXVzdCBzZWxlY3Qgb2ZmLCB0aGluLCBvciBmdWxsLyk7XG4gICAgcmVqZWN0THRvKFwiZGVidWdcIiwgW1wiLURDTUFLRV9CVUlMRF9UWVBFPURlYnVnXCJdLCAvc2VwYXJhdGUgb3B0aW1pemVkIHNpbmdsZS1jb25maWd1cmF0aW9uIGJ1aWxkLyk7XG4gICAgcmVqZWN0THRvKFwiY292ZXJhZ2VcIiwgW1wiLURXT1JLQkVOQ0hfQ09WRVJBR0U9T05cIl0sIC9zZXBhcmF0ZSBMVE8gYnVpbGQgZnJvbSBjb3ZlcmFnZSBhbmQgc2FuaXRpemVycy8pO1xuICAgIHJlamVjdEx0byhcInNhbml0aXplcnNcIiwgW1wiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiXSwgL3NlcGFyYXRlIExUTyBidWlsZCBmcm9tIGNvdmVyYWdlIGFuZCBzYW5pdGl6ZXJzLyk7XG4gICAgaWYgKHNlbGVjdGVkQ29tcGlsZXIgIT09IFwiY2xhbmdcIilcbiAgICAgIHJlamVjdEx0byhcInRoaW5cIiwgW1wiLURXT1JLQkVOQ0hfTFRPPXRoaW5cIl0sIC9kb2VzIG5vdCBzdXBwb3J0IHRoZSByZXF1ZXN0ZWQgTFRPIG1vZGUvKTtcbiAgICBlbHNlIHJlamVjdEx0byhcInRvb2wtdmVyc2lvblwiLCBbYC1EbHRvX2xpbmtlcj0ke3Byb2Nlc3MuZXhlY1BhdGh9YF0sIC9tdXN0IG1hdGNoIENsYW5nLyk7XG4gIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJ0ZXN0XCIpIHtcbiAgICBjb25maWd1cmUoZGVidWcpO1xuICAgIHRlc3QoZGVidWcpO1xuICB9IGVsc2UgaWYgKHJvbGUgPT09IFwiY292ZXJhZ2VcIikge1xuICAgIGNvbnN0IHsgbmF0aXZlQ292ZXJhZ2VTb3VyY2VzLCBhc3NlcnROYXRpdmVDb3ZlcmFnZVNjb3BlIH0gPSBhd2FpdCBpbXBvcnQoXCIuL25hdGl2ZS1jb3ZlcmFnZS5tanNcIik7XG4gICAgaWYgKGV4aXN0c1N5bmMoXCJjb3ZlcmFnZVwiKSAmJiBsc3RhdFN5bmMoXCJjb3ZlcmFnZVwiKS5pc1N5bWJvbGljTGluaygpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiY292ZXJhZ2UgbXVzdCBiZSBhIHJlYWwgZGlyZWN0b3J5XCIpO1xuICAgIG1rZGlyU3luYyhcImNvdmVyYWdlXCIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyhcImNvdmVyYWdlXCIpKVxuICAgICAgaWYgKG5hbWUgIT09IFwiY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpIHJtU3luYyhqb2luKFwiY292ZXJhZ2VcIiwgbmFtZSksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBpZiAoc2VsZWN0ZWRDb21waWxlciAhPT0gXCJjbGFuZ1wiKSB7XG4gICAgICBjb25maWd1cmUoZGVidWcpO1xuICAgICAgdGVzdChkZWJ1Zyk7XG4gICAgfVxuICAgIGNvbnN0IGluc3RydW1lbnRlZCA9IGpvaW4oYnVpbGRzLCBcImNvdmVyYWdlXCIpO1xuICAgIGNvbmZpZ3VyZShpbnN0cnVtZW50ZWQsIFtcIi1EV09SS0JFTkNIX0NPVkVSQUdFPU9OXCJdLCBcImNsYW5nXCIpO1xuICAgIGNvbnN0IHRlbXBvcmFyeSA9IG1rZHRlbXBTeW5jKGpvaW4oaW5zdHJ1bWVudGVkLCBcInByb2ZpbGVzLVwiKSk7XG4gICAgdHJ5IHtcbiAgICAgIHRlc3QoaW5zdHJ1bWVudGVkLCB0ZW1wb3JhcnkpO1xuICAgICAgY29uc3QgcHJvZmlsZXMgPSBmaWxlcyh0ZW1wb3JhcnkpLmZpbHRlcigoZmlsZTogc3RyaW5nKSA9PiBmaWxlLmVuZHNXaXRoKFwiLnByb2ZyYXdcIikpO1xuICAgICAgaWYgKCFwcm9maWxlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIHByb2R1Y2VkIG5vIGV4ZWN1dGlvbiBwcm9maWxlc1wiKTtcbiAgICAgIGNvbnN0IG1lcmdlZCA9IGpvaW4odGVtcG9yYXJ5LCBcIm1lcmdlZC5wcm9mZGF0YVwiKTtcbiAgICAgIHJ1bihcImxsdm0tcHJvZmRhdGFcIiwgW1wibWVyZ2VcIiwgXCItc3BhcnNlXCIsIC4uLnByb2ZpbGVzLCBcIi1vXCIsIG1lcmdlZF0pO1xuICAgICAgY29uc3Qgc291cmNlRmlsZXMgPSBuYXRpdmVDb3ZlcmFnZVNvdXJjZXMoc291cmNlcy5maWx0ZXIoKGZpbGUpID0+ICFmaWxlLnN0YXJ0c1dpdGgoYHRlc3RzJHtzZXB9YCkpKTtcbiAgICAgIGNvbnN0IGNvdmVyYWdlQXJncyA9IFtcbiAgICAgICAgam9pbihpbnN0cnVtZW50ZWQsIGBjb3VudF90ZXN0JHtzdWZmaXh9YCksXG4gICAgICAgIFwiLW9iamVjdFwiLFxuICAgICAgICBqb2luKGluc3RydW1lbnRlZCwgYGNvdW50JHtzdWZmaXh9YCksXG4gICAgICAgIFwiLW9iamVjdFwiLFxuICAgICAgICBqb2luKGluc3RydW1lbnRlZCwgYGNwdV90ZXN0JHtzdWZmaXh9YCksXG4gICAgICAgIGAtaW5zdHItcHJvZmlsZT0ke21lcmdlZH1gLFxuICAgICAgICAuLi5zb3VyY2VGaWxlcyxcbiAgICAgIF07XG4gICAgICBydW4oXCJsbHZtLWNvdlwiLCBbXCJyZXBvcnRcIiwgLi4uY292ZXJhZ2VBcmdzXSk7XG4gICAgICBjb25zdCByZXBvcnQgPSBKU09OLnBhcnNlKHJ1bihcImxsdm0tY292XCIsIFtcImV4cG9ydFwiLCAuLi5jb3ZlcmFnZUFyZ3NdLCB7IHN0ZGlvOiBcInBpcGVcIiB9KSkgYXMge1xuICAgICAgICBkYXRhOiB7IGZpbGVzOiB7IGZpbGVuYW1lOiBzdHJpbmcgfVtdOyB0b3RhbHM6IFJlY29yZDxzdHJpbmcsIHsgY291bnQ6IG51bWJlcjsgcGVyY2VudDogbnVtYmVyIH0+IH1bXTtcbiAgICAgIH07XG4gICAgICB3cml0ZUZpbGVTeW5jKFwiY292ZXJhZ2UvcmVwb3J0Lmpzb25cIiwgSlNPTi5zdHJpbmdpZnkocmVwb3J0KSk7XG4gICAgICBhc3NlcnQub2socmVwb3J0LmRhdGFbMF0sIFwiTExWTSBjb3ZlcmFnZSBkaWQgbm90IHJlcG9ydCB0b3RhbHNcIik7XG4gICAgICBhc3NlcnROYXRpdmVDb3ZlcmFnZVNjb3BlKFxuICAgICAgICByZXBvcnQuZGF0YVswXS5maWxlcy5tYXAoKGZpbGUpID0+IGZpbGUuZmlsZW5hbWUpLFxuICAgICAgICBzb3VyY2VGaWxlcyxcbiAgICAgICk7XG4gICAgICBjb25zdCB0b3RhbCA9IHJlcG9ydC5kYXRhWzBdLnRvdGFscztcbiAgICAgIGZvciAoY29uc3QgW21ldHJpYywgbWluaW11bV0gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5LmNvdmVyYWdlKSkge1xuICAgICAgICBpZiAoIXRvdGFsW21ldHJpY10gfHwgdG90YWxbbWV0cmljXS5jb3VudCA9PT0gMCB8fCB0b3RhbFttZXRyaWNdLnBlcmNlbnQgPCBtaW5pbXVtKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGAke21ldHJpY30gY292ZXJhZ2UgJHtTdHJpbmcodG90YWxbbWV0cmljXT8ucGVyY2VudCA/PyBcIm1pc3NpbmdcIil9JSBpcyBiZWxvdyAke1N0cmluZyhtaW5pbXVtKX0lYCxcbiAgICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcG9yYXJ5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9IGVsc2UgaWYgKHJvbGUgPT09IFwic2FuaXRpemVyc1wiKSB7XG4gICAgY29uZmlndXJlKGpvaW4oYnVpbGRzLCBcImFcIiksIFtcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIl0pO1xuICAgIHRlc3Qoam9pbihidWlsZHMsIFwiYVwiKSk7XG4gICAgY29uZmlndXJlKGpvaW4oYnVpbGRzLCBcInBcIiksIFtcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIiwgXCItRFdPUktCRU5DSF9QT1JUQUJMRV9PTkxZPU9OXCJdKTtcbiAgICB0ZXN0KGpvaW4oYnVpbGRzLCBcInBcIikpO1xuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBFcnJvcihcImV4cGVjdGVkIGJ1aWxkLCByZWxlYXNlLCBmb3JtYXQsIGZvcm1hdC13cml0ZSwgbGludCwgdGVzdCwgY292ZXJhZ2UsIHNhbml0aXplcnMsIG9yIGx0b1wiKTtcbiAgfVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxZQUFZO0FBQ25CLFNBQWdDLGlCQUFpQjtBQUVqRDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxNQUFNLFVBQVUsU0FBUyxXQUFXO0FBQzdDLFNBQVMscUJBQXFCO0FBRTlCLFNBQVMsaUJBQWlCLHdCQUE2QztBQUV2RSxlQUFzQixnQkFBZ0IsVUFBdUIsY0FBc0IsTUFBNkI7QUFDOUcsUUFBTSxPQUFPLGFBQWEsT0FBTyxRQUFRLElBQUksQ0FBQztBQUM5QyxRQUFNLEVBQUUsVUFBVSxJQUFLLE1BQU0sT0FDM0IsY0FBYyxLQUFLLGNBQWMsd0JBQXdCLENBQUMsRUFBRTtBQUc5RCxRQUFNLEVBQUUsZ0JBQWdCLElBQUssTUFBTSxPQUNqQyxjQUFjLEtBQUssY0FBYywrQkFBK0IsQ0FBQyxFQUFFO0FBRXJFLFFBQU0sbUJBQW1CLFFBQVEsSUFBSTtBQUNyQyxNQUFJLENBQUMsaUJBQWtCLE9BQU0sSUFBSSxNQUFNLHdFQUF3RTtBQUMvRyxRQUFNLFNBQVM7QUFDZixRQUFNLFFBQVEsS0FBSyxRQUFRLE9BQU87QUFDbEMsUUFBTSxTQUFTLEtBQUssTUFBTSxhQUFhLDBCQUEwQixNQUFNLENBQUM7QUFJeEUsUUFBTSxTQUFTLFFBQVEsYUFBYSxVQUFVLFNBQVM7QUFDdkQsUUFBTSxvQkFBb0IsUUFBUSxJQUFJLHNCQUFzQjtBQUM1RCxNQUFJLENBQUMsaUJBQWlCLGlCQUFpQixFQUFHLE9BQU0sSUFBSSxNQUFNLG1DQUFtQztBQUM3RixRQUFNLG1CQUFtQztBQUN6QyxNQUNFLFFBQVEsYUFBYSxXQUNyQixxQkFBcUIsVUFDckIsU0FBUyxZQUNULFNBQVMsa0JBQ1QsUUFBUSxJQUFJLGtDQUFrQyxLQUM5QztBQUNBLFVBQU0sRUFBRSxzQkFBc0IsSUFBSSxNQUFNLE9BQU8sNEJBQTRCO0FBQzNFLFVBQU0sc0JBQXNCLFFBQVEsS0FBSyxNQUFNLENBQUMsR0FBRyxNQUFNO0FBQ3pEO0FBQUEsRUFDRjtBQUNBLFFBQU0sVUFBVSxRQUFRLElBQUksK0JBQStCO0FBQzNELFFBQU0sY0FBYyxPQUFPLFVBQVUsQ0FBQztBQUN0QyxVQUFRLElBQUksdUJBQXVCO0FBQ25DLFdBQVMsSUFBSSxTQUFpQixPQUFpQixDQUFDLEdBQUcsVUFBOEMsQ0FBQyxHQUFHO0FBQ25HLFVBQU0sU0FBdUUsVUFBVSxTQUFTLE1BQU07QUFBQSxNQUNwRyxVQUFVO0FBQUEsTUFDVixPQUFPO0FBQUEsTUFDUCxLQUFLO0FBQUEsTUFDTCxHQUFHO0FBQUEsSUFDTCxDQUFDO0FBQ0QsUUFBSSxPQUFPLFNBQVMsT0FBTyxXQUFXO0FBQ3BDLFlBQU0sSUFBSSxNQUFNLEdBQUcsT0FBTyxZQUFZLE9BQU8sT0FBTyxTQUFTLE9BQU8sTUFBTSxDQUFDLEVBQUU7QUFDL0UsV0FBTyxPQUFPLFVBQVU7QUFBQSxFQUMxQjtBQUNBLFdBQVMsd0JBQXdCLFdBQW1CO0FBQ2xELFVBQU0sYUFBYSxLQUFLLFdBQVcsSUFBSTtBQUN2QyxRQUFJO0FBQ0YsWUFBTSxTQUFTLEtBQUssTUFBTSxZQUFZLFNBQVMsU0FBUyxRQUFRLFNBQVMsRUFBRSxXQUFXLEtBQUssR0FBRyxDQUFDO0FBQy9GLFlBQU0sV0FBVyxXQUFXLFVBQVUsSUFDbEMsTUFBTSxVQUFVLEVBQUUsT0FBTyxDQUFDLFNBQVMsS0FBSyxTQUFTLE1BQU0sS0FBSyxVQUFVLElBQUksRUFBRSxPQUFPLENBQUMsSUFDcEYsQ0FBQztBQUNMLGlCQUFXLFFBQVEsVUFBVTtBQUMzQixjQUFNLGNBQWMsS0FBSyxRQUFRLG9CQUFvQixTQUFTLFlBQVksSUFBSSxDQUFDO0FBQy9FLGtCQUFVLEtBQUssYUFBYSxJQUFJLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN0RCxxQkFBYSxNQUFNLFdBQVc7QUFDOUIsWUFBSSxtQkFBbUIsS0FBSyxJQUFJO0FBQzlCLGtCQUFRLE1BQU0sR0FBRyxJQUFJO0FBQUEsRUFBSyxhQUFhLE1BQU0sTUFBTSxFQUFFLE1BQU0sS0FBSyxFQUFFLE1BQU0sT0FBTyxFQUFFLE1BQU0sR0FBRyxFQUFFLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFBQSxNQUM1RztBQUdBLFlBQU0sV0FBVyxLQUFLLFdBQVcsNEJBQTRCO0FBQzdELFVBQUksV0FBVyxRQUFRLEtBQUssVUFBVSxRQUFRLEVBQUUsT0FBTyxHQUFHO0FBQ3hELGtCQUFVLFFBQVEsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNyQyxxQkFBYSxVQUFVLEtBQUssUUFBUSw0QkFBNEIsQ0FBQztBQUNqRSxnQkFBUTtBQUFBLFVBQ04sR0FBRyxRQUFRO0FBQUEsRUFBSyxhQUFhLFVBQVUsTUFBTSxFQUFFLE1BQU0sS0FBSyxFQUFFLE1BQU0sT0FBTyxFQUFFLE1BQU0sR0FBRyxFQUFFLEtBQUssSUFBSSxDQUFDO0FBQUEsUUFDbEc7QUFBQSxNQUNGO0FBQ0EsVUFBSSxTQUFTLFVBQVUsV0FBVyxRQUFRLEVBQUcsU0FBUSxNQUFNLHVCQUF1QixNQUFNLEVBQUU7QUFBQSxJQUM1RixTQUFTLE9BQU87QUFDZCxjQUFRLE1BQU0sd0NBQXdDLE9BQU8sS0FBSyxDQUFDLEVBQUU7QUFBQSxJQUN2RTtBQUFBLEVBQ0Y7QUFDQSxXQUFTLE1BQU0sV0FBNkI7QUFDMUMsV0FBTyxZQUFZLFdBQVcsRUFBRSxlQUFlLEtBQUssQ0FBQyxFQUFFO0FBQUEsTUFBUSxDQUFDLFVBQzlELE1BQU0sWUFBWSxJQUFJLE1BQU0sS0FBSyxXQUFXLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLFdBQVcsTUFBTSxJQUFJLENBQUM7QUFBQSxJQUN6RjtBQUFBLEVBQ0Y7QUFDQSxRQUFNLFVBQVUsQ0FBQyxPQUFPLFdBQVcsT0FBTyxFQUFFLFFBQVEsS0FBSyxFQUFFLE9BQU8sQ0FBQyxTQUFTLHFCQUFxQixLQUFLLElBQUksQ0FBQztBQUMzRyxXQUFTLGtCQUFrQixXQUEyQixrQkFBa0I7QUFDdEUsVUFBTSxhQUNKLGFBQWEsbUJBQW1CLFFBQVEsSUFBSSxhQUFhLE1BQU0saUJBQWlCLGVBQWUsSUFBSTtBQUNyRyxXQUFPO0FBQUEsTUFDTCxXQUFXLGFBQWEsTUFBTSxNQUFNLEtBQUssYUFBYSxjQUFjLGdCQUFnQixRQUFRLEVBQUUsWUFBWSxRQUFRLENBQUM7QUFBQSxJQUNySDtBQUFBLEVBQ0Y7QUFDQSxXQUFTLFVBQVUsV0FBbUIsVUFBb0IsQ0FBQyxHQUFHLFdBQTJCLGtCQUFrQjtBQUN6RyxRQUFJLENBQUMsU0FBUztBQUNaLFVBQUksUUFBUSxVQUFVO0FBQUEsUUFDcEIsS0FBSyxjQUFjLG1CQUFtQjtBQUFBLFFBQ3RDO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0EsR0FBSSxRQUFRLFNBQVMsMkJBQTJCLElBQUksQ0FBQyxjQUFjLElBQUksQ0FBQztBQUFBLE1BQzFFLENBQUM7QUFDRCxjQUFRLElBQUksd0JBQXdCO0FBQ3BDLGNBQVEsSUFBSSw4QkFBOEI7QUFDMUMsYUFBTyxRQUFRLElBQUk7QUFDbkIsY0FBUSxJQUFJLHdCQUF3QjtBQUFBLElBQ3RDO0FBQ0EsUUFBSTtBQUNGLFVBQUksU0FBUztBQUFBLFFBQ1g7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQSxHQUFJLFVBQ0Esa0JBQWtCLFFBQVEsSUFDMUIsQ0FBQywwQkFBMEIsS0FBSyxXQUFXLHVCQUF1QixDQUFDLEVBQUU7QUFBQSxRQUN6RSxHQUFLLFFBQVEsSUFBSSxhQUFhLE1BQU0seUJBQXlCLHdCQUF3QixLQUNyRixRQUFRLElBQUksOEJBQ1I7QUFBQSxVQUNFLGlDQUFpQyxRQUFRLElBQUksYUFBYSxNQUFNLHlCQUF5Qix3QkFBd0IsS0FBSyxRQUFRLElBQUksK0JBQStCLEVBQUU7QUFBQSxRQUNySyxJQUNBLENBQUM7QUFBQSxRQUNMLCtCQUErQixRQUFRO0FBQUEsUUFDdkMsZ0NBQWdDLGFBQWEsbUJBQW9CLFFBQVEsSUFBSSw4QkFBOEIsS0FBTSxFQUFFO0FBQUEsUUFDbkgsR0FBSSxRQUFRLGFBQWEsV0FBVyxRQUFRLFNBQVMsMkJBQTJCLElBQzVFLENBQUMsbUNBQW1DLElBQ3BDLENBQUM7QUFBQSxRQUNMLEdBQUc7QUFBQSxNQUNMLENBQUM7QUFBQSxJQUNILFNBQVMsT0FBTztBQUNkLDhCQUF3QixTQUFTO0FBQ2pDLFlBQU07QUFBQSxJQUNSO0FBQUEsRUFDRjtBQUNBLFdBQVMsS0FBSyxXQUFtQixVQUFtQjtBQUNsRCxjQUFVLFlBQVksRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN6QyxVQUFNLFVBQVUsS0FBSyxNQUFNLFlBQVksU0FBUyxVQUFVLE1BQU0sT0FBTyxTQUFTLENBQUMsRUFBRSxXQUFXLEtBQUssR0FBRyxDQUFDLE1BQU07QUFDN0csUUFBSSxTQUFTLENBQUMsV0FBVyxXQUFXLGNBQWMsV0FBVyxDQUFDO0FBQzlELFFBQUksU0FBUyxDQUFDLGNBQWMsV0FBVyx1QkFBdUIsb0JBQW9CLGtCQUFrQixPQUFPLEdBQUc7QUFBQSxNQUM1RyxLQUFLLEVBQUUsR0FBRyxRQUFRLEtBQUssR0FBSSxXQUFXLEVBQUUsbUJBQW1CLEtBQUssVUFBVSxlQUFlLEVBQUUsSUFBSSxDQUFDLEVBQUc7QUFBQSxJQUNyRyxDQUFDO0FBQ0QsVUFBTSxTQUFTLGFBQWEsU0FBUyxNQUFNO0FBQzNDLGVBQVcsU0FBUyxPQUFPLFNBQVMsc0JBQXNCLEdBQUc7QUFDM0QsYUFBTyxHQUFHLE1BQU0sQ0FBQyxHQUFHLDZCQUE2QjtBQUNqRCxZQUFNLE9BQU8sbUJBQW1CLEtBQUssTUFBTSxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ2xELFlBQU0sVUFBVSxPQUFPLG1CQUFtQixLQUFLLE1BQU0sQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQzdELFVBQUksU0FBUyxjQUFjLFVBQVUsT0FBTyxtQkFBbUI7QUFDN0Qsd0JBQWdCO0FBQUEsVUFDZCxTQUFTO0FBQUEsVUFDVCxNQUFNO0FBQUEsVUFDTixPQUFPO0FBQUEsVUFDUCxNQUFNLE9BQU8sSUFBSTtBQUFBLFVBQ2pCLGdCQUFnQjtBQUFBLFVBQ2hCLGtCQUFrQixPQUFPO0FBQUEsUUFDM0IsQ0FBQztBQUNELGdCQUFRO0FBQUEsVUFDTixhQUFhLE9BQU8sSUFBSSxDQUFDLEtBQUssT0FBTyxPQUFPLENBQUMsZUFBZSxPQUFPLE9BQU8saUJBQWlCLENBQUM7QUFBQSxRQUM5RjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFdBQVMsY0FBYyxXQUFtQjtBQUN4QyxTQUFLLFNBQVM7QUFDZCxRQUFJLFFBQVEsVUFBVSxDQUFDLEtBQUssTUFBTSw0QkFBNEIsR0FBRyxTQUFTLENBQUM7QUFBQSxFQUM3RTtBQUVBLFdBQVMsVUFBVSxNQUFjLFNBQW1CLFlBQW9CO0FBRXRFLFVBQU0sU0FBdUU7QUFBQSxNQUMzRTtBQUFBLE1BQ0E7QUFBQSxRQUNFO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBLEtBQUssUUFBUSxjQUFjLElBQUksRUFBRTtBQUFBLFFBQ2pDO0FBQUEsUUFDQTtBQUFBLFFBQ0EsR0FBSSxVQUNBLGtCQUFrQixJQUNsQjtBQUFBLFVBQ0UsMEJBQTBCLEtBQUssUUFBUSxXQUFXLHVCQUF1QixDQUFDO0FBQUEsVUFDMUU7QUFBQSxRQUNGO0FBQUEsUUFDSjtBQUFBLFFBQ0E7QUFBQSxRQUNBLEdBQUc7QUFBQSxNQUNMO0FBQUEsTUFDQSxFQUFFLFVBQVUsT0FBTztBQUFBLElBQ3JCO0FBQ0EsVUFBTSxTQUFTLEdBQUcsT0FBTyxVQUFVLEVBQUUsR0FBRyxPQUFPLFVBQVUsRUFBRTtBQUMzRCxRQUFJLE9BQU8sU0FBUyxPQUFPLFdBQVcsUUFBUSxPQUFPLFdBQVcsS0FBSyxDQUFDLFdBQVcsS0FBSyxNQUFNO0FBQzFGLFlBQU0sSUFBSSxNQUFNLDhCQUE4QixJQUFJLEtBQUssT0FBTyxTQUFTLE1BQU0sRUFBRTtBQUNqRixZQUFRLElBQUksMkJBQTJCLElBQUksRUFBRTtBQUFBLEVBQy9DO0FBRUEsTUFBSSxTQUFTLFlBQVksU0FBUyxnQkFBZ0I7QUFDaEQsUUFBSSxnQkFBZ0IsQ0FBQyxHQUFJLFNBQVMsV0FBVyxDQUFDLGFBQWEsVUFBVSxJQUFJLENBQUMsSUFBSSxHQUFJLEdBQUcsT0FBTyxDQUFDO0FBQUEsRUFDL0YsV0FBVyxTQUFTLFFBQVE7QUFDMUIsUUFBSSxjQUFjLENBQUMsaUJBQWlCLENBQUM7QUFDckMsVUFBTSxXQUFXLHFCQUFxQixVQUFVLFFBQVEsS0FBSyxRQUFRLGdCQUFnQjtBQUNyRixjQUFVLFVBQVUsQ0FBQyxHQUFHLE9BQU87QUFDL0IsUUFBSSxTQUFTLENBQUMsV0FBVyxVQUFVLGNBQWMsV0FBVyxDQUFDO0FBQzdELGVBQVcsVUFBVSxRQUFRLE9BQU8sQ0FBQyxTQUFTLGVBQWUsS0FBSyxJQUFJLENBQUM7QUFDckUsVUFBSSxjQUFjLENBQUMsTUFBTSxVQUFVLE1BQU0sQ0FBQztBQUFBLEVBQzlDLFdBQVcsU0FBUyxXQUFXLFNBQVMsV0FBVztBQUNqRCxVQUFNLFlBQVksU0FBUyxZQUFZLEtBQUssUUFBUSxTQUFTLElBQUk7QUFDakU7QUFBQSxNQUNFO0FBQUEsTUFDQSxTQUFTLFlBQVksQ0FBQyw4QkFBOEIsbUJBQW1CLFFBQVEsSUFBSSxpQkFBaUIsS0FBSyxFQUFFLElBQUksQ0FBQztBQUFBLElBQ2xIO0FBQ0EsUUFBSSxTQUFTLFdBQVc7QUFDdEIsb0JBQWMsU0FBUztBQUN2QixZQUFNLFNBQVMsUUFBUSxRQUFRLElBQUksNEJBQTRCLFFBQVEsSUFBSSxzQkFBc0IsTUFBTTtBQUN2RyxnQkFBVSxRQUFRLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckMsbUJBQWEsS0FBSyxXQUFXLFFBQVEsTUFBTSxFQUFFLEdBQUcsS0FBSyxRQUFRLFFBQVEsTUFBTSxFQUFFLENBQUM7QUFDOUUsbUJBQWEsV0FBVyxLQUFLLFFBQVEsU0FBUyxDQUFDO0FBQUEsSUFDakQsTUFBTyxLQUFJLFNBQVMsQ0FBQyxXQUFXLFdBQVcsY0FBYyxXQUFXLENBQUM7QUFBQSxFQUN2RSxXQUFXLFNBQVMsT0FBTztBQUN6QixlQUFXLFFBQVEscUJBQXFCLFVBQVUsQ0FBQyxPQUFPLFFBQVEsTUFBTSxJQUFJLENBQUMsT0FBTyxNQUFNLEdBQUc7QUFDM0YsWUFBTSxZQUFZLEtBQUssUUFBUSxPQUFPLElBQUksRUFBRTtBQUM1QyxnQkFBVSxXQUFXLENBQUMsOEJBQThCLG1CQUFtQixJQUFJLEVBQUUsQ0FBQztBQUM5RSxvQkFBYyxTQUFTO0FBQUEsSUFDekI7QUFDQSxjQUFVLFdBQVcsQ0FBQyx5QkFBeUIsR0FBRyxnQ0FBZ0M7QUFDbEYsY0FBVSxTQUFTLENBQUMsMEJBQTBCLEdBQUcsK0NBQStDO0FBQ2hHLGNBQVUsWUFBWSxDQUFDLHlCQUF5QixHQUFHLGlEQUFpRDtBQUNwRyxjQUFVLGNBQWMsQ0FBQywyQkFBMkIsR0FBRyxpREFBaUQ7QUFDeEcsUUFBSSxxQkFBcUI7QUFDdkIsZ0JBQVUsUUFBUSxDQUFDLHNCQUFzQixHQUFHLHlDQUF5QztBQUFBLFFBQ2xGLFdBQVUsZ0JBQWdCLENBQUMsZ0JBQWdCLFFBQVEsUUFBUSxFQUFFLEdBQUcsa0JBQWtCO0FBQUEsRUFDekYsV0FBVyxTQUFTLFFBQVE7QUFDMUIsY0FBVSxLQUFLO0FBQ2YsU0FBSyxLQUFLO0FBQUEsRUFDWixXQUFXLFNBQVMsWUFBWTtBQUM5QixVQUFNLEVBQUUsdUJBQXVCLDBCQUEwQixJQUFJLE1BQU0sT0FBTyx1QkFBdUI7QUFDakcsUUFBSSxXQUFXLFVBQVUsS0FBSyxVQUFVLFVBQVUsRUFBRSxlQUFlO0FBQ2pFLFlBQU0sSUFBSSxNQUFNLG1DQUFtQztBQUNyRCxjQUFVLFlBQVksRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN6QyxlQUFXLFFBQVEsWUFBWSxVQUFVO0FBQ3ZDLFVBQUksU0FBUyx3QkFBeUIsUUFBTyxLQUFLLFlBQVksSUFBSSxHQUFHLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQ3ZHLFFBQUkscUJBQXFCLFNBQVM7QUFDaEMsZ0JBQVUsS0FBSztBQUNmLFdBQUssS0FBSztBQUFBLElBQ1o7QUFDQSxVQUFNLGVBQWUsS0FBSyxRQUFRLFVBQVU7QUFDNUMsY0FBVSxjQUFjLENBQUMseUJBQXlCLEdBQUcsT0FBTztBQUM1RCxVQUFNLFlBQVksWUFBWSxLQUFLLGNBQWMsV0FBVyxDQUFDO0FBQzdELFFBQUk7QUFDRixXQUFLLGNBQWMsU0FBUztBQUM1QixZQUFNLFdBQVcsTUFBTSxTQUFTLEVBQUUsT0FBTyxDQUFDLFNBQWlCLEtBQUssU0FBUyxVQUFVLENBQUM7QUFDcEYsVUFBSSxDQUFDLFNBQVMsT0FBUSxPQUFNLElBQUksTUFBTSx5Q0FBeUM7QUFDL0UsWUFBTSxTQUFTLEtBQUssV0FBVyxpQkFBaUI7QUFDaEQsVUFBSSxpQkFBaUIsQ0FBQyxTQUFTLFdBQVcsR0FBRyxVQUFVLE1BQU0sTUFBTSxDQUFDO0FBQ3BFLFlBQU0sY0FBYyxzQkFBc0IsUUFBUSxPQUFPLENBQUMsU0FBUyxDQUFDLEtBQUssV0FBVyxRQUFRLEdBQUcsRUFBRSxDQUFDLENBQUM7QUFDbkcsWUFBTSxlQUFlO0FBQUEsUUFDbkIsS0FBSyxjQUFjLGFBQWEsTUFBTSxFQUFFO0FBQUEsUUFDeEM7QUFBQSxRQUNBLEtBQUssY0FBYyxRQUFRLE1BQU0sRUFBRTtBQUFBLFFBQ25DO0FBQUEsUUFDQSxLQUFLLGNBQWMsV0FBVyxNQUFNLEVBQUU7QUFBQSxRQUN0QyxrQkFBa0IsTUFBTTtBQUFBLFFBQ3hCLEdBQUc7QUFBQSxNQUNMO0FBQ0EsVUFBSSxZQUFZLENBQUMsVUFBVSxHQUFHLFlBQVksQ0FBQztBQUMzQyxZQUFNLFNBQVMsS0FBSyxNQUFNLElBQUksWUFBWSxDQUFDLFVBQVUsR0FBRyxZQUFZLEdBQUcsRUFBRSxPQUFPLE9BQU8sQ0FBQyxDQUFDO0FBR3pGLG9CQUFjLHdCQUF3QixLQUFLLFVBQVUsTUFBTSxDQUFDO0FBQzVELGFBQU8sR0FBRyxPQUFPLEtBQUssQ0FBQyxHQUFHLHFDQUFxQztBQUMvRDtBQUFBLFFBQ0UsT0FBTyxLQUFLLENBQUMsRUFBRSxNQUFNLElBQUksQ0FBQyxTQUFTLEtBQUssUUFBUTtBQUFBLFFBQ2hEO0FBQUEsTUFDRjtBQUNBLFlBQU0sUUFBUSxPQUFPLEtBQUssQ0FBQyxFQUFFO0FBQzdCLGlCQUFXLENBQUMsUUFBUSxPQUFPLEtBQUssT0FBTyxRQUFRLE9BQU8sUUFBUSxHQUFHO0FBQy9ELFlBQUksQ0FBQyxNQUFNLE1BQU0sS0FBSyxNQUFNLE1BQU0sRUFBRSxVQUFVLEtBQUssTUFBTSxNQUFNLEVBQUUsVUFBVTtBQUN6RSxnQkFBTSxJQUFJO0FBQUEsWUFDUixHQUFHLE1BQU0sYUFBYSxPQUFPLE1BQU0sTUFBTSxHQUFHLFdBQVcsU0FBUyxDQUFDLGNBQWMsT0FBTyxPQUFPLENBQUM7QUFBQSxVQUNoRztBQUFBLE1BQ0o7QUFBQSxJQUNGLFVBQUU7QUFDQSxhQUFPLFdBQVcsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNwRDtBQUFBLEVBQ0YsV0FBVyxTQUFTLGNBQWM7QUFDaEMsY0FBVSxLQUFLLFFBQVEsR0FBRyxHQUFHLENBQUMsMkJBQTJCLENBQUM7QUFDMUQsU0FBSyxLQUFLLFFBQVEsR0FBRyxDQUFDO0FBQ3RCLGNBQVUsS0FBSyxRQUFRLEdBQUcsR0FBRyxDQUFDLDZCQUE2Qiw4QkFBOEIsQ0FBQztBQUMxRixTQUFLLEtBQUssUUFBUSxHQUFHLENBQUM7QUFBQSxFQUN4QixPQUFPO0FBQ0wsVUFBTSxJQUFJLE1BQU0seUZBQXlGO0FBQUEsRUFDM0c7QUFDRjsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL25hdGl2ZS1jLWNoZWNrcy5tanMifQ==
