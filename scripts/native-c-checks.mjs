// Generated from native-c-checks.mts; edit the TypeScript source.
import assert from "node:assert/strict";
import { withEngineeringRun } from "./engineering-run.mjs";
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
  await withEngineeringRun(builds, "native-check", async (job) => {
    const managed = process.env.WORKBENCH_MANAGED_COMPILER === "1";
    const parallelism = String(cpuBudget());
    process.env.CTEST_PARALLEL_LEVEL = parallelism;
    const run = (command, args = [], options = {}) => job.run(command, args, { cwd: root, ...options, capture: options.stdio === "pipe" });
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
            // codeql[js/file-system-race] This is a read-only diagnostic from the owned build directory; the check grants no permission to modify it.
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
    async function configure(directory, options = [], compiler = selectedCompiler) {
      if (!managed) {
        await run(process.execPath, [
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
        await run("cmake", [
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
          "-DWORKBENCH_PGO=off",
          "-DWORKBENCH_STATIC_ANALYSIS=OFF",
          "-DWORKBENCH_HARDENING=OFF",
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
    async function test(directory, profiles) {
      mkdirSync("coverage", { recursive: true });
      const results = join(root, "coverage", `tests-${directory.slice(builds.length + 1).replaceAll(sep, "-")}.xml`);
      await run("cmake", ["--build", directory, "--parallel", parallelism]);
      await run(
        "ctest",
        ["--test-dir", directory, "--output-on-failure", "--no-tests=error", "--output-junit", results],
        {
          env: { ...process.env, ...profiles ? { LLVM_PROFILE_FILE: join(profiles, "%p-%m.profraw") } : {} }
        }
      );
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
    async function verifyRelease(directory) {
      await test(directory);
      await run(process.execPath, [join(root, "scripts/release-verify.mjs"), directory]);
    }
    async function rejectLto(name, options, diagnostic) {
      const result = await job.command(
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
        { capture: true, cwd: root }
      );
      const output = `${result.stdout}${result.stderr}`;
      if (result.error || result.status === null || result.status === 0 || !diagnostic.test(output))
        throw new Error(`Expected LTO rejection for ${name}: ${result.error ?? output}`);
      console.log(`Verified LTO rejection: ${name}`);
    }
    if (role === "format" || role === "format-write") {
      await run("clang-format", [...role === "format" ? ["--dry-run", "--Werror"] : ["-i"], ...sources]);
    } else if (role === "lint") {
      await run("clang-tidy", ["--verify-config"]);
      const analysis = selectedCompiler === "clang" ? debug : join(builds, "analysis-clang");
      await configure(analysis, [], "clang");
      await run("cmake", ["--build", analysis, "--parallel", parallelism]);
      for (const source of sources.filter((file) => /\.(?:c|cpp)$/.test(file)))
        await run("clang-tidy", ["-p", analysis, source]);
      if (selectedCompiler === "gcc" && language === "c" || selectedCompiler === "mvsc") {
        const additional = join(builds, `analysis-${selectedCompiler}`);
        await configure(additional, ["-DWORKBENCH_STATIC_ANALYSIS=ON"]);
        await run("cmake", ["--build", additional, "--parallel", parallelism]);
      }
    } else if (role === "pgo") {
      const rejection = join(job.directory, "optimization-contract");
      mkdirSync(rejection);
      try {
        copyFileSync(join(root, "cmake/WorkbenchOptimization.cmake"), join(rejection, "optimization.cmake"));
        const cmakeLanguage = language === "c" ? "C" : "CXX";
        writeFileSync(
          join(rejection, "CMakeLists.txt"),
          `cmake_minimum_required(VERSION 3.25)
project(Optimization LANGUAGES ${cmakeLanguage})
include(optimization.cmake)
workbench_optimization(${cmakeLanguage})
`
        );
        const cases = [
          ["invalid-mode", ["-DWORKBENCH_PGO=invalid"], /must select off, generate, or use/],
          ["missing-profile", ["-DWORKBENCH_PGO=use"], /PGO profiles? (?:is|are) missing/],
          ["mixed-coverage", ["-DWORKBENCH_PGO=generate", "-DWORKBENCH_COVERAGE=ON"], /without coverage or sanitizers/]
        ];
        for (const [name, flags, message] of cases) {
          const result = await job.command(
            "cmake",
            [
              "-S",
              rejection,
              "-B",
              join(rejection, name),
              "-G",
              "Ninja",
              ...compilerArguments(),
              "-DCMAKE_BUILD_TYPE=Release",
              `-DWORKBENCH_PGO_DIRECTORY=${join(rejection, "profiles")}`,
              ...flags
            ],
            { capture: true, cwd: root }
          );
          assert.ok(
            !result.error && result.status !== null && result.status !== 0 && message.test(result.stdout + result.stderr),
            `PGO ${name} must fail with a useful diagnostic: ${String(result.error ?? result.stdout + result.stderr)}`
          );
        }
      } finally {
        rmSync(rejection, { force: true, recursive: true });
      }
      const { nativePGO } = await import("./native-pgo.mjs");
      await nativePGO({
        builds,
        language,
        compiler: selectedCompiler,
        configure,
        test,
        verify: verifyRelease,
        run,
        job
      });
    } else if (role === "hardening") {
      const directory = join(builds, "hardened");
      await configure(directory, ["-DCMAKE_BUILD_TYPE=Release", "-DWORKBENCH_HARDENING=ON"]);
      await verifyRelease(directory);
      const { inspectHardening } = await import("./executable-hardening.mjs");
      console.log(JSON.stringify(inspectHardening(readFileSync(join(directory, `count${suffix}`)))));
    } else if (role === "build" || role === "release") {
      const directory = role === "release" ? join(builds, "release") : debug;
      await configure(
        directory,
        role === "release" ? ["-DCMAKE_BUILD_TYPE=Release", `-DWORKBENCH_LTO=${process.env.WORKBENCH_LTO ?? "off"}`] : []
      );
      if (role === "release") {
        await verifyRelease(directory);
        const output = resolve(process.env.WORKBENCH_RELEASE_OUTPUT ?? process.env.WORKBENCH_DIST_DIR ?? "dist");
        mkdirSync(output, { recursive: true });
        copyFileSync(join(directory, `count${suffix}`), join(output, `count${suffix}`));
        copyFileSync("LICENSE", join(output, "LICENSE"));
      } else await run("cmake", ["--build", directory, "--parallel", parallelism]);
    } else if (role === "lto") {
      for (const mode of selectedCompiler === "clang" ? ["off", "thin", "full"] : ["off", "full"]) {
        const directory = join(builds, `lto-${mode}`);
        await configure(directory, ["-DCMAKE_BUILD_TYPE=Release", `-DWORKBENCH_LTO=${mode}`]);
        await verifyRelease(directory);
      }
      await rejectLto("invalid", ["-DWORKBENCH_LTO=unknown"], /must select off, thin, or full/);
      await rejectLto("debug", ["-DCMAKE_BUILD_TYPE=Debug"], /separate optimized single-configuration build/);
      await rejectLto("coverage", ["-DWORKBENCH_COVERAGE=ON"], /separate LTO build from coverage and sanitizers/);
      await rejectLto("sanitizers", ["-DWORKBENCH_SANITIZERS=ON"], /separate LTO build from coverage and sanitizers/);
      if (selectedCompiler !== "clang")
        await rejectLto("thin", ["-DWORKBENCH_LTO=thin"], /does not support the requested LTO mode/);
      else await rejectLto("tool-version", [`-Dlto_linker=${process.execPath}`], /must match Clang/);
    } else if (role === "test") {
      await configure(debug);
      await test(debug);
    } else if (role === "coverage") {
      const { nativeCoverageSources, assertNativeCoverageScope } = await import("./native-coverage.mjs");
      if (existsSync("coverage") && lstatSync("coverage").isSymbolicLink())
        throw new Error("coverage must be a real directory");
      mkdirSync("coverage", { recursive: true });
      for (const name of readdirSync("coverage"))
        if (name !== "coverage-summary.json") rmSync(join("coverage", name), { recursive: true, force: true });
      if (selectedCompiler !== "clang") {
        await configure(debug);
        await test(debug);
      }
      const instrumented = join(builds, "coverage");
      await configure(instrumented, ["-DWORKBENCH_COVERAGE=ON"], "clang");
      const temporary = mkdtempSync(join(instrumented, "profiles-"));
      try {
        await test(instrumented, temporary);
        const profiles = files(temporary).filter((file) => file.endsWith(".profraw"));
        if (!profiles.length) throw new Error("coverage produced no execution profiles");
        const merged = join(temporary, "merged.profdata");
        await run("llvm-profdata", ["merge", "-sparse", ...profiles, "-o", merged]);
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
        await run("llvm-cov", ["report", ...coverageArgs]);
        const report = JSON.parse(await run("llvm-cov", ["export", ...coverageArgs], { stdio: "pipe" }));
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
      await configure(join(builds, "a"), ["-DWORKBENCH_SANITIZERS=ON"]);
      await test(join(builds, "a"));
      await configure(join(builds, "p"), ["-DWORKBENCH_SANITIZERS=ON", "-DWORKBENCH_PORTABLE_ONLY=ON"]);
      await test(join(builds, "p"));
    } else {
      throw new Error("expected build, release, format, format-write, lint, test, coverage, sanitizers, or lto");
    }
  });
}
export {
  runNativeChecks
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5hdGl2ZS1jLWNoZWNrcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyB3aXRoRW5naW5lZXJpbmdSdW4sIHR5cGUgRW5naW5lZXJpbmdDb21tYW5kT3B0aW9ucyB9IGZyb20gXCIuL2VuZ2luZWVyaW5nLXJ1bi5tanNcIjtcblxuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbHN0YXRTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIG1rZGlyU3luYyxcbiAgbWtkdGVtcFN5bmMsXG4gIHJtU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbiAgY29weUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuaW1wb3J0IHsgY29tcGlsZXJDYXRhbG9nLCBpc0NvbXBpbGVyRmFtaWx5LCB0eXBlIENvbXBpbGVyRmFtaWx5IH0gZnJvbSBcIi4vY29tcGlsZXItY2F0YWxvZy5tanNcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bk5hdGl2ZUNoZWNrcyhsYW5ndWFnZTogXCJjXCIgfCBcImNwcFwiLCBkaXN0cmlidXRpb246IHN0cmluZywgcm9sZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJvb3QgPSByZWFscGF0aFN5bmMubmF0aXZlKHByb2Nlc3MuY3dkKCkpO1xuICBjb25zdCB7IGNwdUJ1ZGdldCB9ID0gKGF3YWl0IGltcG9ydChcbiAgICBwYXRoVG9GaWxlVVJMKGpvaW4oZGlzdHJpYnV0aW9uLCBcInNjcmlwdHMvY3B1LWJ1ZGdldC5tanNcIikpLmhyZWZcbiAgKSkgYXMgdHlwZW9mIGltcG9ydChcIi4vY3B1LWJ1ZGdldC5tanNcIik7XG5cbiAgY29uc3QgeyBlbWl0Q2hlY2tEZXRhaWwgfSA9IChhd2FpdCBpbXBvcnQoXG4gICAgcGF0aFRvRmlsZVVSTChqb2luKGRpc3RyaWJ1dGlvbiwgXCJzY3JpcHRzL2NoZWNrLWRldGFpbC1kYXRhLm1qc1wiKSkuaHJlZlxuICApKSBhcyB0eXBlb2YgaW1wb3J0KFwiLi9jaGVjay1kZXRhaWwtZGF0YS5tanNcIik7XG4gIGNvbnN0IGNvbmZpZ3VyZWRCdWlsZHMgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQlVJTERfRElSO1xuICBpZiAoIWNvbmZpZ3VyZWRCdWlsZHMpIHRocm93IG5ldyBFcnJvcihcInVzZSBXb3JrYmVuY2ggY2hlY2tzIG9yIGEgY29uZmlndXJlZCBXb3JrYmVuY2ggc2hlbGwgZm9yIG5hdGl2ZSBidWlsZHNcIik7XG4gIGNvbnN0IGJ1aWxkcyA9IGNvbmZpZ3VyZWRCdWlsZHM7XG4gIGNvbnN0IGRlYnVnID0gam9pbihidWlsZHMsIFwiZGVidWdcIik7XG4gIGNvbnN0IHBvbGljeSA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKFwid29ya2JlbmNoL3F1YWxpdHkuanNvblwiLCBcInV0ZjhcIikpIGFzIHtcbiAgICBzbG93X3Rlc3Rfc2Vjb25kczogbnVtYmVyO1xuICAgIGNvdmVyYWdlOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xuICB9O1xuICBjb25zdCBzdWZmaXggPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcIi5leGVcIiA6IFwiXCI7XG4gIGNvbnN0IHJlcXVlc3RlZENvbXBpbGVyID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NPTVBJTEVSID8/IFwiY2xhbmdcIjtcbiAgaWYgKCFpc0NvbXBpbGVyRmFtaWx5KHJlcXVlc3RlZENvbXBpbGVyKSkgdGhyb3cgbmV3IEVycm9yKFwiU2VsZWN0IGEgZGVjbGFyZWQgbmF0aXZlIGNvbXBpbGVyXCIpO1xuICBjb25zdCBzZWxlY3RlZENvbXBpbGVyOiBDb21waWxlckZhbWlseSA9IHJlcXVlc3RlZENvbXBpbGVyO1xuICBpZiAoXG4gICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiICYmXG4gICAgc2VsZWN0ZWRDb21waWxlciA9PT0gXCJtdnNjXCIgJiZcbiAgICByb2xlICE9PSBcImZvcm1hdFwiICYmXG4gICAgcm9sZSAhPT0gXCJmb3JtYXQtd3JpdGVcIiAmJlxuICAgIHByb2Nlc3MuZW52LldPUktCRU5DSF9OQVRJVkVfVVRGOF9DT05TT0xFICE9PSBcIjFcIlxuICApIHtcbiAgICBjb25zdCB7IHJ1bldpbmRvd3NVdGY4Q29uc29sZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi93aW5kb3dzLXV0ZjgtY29uc29sZS5tanNcIik7XG4gICAgYXdhaXQgcnVuV2luZG93c1V0ZjhDb25zb2xlKHByb2Nlc3MuYXJndi5zbGljZSgxKSwgYnVpbGRzKTtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgd2l0aEVuZ2luZWVyaW5nUnVuKGJ1aWxkcywgXCJuYXRpdmUtY2hlY2tcIiwgYXN5bmMgKGpvYikgPT4ge1xuICAgIGNvbnN0IG1hbmFnZWQgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9DT01QSUxFUiA9PT0gXCIxXCI7XG4gICAgY29uc3QgcGFyYWxsZWxpc20gPSBTdHJpbmcoY3B1QnVkZ2V0KCkpO1xuICAgIHByb2Nlc3MuZW52LkNURVNUX1BBUkFMTEVMX0xFVkVMID0gcGFyYWxsZWxpc207XG4gICAgY29uc3QgcnVuID0gKGNvbW1hbmQ6IHN0cmluZywgYXJnczogc3RyaW5nW10gPSBbXSwgb3B0aW9uczogRW5naW5lZXJpbmdDb21tYW5kT3B0aW9ucyAmIHsgc3RkaW8/OiBcInBpcGVcIiB9ID0ge30pID0+XG4gICAgICBqb2IucnVuKGNvbW1hbmQsIGFyZ3MsIHsgY3dkOiByb290LCAuLi5vcHRpb25zLCBjYXB0dXJlOiBvcHRpb25zLnN0ZGlvID09PSBcInBpcGVcIiB9KTtcbiAgICBmdW5jdGlvbiBjb2xsZWN0Q01ha2VGYWlsdXJlTG9ncyhkaXJlY3Rvcnk6IHN0cmluZykge1xuICAgICAgY29uc3QgYnVpbGR0cmVlcyA9IGpvaW4oZGlyZWN0b3J5LCBcImJ0XCIpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgb3V0cHV0ID0gam9pbihyb290LCBcImNvdmVyYWdlXCIsIFwiY21ha2VcIiwgcmVsYXRpdmUoYnVpbGRzLCBkaXJlY3RvcnkpLnJlcGxhY2VBbGwoc2VwLCBcIi1cIikpO1xuICAgICAgICBjb25zdCBwb3J0TG9ncyA9IGV4aXN0c1N5bmMoYnVpbGR0cmVlcylcbiAgICAgICAgICA/IGZpbGVzKGJ1aWxkdHJlZXMpLmZpbHRlcigocGF0aCkgPT4gcGF0aC5lbmRzV2l0aChcIi5sb2dcIikgJiYgbHN0YXRTeW5jKHBhdGgpLmlzRmlsZSgpKVxuICAgICAgICAgIDogW107XG4gICAgICAgIGZvciAoY29uc3QgcGF0aCBvZiBwb3J0TG9ncykge1xuICAgICAgICAgIGNvbnN0IGRlc3RpbmF0aW9uID0gam9pbihvdXRwdXQsIFwidmNwa2dfYnVpbGR0cmVlc1wiLCByZWxhdGl2ZShidWlsZHRyZWVzLCBwYXRoKSk7XG4gICAgICAgICAgbWtkaXJTeW5jKGpvaW4oZGVzdGluYXRpb24sIFwiLi5cIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgIGNvcHlGaWxlU3luYyhwYXRoLCBkZXN0aW5hdGlvbik7XG4gICAgICAgICAgaWYgKC8tKG91dHxlcnIpXFwubG9nJC8udGVzdChwYXRoKSlcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYCR7cGF0aH1cXG4ke3JlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikuc2xpY2UoLTgxOTIpLnNwbGl0KC9cXHI/XFxuLykuc2xpY2UoLTQwKS5qb2luKFwiXFxuXCIpfWApO1xuICAgICAgICB9XG4gICAgICAgIC8vIENvbXBpbGVyIGRldGVjdGlvbiBjYW4gc3VjY2VlZCBiZWZvcmUgYSBkZXBlbmRlbmN5IGZhaWxzLiBQcmVzZXJ2ZSB0aGUgbWFuaWZlc3QncyBhY3R1YWwgZXJyb3IsXG4gICAgICAgIC8vIGFuZCBwcmludCBpdCBsYXN0IHNvIGJvdW5kZWQgdGVybWluYWwgZXhjZXJwdHMgcmV0YWluIHRoZSBjYXVzZSByYXRoZXIgdGhhbiBjb21waWxlciB3YXJuaW5ncy5cbiAgICAgICAgY29uc3QgbWFuaWZlc3QgPSBqb2luKGRpcmVjdG9yeSwgXCJ2Y3BrZy1tYW5pZmVzdC1pbnN0YWxsLmxvZ1wiKTtcbiAgICAgICAgaWYgKGV4aXN0c1N5bmMobWFuaWZlc3QpICYmIGxzdGF0U3luYyhtYW5pZmVzdCkuaXNGaWxlKCkpIHtcbiAgICAgICAgICBta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICBjb3B5RmlsZVN5bmMobWFuaWZlc3QsIGpvaW4ob3V0cHV0LCBcInZjcGtnLW1hbmlmZXN0LWluc3RhbGwubG9nXCIpKTtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICAgICAgLy8gY29kZXFsW2pzL2ZpbGUtc3lzdGVtLXJhY2VdIFRoaXMgaXMgYSByZWFkLW9ubHkgZGlhZ25vc3RpYyBmcm9tIHRoZSBvd25lZCBidWlsZCBkaXJlY3Rvcnk7IHRoZSBjaGVjayBncmFudHMgbm8gcGVybWlzc2lvbiB0byBtb2RpZnkgaXQuXG4gICAgICAgICAgICBgJHttYW5pZmVzdH1cXG4ke3JlYWRGaWxlU3luYyhtYW5pZmVzdCwgXCJ1dGY4XCIpLnNsaWNlKC04MTkyKS5zcGxpdCgvXFxyP1xcbi8pLnNsaWNlKC00MCkuam9pbihcIlxcblwiKX1gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBvcnRMb2dzLmxlbmd0aCB8fCBleGlzdHNTeW5jKG1hbmlmZXN0KSkgY29uc29sZS5lcnJvcihgQ01ha2UgZmFpbHVyZSBsb2dzOiAke291dHB1dH1gKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYENvdWxkIG5vdCByZXRhaW4gQ01ha2UgZmFpbHVyZSBsb2dzOiAke1N0cmluZyhlcnJvcil9YCk7XG4gICAgICB9XG4gICAgfVxuICAgIGZ1bmN0aW9uIGZpbGVzKGRpcmVjdG9yeTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcmVjdG9yeSwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pLmZsYXRNYXAoKGVudHJ5KSA9PlxuICAgICAgICBlbnRyeS5pc0RpcmVjdG9yeSgpID8gZmlsZXMoam9pbihkaXJlY3RvcnksIGVudHJ5Lm5hbWUpKSA6IFtqb2luKGRpcmVjdG9yeSwgZW50cnkubmFtZSldLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3Qgc291cmNlcyA9IFtcInNyY1wiLCBcImluY2x1ZGVcIiwgXCJ0ZXN0c1wiXS5mbGF0TWFwKGZpbGVzKS5maWx0ZXIoKGZpbGUpID0+IC9cXC4oPzpjfGNwcHxofGhwcCkkLy50ZXN0KGZpbGUpKTtcbiAgICBmdW5jdGlvbiBjb21waWxlckFyZ3VtZW50cyhjb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSBzZWxlY3RlZENvbXBpbGVyKSB7XG4gICAgICBjb25zdCBleGVjdXRhYmxlID1cbiAgICAgICAgY29tcGlsZXIgPT09IHNlbGVjdGVkQ29tcGlsZXIgPyBwcm9jZXNzLmVudltsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIldPUktCRU5DSF9DQ1wiIDogXCJXT1JLQkVOQ0hfQ1hYXCJdIDogdW5kZWZpbmVkO1xuICAgICAgcmV0dXJuIFtcbiAgICAgICAgYC1EQ01BS0VfJHtsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIkNcIiA6IFwiQ1hYXCJ9X0NPTVBJTEVSPSR7ZXhlY3V0YWJsZSA/PyBjb21waWxlckNhdGFsb2dbY29tcGlsZXJdLmV4ZWN1dGFibGVzW2xhbmd1YWdlXX1gLFxuICAgICAgXTtcbiAgICB9XG4gICAgYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlKGRpcmVjdG9yeTogc3RyaW5nLCBvcHRpb25zOiBzdHJpbmdbXSA9IFtdLCBjb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSBzZWxlY3RlZENvbXBpbGVyKSB7XG4gICAgICBpZiAoIW1hbmFnZWQpIHtcbiAgICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgICBcInZjcGtnLXByZXBhcmVcIixcbiAgICAgICAgICByb290LFxuICAgICAgICAgIGRpcmVjdG9yeSxcbiAgICAgICAgICBcIi0tY29tcGlsZXJcIixcbiAgICAgICAgICBjb21waWxlcixcbiAgICAgICAgICAuLi4ob3B0aW9ucy5pbmNsdWRlcyhcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIikgPyBbXCItLXNhbml0aXplcnNcIl0gOiBbXSksXG4gICAgICAgIF0pO1xuICAgICAgICBwcm9jZXNzLmVudi5WQ1BLR19ESVNBQkxFX01FVFJJQ1MgPSBcIjFcIjtcbiAgICAgICAgcHJvY2Vzcy5lbnYuVkNQS0dfRk9SQ0VfU1lTVEVNX0JJTkFSSUVTID0gXCIxXCI7XG4gICAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5WQ1BLR19GT1JDRV9ET1dOTE9BREVEX0JJTkFSSUVTO1xuICAgICAgICBwcm9jZXNzLmVudi5WQ1BLR19NQVhfQ09OQ1VSUkVOQ1kgPSBwYXJhbGxlbGlzbTtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHJ1bihcImNtYWtlXCIsIFtcbiAgICAgICAgICBcIi1TXCIsXG4gICAgICAgICAgcm9vdCxcbiAgICAgICAgICBcIi1CXCIsXG4gICAgICAgICAgZGlyZWN0b3J5LFxuICAgICAgICAgIFwiLUdcIixcbiAgICAgICAgICBcIk5pbmphXCIsXG4gICAgICAgICAgXCItRENNQUtFX0JVSUxEX1RZUEU9RGVidWdcIixcbiAgICAgICAgICBcIi1EV09SS0JFTkNIX0xUTz1vZmZcIixcbiAgICAgICAgICBcIi1EV09SS0JFTkNIX0NPVkVSQUdFPU9GRlwiLFxuICAgICAgICAgIFwiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PRkZcIixcbiAgICAgICAgICBcIi1EV09SS0JFTkNIX1BPUlRBQkxFX09OTFk9T0ZGXCIsXG4gICAgICAgICAgXCItRFdPUktCRU5DSF9QR089b2ZmXCIsXG4gICAgICAgICAgXCItRFdPUktCRU5DSF9TVEFUSUNfQU5BTFlTSVM9T0ZGXCIsXG4gICAgICAgICAgXCItRFdPUktCRU5DSF9IQVJERU5JTkc9T0ZGXCIsXG4gICAgICAgICAgLi4uKG1hbmFnZWRcbiAgICAgICAgICAgID8gY29tcGlsZXJBcmd1bWVudHMoY29tcGlsZXIpXG4gICAgICAgICAgICA6IFtgLURDTUFLRV9UT09MQ0hBSU5fRklMRT0ke2pvaW4oZGlyZWN0b3J5LCBcIndvcmtiZW5jaC12Y3BrZy5jbWFrZVwiKX1gXSksXG4gICAgICAgICAgLi4uKChwcm9jZXNzLmVudltsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIldPUktCRU5DSF9DX1NUQU5EQVJEXCIgOiBcIldPUktCRU5DSF9DWFhfU1RBTkRBUkRcIl0gPz9cbiAgICAgICAgICBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTEFOR1VBR0VfU1RBTkRBUkQpXG4gICAgICAgICAgICA/IFtcbiAgICAgICAgICAgICAgICBgLURXT1JLQkVOQ0hfTEFOR1VBR0VfU1RBTkRBUkQ9JHtwcm9jZXNzLmVudltsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIldPUktCRU5DSF9DX1NUQU5EQVJEXCIgOiBcIldPUktCRU5DSF9DWFhfU1RBTkRBUkRcIl0gPz8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEID8/IFwiXCJ9YCxcbiAgICAgICAgICAgICAgXVxuICAgICAgICAgICAgOiBbXSksXG4gICAgICAgICAgYC1EV09SS0JFTkNIX0NPTVBJTEVSX0ZBTUlMWT0ke2NvbXBpbGVyfWAsXG4gICAgICAgICAgYC1EV09SS0JFTkNIX0NPTVBJTEVSX01JTklNVU09JHtjb21waWxlciA9PT0gc2VsZWN0ZWRDb21waWxlciA/IChwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ09NUElMRVJfTUlOSU1VTSA/PyBcIlwiKSA6IFwiXCJ9YCxcbiAgICAgICAgICAuLi4ocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiICYmIG9wdGlvbnMuaW5jbHVkZXMoXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCIpXG4gICAgICAgICAgICA/IFtcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxXaXRoRGViSW5mb1wiXVxuICAgICAgICAgICAgOiBbXSksXG4gICAgICAgICAgLi4ub3B0aW9ucyxcbiAgICAgICAgXSk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb2xsZWN0Q01ha2VGYWlsdXJlTG9ncyhkaXJlY3RvcnkpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICB9XG4gICAgYXN5bmMgZnVuY3Rpb24gdGVzdChkaXJlY3Rvcnk6IHN0cmluZywgcHJvZmlsZXM/OiBzdHJpbmcpIHtcbiAgICAgIG1rZGlyU3luYyhcImNvdmVyYWdlXCIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29uc3QgcmVzdWx0cyA9IGpvaW4ocm9vdCwgXCJjb3ZlcmFnZVwiLCBgdGVzdHMtJHtkaXJlY3Rvcnkuc2xpY2UoYnVpbGRzLmxlbmd0aCArIDEpLnJlcGxhY2VBbGwoc2VwLCBcIi1cIil9LnhtbGApO1xuICAgICAgYXdhaXQgcnVuKFwiY21ha2VcIiwgW1wiLS1idWlsZFwiLCBkaXJlY3RvcnksIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICAgICAgYXdhaXQgcnVuKFxuICAgICAgICBcImN0ZXN0XCIsXG4gICAgICAgIFtcIi0tdGVzdC1kaXJcIiwgZGlyZWN0b3J5LCBcIi0tb3V0cHV0LW9uLWZhaWx1cmVcIiwgXCItLW5vLXRlc3RzPWVycm9yXCIsIFwiLS1vdXRwdXQtanVuaXRcIiwgcmVzdWx0c10sXG4gICAgICAgIHtcbiAgICAgICAgICBlbnY6IHsgLi4ucHJvY2Vzcy5lbnYsIC4uLihwcm9maWxlcyA/IHsgTExWTV9QUk9GSUxFX0ZJTEU6IGpvaW4ocHJvZmlsZXMsIFwiJXAtJW0ucHJvZnJhd1wiKSB9IDoge30pIH0sXG4gICAgICAgIH0sXG4gICAgICApO1xuICAgICAgY29uc3QgcmVwb3J0ID0gcmVhZEZpbGVTeW5jKHJlc3VsdHMsIFwidXRmOFwiKTtcbiAgICAgIGZvciAoY29uc3QgbWF0Y2ggb2YgcmVwb3J0Lm1hdGNoQWxsKC88dGVzdGNhc2VcXGIoW14+XSspPi9nKSkge1xuICAgICAgICBhc3NlcnQub2sobWF0Y2hbMV0sIFwiTWlzc2luZyB0ZXN0Y2FzZSBhdHRyaWJ1dGVzXCIpO1xuICAgICAgICBjb25zdCBuYW1lID0gL1xcYm5hbWU9XCIoW15cIl0rKVwiLy5leGVjKG1hdGNoWzFdKT8uWzFdO1xuICAgICAgICBjb25zdCBlbGFwc2VkID0gTnVtYmVyKC9cXGJ0aW1lPVwiKFteXCJdKylcIi8uZXhlYyhtYXRjaFsxXSk/LlsxXSk7XG4gICAgICAgIGlmIChyb2xlICE9PSBcImNvdmVyYWdlXCIgJiYgZWxhcHNlZCA+IHBvbGljeS5zbG93X3Rlc3Rfc2Vjb25kcykge1xuICAgICAgICAgIGVtaXRDaGVja0RldGFpbCh7XG4gICAgICAgICAgICB2ZXJzaW9uOiAxLFxuICAgICAgICAgICAga2luZDogXCJzbG93XCIsXG4gICAgICAgICAgICBzY29wZTogXCJ0ZXN0XCIsXG4gICAgICAgICAgICBuYW1lOiBTdHJpbmcobmFtZSksXG4gICAgICAgICAgICBlbGFwc2VkU2Vjb25kczogZWxhcHNlZCxcbiAgICAgICAgICAgIHRocmVzaG9sZFNlY29uZHM6IHBvbGljeS5zbG93X3Rlc3Rfc2Vjb25kcyxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICAgICAgYFNMT1cgdGVzdCAke1N0cmluZyhuYW1lKX06ICR7U3RyaW5nKGVsYXBzZWQpfXMgKHNvZnQgY2FwICR7U3RyaW5nKHBvbGljeS5zbG93X3Rlc3Rfc2Vjb25kcyl9czsgYWR2aXNvcnkgb25seSlgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiB2ZXJpZnlSZWxlYXNlKGRpcmVjdG9yeTogc3RyaW5nKSB7XG4gICAgICBhd2FpdCB0ZXN0KGRpcmVjdG9yeSk7XG4gICAgICBhd2FpdCBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4ocm9vdCwgXCJzY3JpcHRzL3JlbGVhc2UtdmVyaWZ5Lm1qc1wiKSwgZGlyZWN0b3J5XSk7XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gcmVqZWN0THRvKG5hbWU6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10sIGRpYWdub3N0aWM6IFJlZ0V4cCkge1xuICAgICAgLy8gUmV1c2UgdGhlIHZlcmlmaWVkIG9mZi1tb2RlIGRlcGVuZGVuY3kgaW5zdGFsbGF0aW9uLCB3aXRob3V0IHJlaW5zdGFsbGluZyBkZXBlbmRlbmNpZXMuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBqb2IuY29tbWFuZChcbiAgICAgICAgXCJjbWFrZVwiLFxuICAgICAgICBbXG4gICAgICAgICAgXCItU1wiLFxuICAgICAgICAgIFwiLlwiLFxuICAgICAgICAgIFwiLUJcIixcbiAgICAgICAgICBqb2luKGJ1aWxkcywgYGx0by1yZWplY3QtJHtuYW1lfWApLFxuICAgICAgICAgIFwiLUdcIixcbiAgICAgICAgICBcIk5pbmphXCIsXG4gICAgICAgICAgLi4uKG1hbmFnZWRcbiAgICAgICAgICAgID8gY29tcGlsZXJBcmd1bWVudHMoKVxuICAgICAgICAgICAgOiBbXG4gICAgICAgICAgICAgICAgYC1EQ01BS0VfVE9PTENIQUlOX0ZJTEU9JHtqb2luKGJ1aWxkcywgXCJsdG8tb2ZmXCIsIFwid29ya2JlbmNoLXZjcGtnLmNtYWtlXCIpfWAsXG4gICAgICAgICAgICAgICAgXCItRFZDUEtHX01BTklGRVNUX0lOU1RBTEw9T0ZGXCIsXG4gICAgICAgICAgICAgIF0pLFxuICAgICAgICAgIFwiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIixcbiAgICAgICAgICBcIi1EV09SS0JFTkNIX0xUTz1mdWxsXCIsXG4gICAgICAgICAgLi4ub3B0aW9ucyxcbiAgICAgICAgXSxcbiAgICAgICAgeyBjYXB0dXJlOiB0cnVlLCBjd2Q6IHJvb3QgfSxcbiAgICAgICk7XG4gICAgICBjb25zdCBvdXRwdXQgPSBgJHtyZXN1bHQuc3Rkb3V0fSR7cmVzdWx0LnN0ZGVycn1gO1xuICAgICAgaWYgKHJlc3VsdC5lcnJvciB8fCByZXN1bHQuc3RhdHVzID09PSBudWxsIHx8IHJlc3VsdC5zdGF0dXMgPT09IDAgfHwgIWRpYWdub3N0aWMudGVzdChvdXRwdXQpKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEV4cGVjdGVkIExUTyByZWplY3Rpb24gZm9yICR7bmFtZX06ICR7cmVzdWx0LmVycm9yID8/IG91dHB1dH1gKTtcbiAgICAgIGNvbnNvbGUubG9nKGBWZXJpZmllZCBMVE8gcmVqZWN0aW9uOiAke25hbWV9YCk7XG4gICAgfVxuXG4gICAgaWYgKHJvbGUgPT09IFwiZm9ybWF0XCIgfHwgcm9sZSA9PT0gXCJmb3JtYXQtd3JpdGVcIikge1xuICAgICAgYXdhaXQgcnVuKFwiY2xhbmctZm9ybWF0XCIsIFsuLi4ocm9sZSA9PT0gXCJmb3JtYXRcIiA/IFtcIi0tZHJ5LXJ1blwiLCBcIi0tV2Vycm9yXCJdIDogW1wiLWlcIl0pLCAuLi5zb3VyY2VzXSk7XG4gICAgfSBlbHNlIGlmIChyb2xlID09PSBcImxpbnRcIikge1xuICAgICAgYXdhaXQgcnVuKFwiY2xhbmctdGlkeVwiLCBbXCItLXZlcmlmeS1jb25maWdcIl0pO1xuICAgICAgY29uc3QgYW5hbHlzaXMgPSBzZWxlY3RlZENvbXBpbGVyID09PSBcImNsYW5nXCIgPyBkZWJ1ZyA6IGpvaW4oYnVpbGRzLCBcImFuYWx5c2lzLWNsYW5nXCIpO1xuICAgICAgYXdhaXQgY29uZmlndXJlKGFuYWx5c2lzLCBbXSwgXCJjbGFuZ1wiKTtcbiAgICAgIGF3YWl0IHJ1bihcImNtYWtlXCIsIFtcIi0tYnVpbGRcIiwgYW5hbHlzaXMsIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICAgICAgZm9yIChjb25zdCBzb3VyY2Ugb2Ygc291cmNlcy5maWx0ZXIoKGZpbGUpID0+IC9cXC4oPzpjfGNwcCkkLy50ZXN0KGZpbGUpKSlcbiAgICAgICAgYXdhaXQgcnVuKFwiY2xhbmctdGlkeVwiLCBbXCItcFwiLCBhbmFseXNpcywgc291cmNlXSk7XG4gICAgICBpZiAoKHNlbGVjdGVkQ29tcGlsZXIgPT09IFwiZ2NjXCIgJiYgbGFuZ3VhZ2UgPT09IFwiY1wiKSB8fCBzZWxlY3RlZENvbXBpbGVyID09PSBcIm12c2NcIikge1xuICAgICAgICBjb25zdCBhZGRpdGlvbmFsID0gam9pbihidWlsZHMsIGBhbmFseXNpcy0ke3NlbGVjdGVkQ29tcGlsZXJ9YCk7XG4gICAgICAgIGF3YWl0IGNvbmZpZ3VyZShhZGRpdGlvbmFsLCBbXCItRFdPUktCRU5DSF9TVEFUSUNfQU5BTFlTSVM9T05cIl0pO1xuICAgICAgICBhd2FpdCBydW4oXCJjbWFrZVwiLCBbXCItLWJ1aWxkXCIsIGFkZGl0aW9uYWwsIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJwZ29cIikge1xuICAgICAgY29uc3QgcmVqZWN0aW9uID0gam9pbihqb2IuZGlyZWN0b3J5LCBcIm9wdGltaXphdGlvbi1jb250cmFjdFwiKTtcbiAgICAgIG1rZGlyU3luYyhyZWplY3Rpb24pO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29weUZpbGVTeW5jKGpvaW4ocm9vdCwgXCJjbWFrZS9Xb3JrYmVuY2hPcHRpbWl6YXRpb24uY21ha2VcIiksIGpvaW4ocmVqZWN0aW9uLCBcIm9wdGltaXphdGlvbi5jbWFrZVwiKSk7XG4gICAgICAgIGNvbnN0IGNtYWtlTGFuZ3VhZ2UgPSBsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIkNcIiA6IFwiQ1hYXCI7XG4gICAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgICAgam9pbihyZWplY3Rpb24sIFwiQ01ha2VMaXN0cy50eHRcIiksXG4gICAgICAgICAgYGNtYWtlX21pbmltdW1fcmVxdWlyZWQoVkVSU0lPTiAzLjI1KVxcbnByb2plY3QoT3B0aW1pemF0aW9uIExBTkdVQUdFUyAke2NtYWtlTGFuZ3VhZ2V9KVxcbmluY2x1ZGUob3B0aW1pemF0aW9uLmNtYWtlKVxcbndvcmtiZW5jaF9vcHRpbWl6YXRpb24oJHtjbWFrZUxhbmd1YWdlfSlcXG5gLFxuICAgICAgICApO1xuICAgICAgICBjb25zdCBjYXNlczogW3N0cmluZywgc3RyaW5nW10sIFJlZ0V4cF1bXSA9IFtcbiAgICAgICAgICBbXCJpbnZhbGlkLW1vZGVcIiwgW1wiLURXT1JLQkVOQ0hfUEdPPWludmFsaWRcIl0sIC9tdXN0IHNlbGVjdCBvZmYsIGdlbmVyYXRlLCBvciB1c2UvXSxcbiAgICAgICAgICBbXCJtaXNzaW5nLXByb2ZpbGVcIiwgW1wiLURXT1JLQkVOQ0hfUEdPPXVzZVwiXSwgL1BHTyBwcm9maWxlcz8gKD86aXN8YXJlKSBtaXNzaW5nL10sXG4gICAgICAgICAgW1wibWl4ZWQtY292ZXJhZ2VcIiwgW1wiLURXT1JLQkVOQ0hfUEdPPWdlbmVyYXRlXCIsIFwiLURXT1JLQkVOQ0hfQ09WRVJBR0U9T05cIl0sIC93aXRob3V0IGNvdmVyYWdlIG9yIHNhbml0aXplcnMvXSxcbiAgICAgICAgXTtcbiAgICAgICAgZm9yIChjb25zdCBbbmFtZSwgZmxhZ3MsIG1lc3NhZ2VdIG9mIGNhc2VzKSB7XG4gICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgam9iLmNvbW1hbmQoXG4gICAgICAgICAgICBcImNtYWtlXCIsXG4gICAgICAgICAgICBbXG4gICAgICAgICAgICAgIFwiLVNcIixcbiAgICAgICAgICAgICAgcmVqZWN0aW9uLFxuICAgICAgICAgICAgICBcIi1CXCIsXG4gICAgICAgICAgICAgIGpvaW4ocmVqZWN0aW9uLCBuYW1lKSxcbiAgICAgICAgICAgICAgXCItR1wiLFxuICAgICAgICAgICAgICBcIk5pbmphXCIsXG4gICAgICAgICAgICAgIC4uLmNvbXBpbGVyQXJndW1lbnRzKCksXG4gICAgICAgICAgICAgIFwiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIixcbiAgICAgICAgICAgICAgYC1EV09SS0JFTkNIX1BHT19ESVJFQ1RPUlk9JHtqb2luKHJlamVjdGlvbiwgXCJwcm9maWxlc1wiKX1gLFxuICAgICAgICAgICAgICAuLi5mbGFncyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB7IGNhcHR1cmU6IHRydWUsIGN3ZDogcm9vdCB9LFxuICAgICAgICAgICk7XG4gICAgICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAgICAgIXJlc3VsdC5lcnJvciAmJlxuICAgICAgICAgICAgICByZXN1bHQuc3RhdHVzICE9PSBudWxsICYmXG4gICAgICAgICAgICAgIHJlc3VsdC5zdGF0dXMgIT09IDAgJiZcbiAgICAgICAgICAgICAgbWVzc2FnZS50ZXN0KHJlc3VsdC5zdGRvdXQgKyByZXN1bHQuc3RkZXJyKSxcbiAgICAgICAgICAgIGBQR08gJHtuYW1lfSBtdXN0IGZhaWwgd2l0aCBhIHVzZWZ1bCBkaWFnbm9zdGljOiAke1N0cmluZyhyZXN1bHQuZXJyb3IgPz8gcmVzdWx0LnN0ZG91dCArIHJlc3VsdC5zdGRlcnIpfWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgcm1TeW5jKHJlamVjdGlvbiwgeyBmb3JjZTogdHJ1ZSwgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgfVxuXG4gICAgICBjb25zdCB7IG5hdGl2ZVBHTyB9ID0gYXdhaXQgaW1wb3J0KFwiLi9uYXRpdmUtcGdvLm1qc1wiKTtcbiAgICAgIGF3YWl0IG5hdGl2ZVBHTyh7XG4gICAgICAgIGJ1aWxkcyxcbiAgICAgICAgbGFuZ3VhZ2UsXG4gICAgICAgIGNvbXBpbGVyOiBzZWxlY3RlZENvbXBpbGVyLFxuICAgICAgICBjb25maWd1cmUsXG4gICAgICAgIHRlc3QsXG4gICAgICAgIHZlcmlmeTogdmVyaWZ5UmVsZWFzZSxcbiAgICAgICAgcnVuLFxuICAgICAgICBqb2IsXG4gICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKHJvbGUgPT09IFwiaGFyZGVuaW5nXCIpIHtcbiAgICAgIGNvbnN0IGRpcmVjdG9yeSA9IGpvaW4oYnVpbGRzLCBcImhhcmRlbmVkXCIpO1xuICAgICAgYXdhaXQgY29uZmlndXJlKGRpcmVjdG9yeSwgW1wiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIiwgXCItRFdPUktCRU5DSF9IQVJERU5JTkc9T05cIl0pO1xuICAgICAgYXdhaXQgdmVyaWZ5UmVsZWFzZShkaXJlY3RvcnkpO1xuICAgICAgY29uc3QgeyBpbnNwZWN0SGFyZGVuaW5nIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2V4ZWN1dGFibGUtaGFyZGVuaW5nLm1qc1wiKTtcbiAgICAgIGNvbnNvbGUubG9nKEpTT04uc3RyaW5naWZ5KGluc3BlY3RIYXJkZW5pbmcocmVhZEZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBgY291bnQke3N1ZmZpeH1gKSkpKSk7XG4gICAgfSBlbHNlIGlmIChyb2xlID09PSBcImJ1aWxkXCIgfHwgcm9sZSA9PT0gXCJyZWxlYXNlXCIpIHtcbiAgICAgIGNvbnN0IGRpcmVjdG9yeSA9IHJvbGUgPT09IFwicmVsZWFzZVwiID8gam9pbihidWlsZHMsIFwicmVsZWFzZVwiKSA6IGRlYnVnO1xuICAgICAgYXdhaXQgY29uZmlndXJlKFxuICAgICAgICBkaXJlY3RvcnksXG4gICAgICAgIHJvbGUgPT09IFwicmVsZWFzZVwiXG4gICAgICAgICAgPyBbXCItRENNQUtFX0JVSUxEX1RZUEU9UmVsZWFzZVwiLCBgLURXT1JLQkVOQ0hfTFRPPSR7cHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xUTyA/PyBcIm9mZlwifWBdXG4gICAgICAgICAgOiBbXSxcbiAgICAgICk7XG4gICAgICBpZiAocm9sZSA9PT0gXCJyZWxlYXNlXCIpIHtcbiAgICAgICAgYXdhaXQgdmVyaWZ5UmVsZWFzZShkaXJlY3RvcnkpO1xuICAgICAgICBjb25zdCBvdXRwdXQgPSByZXNvbHZlKHByb2Nlc3MuZW52LldPUktCRU5DSF9SRUxFQVNFX09VVFBVVCA/PyBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfRElTVF9ESVIgPz8gXCJkaXN0XCIpO1xuICAgICAgICBta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgY29weUZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBgY291bnQke3N1ZmZpeH1gKSwgam9pbihvdXRwdXQsIGBjb3VudCR7c3VmZml4fWApKTtcbiAgICAgICAgY29weUZpbGVTeW5jKFwiTElDRU5TRVwiLCBqb2luKG91dHB1dCwgXCJMSUNFTlNFXCIpKTtcbiAgICAgIH0gZWxzZSBhd2FpdCBydW4oXCJjbWFrZVwiLCBbXCItLWJ1aWxkXCIsIGRpcmVjdG9yeSwgXCItLXBhcmFsbGVsXCIsIHBhcmFsbGVsaXNtXSk7XG4gICAgfSBlbHNlIGlmIChyb2xlID09PSBcImx0b1wiKSB7XG4gICAgICBmb3IgKGNvbnN0IG1vZGUgb2Ygc2VsZWN0ZWRDb21waWxlciA9PT0gXCJjbGFuZ1wiID8gW1wib2ZmXCIsIFwidGhpblwiLCBcImZ1bGxcIl0gOiBbXCJvZmZcIiwgXCJmdWxsXCJdKSB7XG4gICAgICAgIGNvbnN0IGRpcmVjdG9yeSA9IGpvaW4oYnVpbGRzLCBgbHRvLSR7bW9kZX1gKTtcbiAgICAgICAgYXdhaXQgY29uZmlndXJlKGRpcmVjdG9yeSwgW1wiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIiwgYC1EV09SS0JFTkNIX0xUTz0ke21vZGV9YF0pO1xuICAgICAgICBhd2FpdCB2ZXJpZnlSZWxlYXNlKGRpcmVjdG9yeSk7XG4gICAgICB9XG4gICAgICBhd2FpdCByZWplY3RMdG8oXCJpbnZhbGlkXCIsIFtcIi1EV09SS0JFTkNIX0xUTz11bmtub3duXCJdLCAvbXVzdCBzZWxlY3Qgb2ZmLCB0aGluLCBvciBmdWxsLyk7XG4gICAgICBhd2FpdCByZWplY3RMdG8oXCJkZWJ1Z1wiLCBbXCItRENNQUtFX0JVSUxEX1RZUEU9RGVidWdcIl0sIC9zZXBhcmF0ZSBvcHRpbWl6ZWQgc2luZ2xlLWNvbmZpZ3VyYXRpb24gYnVpbGQvKTtcbiAgICAgIGF3YWl0IHJlamVjdEx0byhcImNvdmVyYWdlXCIsIFtcIi1EV09SS0JFTkNIX0NPVkVSQUdFPU9OXCJdLCAvc2VwYXJhdGUgTFRPIGJ1aWxkIGZyb20gY292ZXJhZ2UgYW5kIHNhbml0aXplcnMvKTtcbiAgICAgIGF3YWl0IHJlamVjdEx0byhcInNhbml0aXplcnNcIiwgW1wiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiXSwgL3NlcGFyYXRlIExUTyBidWlsZCBmcm9tIGNvdmVyYWdlIGFuZCBzYW5pdGl6ZXJzLyk7XG4gICAgICBpZiAoc2VsZWN0ZWRDb21waWxlciAhPT0gXCJjbGFuZ1wiKVxuICAgICAgICBhd2FpdCByZWplY3RMdG8oXCJ0aGluXCIsIFtcIi1EV09SS0JFTkNIX0xUTz10aGluXCJdLCAvZG9lcyBub3Qgc3VwcG9ydCB0aGUgcmVxdWVzdGVkIExUTyBtb2RlLyk7XG4gICAgICBlbHNlIGF3YWl0IHJlamVjdEx0byhcInRvb2wtdmVyc2lvblwiLCBbYC1EbHRvX2xpbmtlcj0ke3Byb2Nlc3MuZXhlY1BhdGh9YF0sIC9tdXN0IG1hdGNoIENsYW5nLyk7XG4gICAgfSBlbHNlIGlmIChyb2xlID09PSBcInRlc3RcIikge1xuICAgICAgYXdhaXQgY29uZmlndXJlKGRlYnVnKTtcbiAgICAgIGF3YWl0IHRlc3QoZGVidWcpO1xuICAgIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJjb3ZlcmFnZVwiKSB7XG4gICAgICBjb25zdCB7IG5hdGl2ZUNvdmVyYWdlU291cmNlcywgYXNzZXJ0TmF0aXZlQ292ZXJhZ2VTY29wZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9uYXRpdmUtY292ZXJhZ2UubWpzXCIpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMoXCJjb3ZlcmFnZVwiKSAmJiBsc3RhdFN5bmMoXCJjb3ZlcmFnZVwiKS5pc1N5bWJvbGljTGluaygpKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJjb3ZlcmFnZSBtdXN0IGJlIGEgcmVhbCBkaXJlY3RvcnlcIik7XG4gICAgICBta2RpclN5bmMoXCJjb3ZlcmFnZVwiLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyhcImNvdmVyYWdlXCIpKVxuICAgICAgICBpZiAobmFtZSAhPT0gXCJjb3ZlcmFnZS1zdW1tYXJ5Lmpzb25cIikgcm1TeW5jKGpvaW4oXCJjb3ZlcmFnZVwiLCBuYW1lKSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgaWYgKHNlbGVjdGVkQ29tcGlsZXIgIT09IFwiY2xhbmdcIikge1xuICAgICAgICBhd2FpdCBjb25maWd1cmUoZGVidWcpO1xuICAgICAgICBhd2FpdCB0ZXN0KGRlYnVnKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGluc3RydW1lbnRlZCA9IGpvaW4oYnVpbGRzLCBcImNvdmVyYWdlXCIpO1xuICAgICAgYXdhaXQgY29uZmlndXJlKGluc3RydW1lbnRlZCwgW1wiLURXT1JLQkVOQ0hfQ09WRVJBR0U9T05cIl0sIFwiY2xhbmdcIik7XG4gICAgICBjb25zdCB0ZW1wb3JhcnkgPSBta2R0ZW1wU3luYyhqb2luKGluc3RydW1lbnRlZCwgXCJwcm9maWxlcy1cIikpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGVzdChpbnN0cnVtZW50ZWQsIHRlbXBvcmFyeSk7XG4gICAgICAgIGNvbnN0IHByb2ZpbGVzID0gZmlsZXModGVtcG9yYXJ5KS5maWx0ZXIoKGZpbGU6IHN0cmluZykgPT4gZmlsZS5lbmRzV2l0aChcIi5wcm9mcmF3XCIpKTtcbiAgICAgICAgaWYgKCFwcm9maWxlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIHByb2R1Y2VkIG5vIGV4ZWN1dGlvbiBwcm9maWxlc1wiKTtcbiAgICAgICAgY29uc3QgbWVyZ2VkID0gam9pbih0ZW1wb3JhcnksIFwibWVyZ2VkLnByb2ZkYXRhXCIpO1xuICAgICAgICBhd2FpdCBydW4oXCJsbHZtLXByb2ZkYXRhXCIsIFtcIm1lcmdlXCIsIFwiLXNwYXJzZVwiLCAuLi5wcm9maWxlcywgXCItb1wiLCBtZXJnZWRdKTtcbiAgICAgICAgY29uc3Qgc291cmNlRmlsZXMgPSBuYXRpdmVDb3ZlcmFnZVNvdXJjZXMoc291cmNlcy5maWx0ZXIoKGZpbGUpID0+ICFmaWxlLnN0YXJ0c1dpdGgoYHRlc3RzJHtzZXB9YCkpKTtcbiAgICAgICAgY29uc3QgY292ZXJhZ2VBcmdzID0gW1xuICAgICAgICAgIGpvaW4oaW5zdHJ1bWVudGVkLCBgY291bnRfdGVzdCR7c3VmZml4fWApLFxuICAgICAgICAgIFwiLW9iamVjdFwiLFxuICAgICAgICAgIGpvaW4oaW5zdHJ1bWVudGVkLCBgY291bnQke3N1ZmZpeH1gKSxcbiAgICAgICAgICBcIi1vYmplY3RcIixcbiAgICAgICAgICBqb2luKGluc3RydW1lbnRlZCwgYGNwdV90ZXN0JHtzdWZmaXh9YCksXG4gICAgICAgICAgYC1pbnN0ci1wcm9maWxlPSR7bWVyZ2VkfWAsXG4gICAgICAgICAgLi4uc291cmNlRmlsZXMsXG4gICAgICAgIF07XG4gICAgICAgIGF3YWl0IHJ1bihcImxsdm0tY292XCIsIFtcInJlcG9ydFwiLCAuLi5jb3ZlcmFnZUFyZ3NdKTtcbiAgICAgICAgY29uc3QgcmVwb3J0ID0gSlNPTi5wYXJzZShhd2FpdCBydW4oXCJsbHZtLWNvdlwiLCBbXCJleHBvcnRcIiwgLi4uY292ZXJhZ2VBcmdzXSwgeyBzdGRpbzogXCJwaXBlXCIgfSkpIGFzIHtcbiAgICAgICAgICBkYXRhOiB7IGZpbGVzOiB7IGZpbGVuYW1lOiBzdHJpbmcgfVtdOyB0b3RhbHM6IFJlY29yZDxzdHJpbmcsIHsgY291bnQ6IG51bWJlcjsgcGVyY2VudDogbnVtYmVyIH0+IH1bXTtcbiAgICAgICAgfTtcbiAgICAgICAgd3JpdGVGaWxlU3luYyhcImNvdmVyYWdlL3JlcG9ydC5qc29uXCIsIEpTT04uc3RyaW5naWZ5KHJlcG9ydCkpO1xuICAgICAgICBhc3NlcnQub2socmVwb3J0LmRhdGFbMF0sIFwiTExWTSBjb3ZlcmFnZSBkaWQgbm90IHJlcG9ydCB0b3RhbHNcIik7XG4gICAgICAgIGFzc2VydE5hdGl2ZUNvdmVyYWdlU2NvcGUoXG4gICAgICAgICAgcmVwb3J0LmRhdGFbMF0uZmlsZXMubWFwKChmaWxlKSA9PiBmaWxlLmZpbGVuYW1lKSxcbiAgICAgICAgICBzb3VyY2VGaWxlcyxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgdG90YWwgPSByZXBvcnQuZGF0YVswXS50b3RhbHM7XG4gICAgICAgIGZvciAoY29uc3QgW21ldHJpYywgbWluaW11bV0gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5LmNvdmVyYWdlKSkge1xuICAgICAgICAgIGlmICghdG90YWxbbWV0cmljXSB8fCB0b3RhbFttZXRyaWNdLmNvdW50ID09PSAwIHx8IHRvdGFsW21ldHJpY10ucGVyY2VudCA8IG1pbmltdW0pXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgIGAke21ldHJpY30gY292ZXJhZ2UgJHtTdHJpbmcodG90YWxbbWV0cmljXT8ucGVyY2VudCA/PyBcIm1pc3NpbmdcIil9JSBpcyBiZWxvdyAke1N0cmluZyhtaW5pbXVtKX0lYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIHJtU3luYyh0ZW1wb3JhcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHJvbGUgPT09IFwic2FuaXRpemVyc1wiKSB7XG4gICAgICBhd2FpdCBjb25maWd1cmUoam9pbihidWlsZHMsIFwiYVwiKSwgW1wiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiXSk7XG4gICAgICBhd2FpdCB0ZXN0KGpvaW4oYnVpbGRzLCBcImFcIikpO1xuICAgICAgYXdhaXQgY29uZmlndXJlKGpvaW4oYnVpbGRzLCBcInBcIiksIFtcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIiwgXCItRFdPUktCRU5DSF9QT1JUQUJMRV9PTkxZPU9OXCJdKTtcbiAgICAgIGF3YWl0IHRlc3Qoam9pbihidWlsZHMsIFwicFwiKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcImV4cGVjdGVkIGJ1aWxkLCByZWxlYXNlLCBmb3JtYXQsIGZvcm1hdC13cml0ZSwgbGludCwgdGVzdCwgY292ZXJhZ2UsIHNhbml0aXplcnMsIG9yIGx0b1wiKTtcbiAgICB9XG4gIH0pO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxZQUFZO0FBQ25CLFNBQVMsMEJBQTBEO0FBRW5FO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLE1BQU0sVUFBVSxTQUFTLFdBQVc7QUFDN0MsU0FBUyxxQkFBcUI7QUFFOUIsU0FBUyxpQkFBaUIsd0JBQTZDO0FBRXZFLGVBQXNCLGdCQUFnQixVQUF1QixjQUFzQixNQUE2QjtBQUM5RyxRQUFNLE9BQU8sYUFBYSxPQUFPLFFBQVEsSUFBSSxDQUFDO0FBQzlDLFFBQU0sRUFBRSxVQUFVLElBQUssTUFBTSxPQUMzQixjQUFjLEtBQUssY0FBYyx3QkFBd0IsQ0FBQyxFQUFFO0FBRzlELFFBQU0sRUFBRSxnQkFBZ0IsSUFBSyxNQUFNLE9BQ2pDLGNBQWMsS0FBSyxjQUFjLCtCQUErQixDQUFDLEVBQUU7QUFFckUsUUFBTSxtQkFBbUIsUUFBUSxJQUFJO0FBQ3JDLE1BQUksQ0FBQyxpQkFBa0IsT0FBTSxJQUFJLE1BQU0sd0VBQXdFO0FBQy9HLFFBQU0sU0FBUztBQUNmLFFBQU0sUUFBUSxL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
