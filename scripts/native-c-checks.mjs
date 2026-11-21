// Generated from native-c-checks.mts; edit the TypeScript source.
import assert from "node:assert/strict";
import { withEngineeringRun } from "../app/src/core/artifacts/engineering-run.mjs";
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
import {
  compilerCatalog,
  isCompilerFamily
} from "../app/src/core/toolchains/compiler-catalog.mjs";
async function runNativeChecks(language, distribution, role) {
  const root = realpathSync.native(process.cwd());
  const { cpuBudget } = await import(pathToFileURL(join(distribution, "app/src/core/execution/checks/cpu-budget.mjs")).href);
  const { emitCheckDetail } = await import(pathToFileURL(join(distribution, "app/src/core/execution/checks/check-detail-data.mjs")).href);
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
    const { runWindowsUtf8Console } = await import("../app/src/core/runtime/windows-utf8-console.mjs");
    await runWindowsUtf8Console(process.argv.slice(1), builds);
    return;
  }
  await withEngineeringRun(builds, "native-check", async (job) => {
    const managed = process.env.WORKBENCH_MANAGED_COMPILER === "1";
    const parallelism = String(cpuBudget());
    process.env.CTEST_PARALLEL_LEVEL = parallelism;
    const run = (command, args = [], options = {}) => {
      const pipe = process.env.WORKBENCH_JOBSERVER_FIFO;
      if (pipe && command === "cmake" && args[0] === "--build") {
        const env = { ...options.env ?? process.env };
        env.MAKEFLAGS = `${env.MAKEFLAGS ?? ""} -j --jobserver-auth=fifo:${pipe}`.trim();
        delete env.CMAKE_BUILD_PARALLEL_LEVEL;
        const explicit = args.indexOf("--parallel");
        if (explicit !== -1) args = [...args.slice(0, explicit), ...args.slice(explicit + 2)];
        options = { ...options, env };
      }
      return job.run(command, args, { cwd: root, ...options, capture: options.stdio === "pipe" });
    };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5hdGl2ZS1jLWNoZWNrcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyB3aXRoRW5naW5lZXJpbmdSdW4sIHR5cGUgRW5naW5lZXJpbmdDb21tYW5kT3B0aW9ucyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvYXJ0aWZhY3RzL2VuZ2luZWVyaW5nLXJ1bi5tanNcIjtcblxuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbHN0YXRTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIG1rZGlyU3luYyxcbiAgbWtkdGVtcFN5bmMsXG4gIHJtU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbiAgY29weUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuaW1wb3J0IHtcbiAgY29tcGlsZXJDYXRhbG9nLFxuICBpc0NvbXBpbGVyRmFtaWx5LFxuICB0eXBlIENvbXBpbGVyRmFtaWx5LFxufSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3Rvb2xjaGFpbnMvY29tcGlsZXItY2F0YWxvZy5tanNcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bk5hdGl2ZUNoZWNrcyhsYW5ndWFnZTogXCJjXCIgfCBcImNwcFwiLCBkaXN0cmlidXRpb246IHN0cmluZywgcm9sZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJvb3QgPSByZWFscGF0aFN5bmMubmF0aXZlKHByb2Nlc3MuY3dkKCkpO1xuICBjb25zdCB7IGNwdUJ1ZGdldCB9ID0gKGF3YWl0IGltcG9ydChcbiAgICBwYXRoVG9GaWxlVVJMKGpvaW4oZGlzdHJpYnV0aW9uLCBcImFwcC9zcmMvY29yZS9leGVjdXRpb24vY2hlY2tzL2NwdS1idWRnZXQubWpzXCIpKS5ocmVmXG4gICkpIGFzIHR5cGVvZiBpbXBvcnQoXCIuLi9hcHAvc3JjL2NvcmUvZXhlY3V0aW9uL2NoZWNrcy9jcHUtYnVkZ2V0Lm1qc1wiKTtcblxuICBjb25zdCB7IGVtaXRDaGVja0RldGFpbCB9ID0gKGF3YWl0IGltcG9ydChcbiAgICBwYXRoVG9GaWxlVVJMKGpvaW4oZGlzdHJpYnV0aW9uLCBcImFwcC9zcmMvY29yZS9leGVjdXRpb24vY2hlY2tzL2NoZWNrLWRldGFpbC1kYXRhLm1qc1wiKSkuaHJlZlxuICApKSBhcyB0eXBlb2YgaW1wb3J0KFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9jaGVja3MvY2hlY2stZGV0YWlsLWRhdGEubWpzXCIpO1xuICBjb25zdCBjb25maWd1cmVkQnVpbGRzID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0JVSUxEX0RJUjtcbiAgaWYgKCFjb25maWd1cmVkQnVpbGRzKSB0aHJvdyBuZXcgRXJyb3IoXCJ1c2UgV29ya2JlbmNoIGNoZWNrcyBvciBhIGNvbmZpZ3VyZWQgV29ya2JlbmNoIHNoZWxsIGZvciBuYXRpdmUgYnVpbGRzXCIpO1xuICBjb25zdCBidWlsZHMgPSBjb25maWd1cmVkQnVpbGRzO1xuICBjb25zdCBkZWJ1ZyA9IGpvaW4oYnVpbGRzLCBcImRlYnVnXCIpO1xuICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhcIndvcmtiZW5jaC9xdWFsaXR5Lmpzb25cIiwgXCJ1dGY4XCIpKSBhcyB7XG4gICAgc2xvd190ZXN0X3NlY29uZHM6IG51bWJlcjtcbiAgICBjb3ZlcmFnZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbiAgfTtcbiAgY29uc3Qgc3VmZml4ID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCIuZXhlXCIgOiBcIlwiO1xuICBjb25zdCByZXF1ZXN0ZWRDb21waWxlciA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9DT01QSUxFUiA/PyBcImNsYW5nXCI7XG4gIGlmICghaXNDb21waWxlckZhbWlseShyZXF1ZXN0ZWRDb21waWxlcikpIHRocm93IG5ldyBFcnJvcihcIlNlbGVjdCBhIGRlY2xhcmVkIG5hdGl2ZSBjb21waWxlclwiKTtcbiAgY29uc3Qgc2VsZWN0ZWRDb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSByZXF1ZXN0ZWRDb21waWxlcjtcbiAgaWYgKFxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiAmJlxuICAgIHNlbGVjdGVkQ29tcGlsZXIgPT09IFwibXZzY1wiICYmXG4gICAgcm9sZSAhPT0gXCJmb3JtYXRcIiAmJlxuICAgIHJvbGUgIT09IFwiZm9ybWF0LXdyaXRlXCIgJiZcbiAgICBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTkFUSVZFX1VURjhfQ09OU09MRSAhPT0gXCIxXCJcbiAgKSB7XG4gICAgY29uc3QgeyBydW5XaW5kb3dzVXRmOENvbnNvbGUgfSA9IGF3YWl0IGltcG9ydChcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL3dpbmRvd3MtdXRmOC1jb25zb2xlLm1qc1wiKTtcbiAgICBhd2FpdCBydW5XaW5kb3dzVXRmOENvbnNvbGUocHJvY2Vzcy5hcmd2LnNsaWNlKDEpLCBidWlsZHMpO1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCB3aXRoRW5naW5lZXJpbmdSdW4oYnVpbGRzLCBcIm5hdGl2ZS1jaGVja1wiLCBhc3luYyAoam9iKSA9PiB7XG4gICAgY29uc3QgbWFuYWdlZCA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0NPTVBJTEVSID09PSBcIjFcIjtcbiAgICBjb25zdCBwYXJhbGxlbGlzbSA9IFN0cmluZyhjcHVCdWRnZXQoKSk7XG4gICAgcHJvY2Vzcy5lbnYuQ1RFU1RfUEFSQUxMRUxfTEVWRUwgPSBwYXJhbGxlbGlzbTtcbiAgICBjb25zdCBydW4gPSAoXG4gICAgICBjb21tYW5kOiBzdHJpbmcsXG4gICAgICBhcmdzOiBzdHJpbmdbXSA9IFtdLFxuICAgICAgb3B0aW9uczogRW5naW5lZXJpbmdDb21tYW5kT3B0aW9ucyAmIHsgc3RkaW8/OiBcInBpcGVcIiB9ID0ge30sXG4gICAgKSA9PiB7XG4gICAgICBjb25zdCBwaXBlID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0pPQlNFUlZFUl9GSUZPO1xuICAgICAgaWYgKHBpcGUgJiYgY29tbWFuZCA9PT0gXCJjbWFrZVwiICYmIGFyZ3NbMF0gPT09IFwiLS1idWlsZFwiKSB7XG4gICAgICAgIGNvbnN0IGVudiA9IHsgLi4uKG9wdGlvbnMuZW52ID8/IHByb2Nlc3MuZW52KSB9O1xuICAgICAgICBlbnYuTUFLRUZMQUdTID0gYCR7ZW52Lk1BS0VGTEFHUyA/PyBcIlwifSAtaiAtLWpvYnNlcnZlci1hdXRoPWZpZm86JHtwaXBlfWAudHJpbSgpO1xuICAgICAgICBkZWxldGUgZW52LkNNQUtFX0JVSUxEX1BBUkFMTEVMX0xFVkVMO1xuICAgICAgICBjb25zdCBleHBsaWNpdCA9IGFyZ3MuaW5kZXhPZihcIi0tcGFyYWxsZWxcIik7XG4gICAgICAgIGlmIChleHBsaWNpdCAhPT0gLTEpIGFyZ3MgPSBbLi4uYXJncy5zbGljZSgwLCBleHBsaWNpdCksIC4uLmFyZ3Muc2xpY2UoZXhwbGljaXQgKyAyKV07XG4gICAgICAgIG9wdGlvbnMgPSB7IC4uLm9wdGlvbnMsIGVudiB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIGpvYi5ydW4oY29tbWFuZCwgYXJncywgeyBjd2Q6IHJvb3QsIC4uLm9wdGlvbnMsIGNhcHR1cmU6IG9wdGlvbnMuc3RkaW8gPT09IFwicGlwZVwiIH0pO1xuICAgIH07XG4gICAgZnVuY3Rpb24gY29sbGVjdENNYWtlRmFpbHVyZUxvZ3MoZGlyZWN0b3J5OiBzdHJpbmcpIHtcbiAgICAgIGNvbnN0IGJ1aWxkdHJlZXMgPSBqb2luKGRpcmVjdG9yeSwgXCJidFwiKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG91dHB1dCA9IGpvaW4ocm9vdCwgXCJjb3ZlcmFnZVwiLCBcImNtYWtlXCIsIHJlbGF0aXZlKGJ1aWxkcywgZGlyZWN0b3J5KS5yZXBsYWNlQWxsKHNlcCwgXCItXCIpKTtcbiAgICAgICAgY29uc3QgcG9ydExvZ3MgPSBleGlzdHNTeW5jKGJ1aWxkdHJlZXMpXG4gICAgICAgICAgPyBmaWxlcyhidWlsZHRyZWVzKS5maWx0ZXIoKHBhdGgpID0+IHBhdGguZW5kc1dpdGgoXCIubG9nXCIpICYmIGxzdGF0U3luYyhwYXRoKS5pc0ZpbGUoKSlcbiAgICAgICAgICA6IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHBhdGggb2YgcG9ydExvZ3MpIHtcbiAgICAgICAgICBjb25zdCBkZXN0aW5hdGlvbiA9IGpvaW4ob3V0cHV0LCBcInZjcGtnX2J1aWxkdHJlZXNcIiwgcmVsYXRpdmUoYnVpbGR0cmVlcywgcGF0aCkpO1xuICAgICAgICAgIG1rZGlyU3luYyhqb2luKGRlc3RpbmF0aW9uLCBcIi4uXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICBjb3B5RmlsZVN5bmMocGF0aCwgZGVzdGluYXRpb24pO1xuICAgICAgICAgIGlmICgvLShvdXR8ZXJyKVxcLmxvZyQvLnRlc3QocGF0aCkpXG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKGAke3BhdGh9XFxuJHtyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpLnNsaWNlKC04MTkyKS5zcGxpdCgvXFxyP1xcbi8pLnNsaWNlKC00MCkuam9pbihcIlxcblwiKX1gKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBDb21waWxlciBkZXRlY3Rpb24gY2FuIHN1Y2NlZWQgYmVmb3JlIGEgZGVwZW5kZW5jeSBmYWlscy4gUHJlc2VydmUgdGhlIG1hbmlmZXN0J3MgYWN0dWFsIGVycm9yLFxuICAgICAgICAvLyBhbmQgcHJpbnQgaXQgbGFzdCBzbyBib3VuZGVkIHRlcm1pbmFsIGV4Y2VycHRzIHJldGFpbiB0aGUgY2F1c2UgcmF0aGVyIHRoYW4gY29tcGlsZXIgd2FybmluZ3MuXG4gICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gam9pbihkaXJlY3RvcnksIFwidmNwa2ctbWFuaWZlc3QtaW5zdGFsbC5sb2dcIik7XG4gICAgICAgIGlmIChleGlzdHNTeW5jKG1hbmlmZXN0KSAmJiBsc3RhdFN5bmMobWFuaWZlc3QpLmlzRmlsZSgpKSB7XG4gICAgICAgICAgbWtkaXJTeW5jKG91dHB1dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgICAgY29weUZpbGVTeW5jKG1hbmlmZXN0LCBqb2luKG91dHB1dCwgXCJ2Y3BrZy1tYW5pZmVzdC1pbnN0YWxsLmxvZ1wiKSk7XG4gICAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICAgIC8vIGNvZGVxbFtqcy9maWxlLXN5c3RlbS1yYWNlXSBUaGlzIGlzIGEgcmVhZC1vbmx5IGRpYWdub3N0aWMgZnJvbSB0aGUgb3duZWQgYnVpbGQgZGlyZWN0b3J5OyB0aGUgY2hlY2sgZ3JhbnRzIG5vIHBlcm1pc3Npb24gdG8gbW9kaWZ5IGl0LlxuICAgICAgICAgICAgYCR7bWFuaWZlc3R9XFxuJHtyZWFkRmlsZVN5bmMobWFuaWZlc3QsIFwidXRmOFwiKS5zbGljZSgtODE5Mikuc3BsaXQoL1xccj9cXG4vKS5zbGljZSgtNDApLmpvaW4oXCJcXG5cIil9YCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwb3J0TG9ncy5sZW5ndGggfHwgZXhpc3RzU3luYyhtYW5pZmVzdCkpIGNvbnNvbGUuZXJyb3IoYENNYWtlIGZhaWx1cmUgbG9nczogJHtvdXRwdXR9YCk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKGBDb3VsZCBub3QgcmV0YWluIENNYWtlIGZhaWx1cmUgbG9nczogJHtTdHJpbmcoZXJyb3IpfWApO1xuICAgICAgfVxuICAgIH1cbiAgICBmdW5jdGlvbiBmaWxlcyhkaXJlY3Rvcnk6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICAgIHJldHVybiByZWFkZGlyU3luYyhkaXJlY3RvcnksIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KS5mbGF0TWFwKChlbnRyeSkgPT5cbiAgICAgICAgZW50cnkuaXNEaXJlY3RvcnkoKSA/IGZpbGVzKGpvaW4oZGlyZWN0b3J5LCBlbnRyeS5uYW1lKSkgOiBbam9pbihkaXJlY3RvcnksIGVudHJ5Lm5hbWUpXSxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHNvdXJjZXMgPSBbXCJzcmNcIiwgXCJpbmNsdWRlXCIsIFwidGVzdHNcIl0uZmxhdE1hcChmaWxlcykuZmlsdGVyKChmaWxlKSA9PiAvXFwuKD86Y3xjcHB8aHxocHApJC8udGVzdChmaWxlKSk7XG4gICAgZnVuY3Rpb24gY29tcGlsZXJBcmd1bWVudHMoY29tcGlsZXI6IENvbXBpbGVyRmFtaWx5ID0gc2VsZWN0ZWRDb21waWxlcikge1xuICAgICAgY29uc3QgZXhlY3V0YWJsZSA9XG4gICAgICAgIGNvbXBpbGVyID09PSBzZWxlY3RlZENvbXBpbGVyID8gcHJvY2Vzcy5lbnZbbGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJXT1JLQkVOQ0hfQ0NcIiA6IFwiV09SS0JFTkNIX0NYWFwiXSA6IHVuZGVmaW5lZDtcbiAgICAgIHJldHVybiBbXG4gICAgICAgIGAtRENNQUtFXyR7bGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJDXCIgOiBcIkNYWFwifV9DT01QSUxFUj0ke2V4ZWN1dGFibGUgPz8gY29tcGlsZXJDYXRhbG9nW2NvbXBpbGVyXS5leGVjdXRhYmxlc1tsYW5ndWFnZV19YCxcbiAgICAgIF07XG4gICAgfVxuICAgIGFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZShkaXJlY3Rvcnk6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10gPSBbXSwgY29tcGlsZXI6IENvbXBpbGVyRmFtaWx5ID0gc2VsZWN0ZWRDb21waWxlcikge1xuICAgICAgaWYgKCFtYW5hZ2VkKSB7XG4gICAgICAgIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbXG4gICAgICAgICAgam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgICAgXCJ2Y3BrZy1wcmVwYXJlXCIsXG4gICAgICAgICAgcm9vdCxcbiAgICAgICAgICBkaXJlY3RvcnksXG4gICAgICAgICAgXCItLWNvbXBpbGVyXCIsXG4gICAgICAgICAgY29tcGlsZXIsXG4gICAgICAgICAgLi4uKG9wdGlvbnMuaW5jbHVkZXMoXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCIpID8gW1wiLS1zYW5pdGl6ZXJzXCJdIDogW10pLFxuICAgICAgICBdKTtcbiAgICAgICAgcHJvY2Vzcy5lbnYuVkNQS0dfRElTQUJMRV9NRVRSSUNTID0gXCIxXCI7XG4gICAgICAgIHByb2Nlc3MuZW52LlZDUEtHX0ZPUkNFX1NZU1RFTV9CSU5BUklFUyA9IFwiMVwiO1xuICAgICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuVkNQS0dfRk9SQ0VfRE9XTkxPQURFRF9CSU5BUklFUztcbiAgICAgICAgcHJvY2Vzcy5lbnYuVkNQS0dfTUFYX0NPTkNVUlJFTkNZID0gcGFyYWxsZWxpc207XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBydW4oXCJjbWFrZVwiLCBbXG4gICAgICAgICAgXCItU1wiLFxuICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgXCItQlwiLFxuICAgICAgICAgIGRpcmVjdG9yeSxcbiAgICAgICAgICBcIi1HXCIsXG4gICAgICAgICAgXCJOaW5qYVwiLFxuICAgICAgICAgIFwiLURDTUFLRV9CVUlMRF9UWVBFPURlYnVnXCIsXG4gICAgICAgICAgXCItRFdPUktCRU5DSF9MVE89b2ZmXCIsXG4gICAgICAgICAgXCItRFdPUktCRU5DSF9DT1ZFUkFHRT1PRkZcIixcbiAgICAgICAgICBcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T0ZGXCIsXG4gICAgICAgICAgXCItRFdPUktCRU5DSF9QT1JUQUJMRV9PTkxZPU9GRlwiLFxuICAgICAgICAgIFwiLURXT1JLQkVOQ0hfUEdPPW9mZlwiLFxuICAgICAgICAgIFwiLURXT1JLQkVOQ0hfU1RBVElDX0FOQUxZU0lTPU9GRlwiLFxuICAgICAgICAgIFwiLURXT1JLQkVOQ0hfSEFSREVOSU5HPU9GRlwiLFxuICAgICAgICAgIC4uLihtYW5hZ2VkXG4gICAgICAgICAgICA/IGNvbXBpbGVyQXJndW1lbnRzKGNvbXBpbGVyKVxuICAgICAgICAgICAgOiBbYC1EQ01BS0VfVE9PTENIQUlOX0ZJTEU9JHtqb2luKGRpcmVjdG9yeSwgXCJ3b3JrYmVuY2gtdmNwa2cuY21ha2VcIil9YF0pLFxuICAgICAgICAgIC4uLigocHJvY2Vzcy5lbnZbbGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJXT1JLQkVOQ0hfQ19TVEFOREFSRFwiIDogXCJXT1JLQkVOQ0hfQ1hYX1NUQU5EQVJEXCJdID8/XG4gICAgICAgICAgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEKVxuICAgICAgICAgICAgPyBbXG4gICAgICAgICAgICAgICAgYC1EV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEPSR7cHJvY2Vzcy5lbnZbbGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJXT1JLQkVOQ0hfQ19TVEFOREFSRFwiIDogXCJXT1JLQkVOQ0hfQ1hYX1NUQU5EQVJEXCJdID8/IHByb2Nlc3MuZW52LldPUktCRU5DSF9MQU5HVUFHRV9TVEFOREFSRCA/PyBcIlwifWAsXG4gICAgICAgICAgICAgIF1cbiAgICAgICAgICAgIDogW10pLFxuICAgICAgICAgIGAtRFdPUktCRU5DSF9DT01QSUxFUl9GQU1JTFk9JHtjb21waWxlcn1gLFxuICAgICAgICAgIGAtRFdPUktCRU5DSF9DT01QSUxFUl9NSU5JTVVNPSR7Y29tcGlsZXIgPT09IHNlbGVjdGVkQ29tcGlsZXIgPyAocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NPTVBJTEVSX01JTklNVU0gPz8gXCJcIikgOiBcIlwifWAsXG4gICAgICAgICAgLi4uKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiAmJiBvcHRpb25zLmluY2x1ZGVzKFwiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiKVxuICAgICAgICAgICAgPyBbXCItRENNQUtFX0JVSUxEX1RZUEU9UmVsV2l0aERlYkluZm9cIl1cbiAgICAgICAgICAgIDogW10pLFxuICAgICAgICAgIC4uLm9wdGlvbnMsXG4gICAgICAgIF0pO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29sbGVjdENNYWtlRmFpbHVyZUxvZ3MoZGlyZWN0b3J5KTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgfVxuICAgIGFzeW5jIGZ1bmN0aW9uIHRlc3QoZGlyZWN0b3J5OiBzdHJpbmcsIHByb2ZpbGVzPzogc3RyaW5nKSB7XG4gICAgICBta2RpclN5bmMoXCJjb3ZlcmFnZVwiLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBqb2luKHJvb3QsIFwiY292ZXJhZ2VcIiwgYHRlc3RzLSR7ZGlyZWN0b3J5LnNsaWNlKGJ1aWxkcy5sZW5ndGggKyAxKS5yZXBsYWNlQWxsKHNlcCwgXCItXCIpfS54bWxgKTtcbiAgICAgIGF3YWl0IHJ1bihcImNtYWtlXCIsIFtcIi0tYnVpbGRcIiwgZGlyZWN0b3J5LCBcIi0tcGFyYWxsZWxcIiwgcGFyYWxsZWxpc21dKTtcbiAgICAgIGF3YWl0IHJ1bihcbiAgICAgICAgXCJjdGVzdFwiLFxuICAgICAgICBbXCItLXRlc3QtZGlyXCIsIGRpcmVjdG9yeSwgXCItLW91dHB1dC1vbi1mYWlsdXJlXCIsIFwiLS1uby10ZXN0cz1lcnJvclwiLCBcIi0tb3V0cHV0LWp1bml0XCIsIHJlc3VsdHNdLFxuICAgICAgICB7XG4gICAgICAgICAgZW52OiB7IC4uLnByb2Nlc3MuZW52LCAuLi4ocHJvZmlsZXMgPyB7IExMVk1fUFJPRklMRV9GSUxFOiBqb2luKHByb2ZpbGVzLCBcIiVwLSVtLnByb2ZyYXdcIikgfSA6IHt9KSB9LFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHJlcG9ydCA9IHJlYWRGaWxlU3luYyhyZXN1bHRzLCBcInV0ZjhcIik7XG4gICAgICBmb3IgKGNvbnN0IG1hdGNoIG9mIHJlcG9ydC5tYXRjaEFsbCgvPHRlc3RjYXNlXFxiKFtePl0rKT4vZykpIHtcbiAgICAgICAgYXNzZXJ0Lm9rKG1hdGNoWzFdLCBcIk1pc3NpbmcgdGVzdGNhc2UgYXR0cmlidXRlc1wiKTtcbiAgICAgICAgY29uc3QgbmFtZSA9IC9cXGJuYW1lPVwiKFteXCJdKylcIi8uZXhlYyhtYXRjaFsxXSk/LlsxXTtcbiAgICAgICAgY29uc3QgZWxhcHNlZCA9IE51bWJlcigvXFxidGltZT1cIihbXlwiXSspXCIvLmV4ZWMobWF0Y2hbMV0pPy5bMV0pO1xuICAgICAgICBpZiAocm9sZSAhPT0gXCJjb3ZlcmFnZVwiICYmIGVsYXBzZWQgPiBwb2xpY3kuc2xvd190ZXN0X3NlY29uZHMpIHtcbiAgICAgICAgICBlbWl0Q2hlY2tEZXRhaWwoe1xuICAgICAgICAgICAgdmVyc2lvbjogMSxcbiAgICAgICAgICAgIGtpbmQ6IFwic2xvd1wiLFxuICAgICAgICAgICAgc2NvcGU6IFwidGVzdFwiLFxuICAgICAgICAgICAgbmFtZTogU3RyaW5nKG5hbWUpLFxuICAgICAgICAgICAgZWxhcHNlZFNlY29uZHM6IGVsYXBzZWQsXG4gICAgICAgICAgICB0aHJlc2hvbGRTZWNvbmRzOiBwb2xpY3kuc2xvd190ZXN0X3NlY29uZHMsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICAgIGBTTE9XIHRlc3QgJHtTdHJpbmcobmFtZSl9OiAke1N0cmluZyhlbGFwc2VkKX1zIChzb2Z0IGNhcCAke1N0cmluZyhwb2xpY3kuc2xvd190ZXN0X3NlY29uZHMpfXM7IGFkdmlzb3J5IG9ubHkpYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gdmVyaWZ5UmVsZWFzZShkaXJlY3Rvcnk6IHN0cmluZykge1xuICAgICAgYXdhaXQgdGVzdChkaXJlY3RvcnkpO1xuICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKHJvb3QsIFwic2NyaXB0cy9yZWxlYXNlLXZlcmlmeS5tanNcIiksIGRpcmVjdG9yeV0pO1xuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIHJlamVjdEx0byhuYW1lOiBzdHJpbmcsIG9wdGlvbnM6IHN0cmluZ1tdLCBkaWFnbm9zdGljOiBSZWdFeHApIHtcbiAgICAgIC8vIFJldXNlIHRoZSB2ZXJpZmllZCBvZmYtbW9kZSBkZXBlbmRlbmN5IGluc3RhbGxhdGlvbiwgd2l0aG91dCByZWluc3RhbGxpbmcgZGVwZW5kZW5jaWVzLlxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgam9iLmNvbW1hbmQoXG4gICAgICAgIFwiY21ha2VcIixcbiAgICAgICAgW1xuICAgICAgICAgIFwiLVNcIixcbiAgICAgICAgICBcIi5cIixcbiAgICAgICAgICBcIi1CXCIsXG4gICAgICAgICAgam9pbihidWlsZHMsIGBsdG8tcmVqZWN0LSR7bmFtZX1gKSxcbiAgICAgICAgICBcIi1HXCIsXG4gICAgICAgICAgXCJOaW5qYVwiLFxuICAgICAgICAgIC4uLihtYW5hZ2VkXG4gICAgICAgICAgICA/IGNvbXBpbGVyQXJndW1lbnRzKClcbiAgICAgICAgICAgIDogW1xuICAgICAgICAgICAgICAgIGAtRENNQUtFX1RPT0xDSEFJTl9GSUxFPSR7am9pbihidWlsZHMsIFwibHRvLW9mZlwiLCBcIndvcmtiZW5jaC12Y3BrZy5jbWFrZVwiKX1gLFxuICAgICAgICAgICAgICAgIFwiLURWQ1BLR19NQU5JRkVTVF9JTlNUQUxMPU9GRlwiLFxuICAgICAgICAgICAgICBdKSxcbiAgICAgICAgICBcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxlYXNlXCIsXG4gICAgICAgICAgXCItRFdPUktCRU5DSF9MVE89ZnVsbFwiLFxuICAgICAgICAgIC4uLm9wdGlvbnMsXG4gICAgICAgIF0sXG4gICAgICAgIHsgY2FwdHVyZTogdHJ1ZSwgY3dkOiByb290IH0sXG4gICAgICApO1xuICAgICAgY29uc3Qgb3V0cHV0ID0gYCR7cmVzdWx0LnN0ZG91dH0ke3Jlc3VsdC5zdGRlcnJ9YDtcbiAgICAgIGlmIChyZXN1bHQuZXJyb3IgfHwgcmVzdWx0LnN0YXR1cyA9PT0gbnVsbCB8fCByZXN1bHQuc3RhdHVzID09PSAwIHx8ICFkaWFnbm9zdGljLnRlc3Qob3V0cHV0KSlcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFeHBlY3RlZCBMVE8gcmVqZWN0aW9uIGZvciAke25hbWV9OiAke3Jlc3VsdC5lcnJvciA/PyBvdXRwdXR9YCk7XG4gICAgICBjb25zb2xlLmxvZyhgVmVyaWZpZWQgTFRPIHJlamVjdGlvbjogJHtuYW1lfWApO1xuICAgIH1cblxuICAgIGlmIChyb2xlID09PSBcImZvcm1hdFwiIHx8IHJvbGUgPT09IFwiZm9ybWF0LXdyaXRlXCIpIHtcbiAgICAgIGF3YWl0IHJ1bihcImNsYW5nLWZvcm1hdFwiLCBbLi4uKHJvbGUgPT09IFwiZm9ybWF0XCIgPyBbXCItLWRyeS1ydW5cIiwgXCItLVdlcnJvclwiXSA6IFtcIi1pXCJdKSwgLi4uc291cmNlc10pO1xuICAgIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJsaW50XCIpIHtcbiAgICAgIGF3YWl0IHJ1bihcImNsYW5nLXRpZHlcIiwgW1wiLS12ZXJpZnktY29uZmlnXCJdKTtcbiAgICAgIGNvbnN0IGFuYWx5c2lzID0gc2VsZWN0ZWRDb21waWxlciA9PT0gXCJjbGFuZ1wiID8gZGVidWcgOiBqb2luKGJ1aWxkcywgXCJhbmFseXNpcy1jbGFuZ1wiKTtcbiAgICAgIGF3YWl0IGNvbmZpZ3VyZShhbmFseXNpcywgW10sIFwiY2xhbmdcIik7XG4gICAgICBhd2FpdCBydW4oXCJjbWFrZVwiLCBbXCItLWJ1aWxkXCIsIGFuYWx5c2lzLCBcIi0tcGFyYWxsZWxcIiwgcGFyYWxsZWxpc21dKTtcbiAgICAgIGZvciAoY29uc3Qgc291cmNlIG9mIHNvdXJjZXMuZmlsdGVyKChmaWxlKSA9PiAvXFwuKD86Y3xjcHApJC8udGVzdChmaWxlKSkpXG4gICAgICAgIGF3YWl0IHJ1bihcImNsYW5nLXRpZHlcIiwgW1wiLXBcIiwgYW5hbHlzaXMsIHNvdXJjZV0pO1xuICAgICAgaWYgKChzZWxlY3RlZENvbXBpbGVyID09PSBcImdjY1wiICYmIGxhbmd1YWdlID09PSBcImNcIikgfHwgc2VsZWN0ZWRDb21waWxlciA9PT0gXCJtdnNjXCIpIHtcbiAgICAgICAgY29uc3QgYWRkaXRpb25hbCA9IGpvaW4oYnVpbGRzLCBgYW5hbHlzaXMtJHtzZWxlY3RlZENvbXBpbGVyfWApO1xuICAgICAgICBhd2FpdCBjb25maWd1cmUoYWRkaXRpb25hbCwgW1wiLURXT1JLQkVOQ0hfU1RBVElDX0FOQUxZU0lTPU9OXCJdKTtcbiAgICAgICAgYXdhaXQgcnVuKFwiY21ha2VcIiwgW1wiLS1idWlsZFwiLCBhZGRpdGlvbmFsLCBcIi0tcGFyYWxsZWxcIiwgcGFyYWxsZWxpc21dKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHJvbGUgPT09IFwicGdvXCIpIHtcbiAgICAgIGNvbnN0IHJlamVjdGlvbiA9IGpvaW4oam9iLmRpcmVjdG9yeSwgXCJvcHRpbWl6YXRpb24tY29udHJhY3RcIik7XG4gICAgICBta2RpclN5bmMocmVqZWN0aW9uKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvcHlGaWxlU3luYyhqb2luKHJvb3QsIFwiY21ha2UvV29ya2JlbmNoT3B0aW1pemF0aW9uLmNtYWtlXCIpLCBqb2luKHJlamVjdGlvbiwgXCJvcHRpbWl6YXRpb24uY21ha2VcIikpO1xuICAgICAgICBjb25zdCBjbWFrZUxhbmd1YWdlID0gbGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJDXCIgOiBcIkNYWFwiO1xuICAgICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICAgIGpvaW4ocmVqZWN0aW9uLCBcIkNNYWtlTGlzdHMudHh0XCIpLFxuICAgICAgICAgIGBjbWFrZV9taW5pbXVtX3JlcXVpcmVkKFZFUlNJT04gMy4yNSlcXG5wcm9qZWN0KE9wdGltaXphdGlvbiBMQU5HVUFHRVMgJHtjbWFrZUxhbmd1YWdlfSlcXG5pbmNsdWRlKG9wdGltaXphdGlvbi5jbWFrZSlcXG53b3JrYmVuY2hfb3B0aW1pemF0aW9uKCR7Y21ha2VMYW5ndWFnZX0pXFxuYCxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgY2FzZXM6IFtzdHJpbmcsIHN0cmluZ1tdLCBSZWdFeHBdW10gPSBbXG4gICAgICAgICAgW1wiaW52YWxpZC1tb2RlXCIsIFtcIi1EV09SS0JFTkNIX1BHTz1pbnZhbGlkXCJdLCAvbXVzdCBzZWxlY3Qgb2ZmLCBnZW5lcmF0ZSwgb3IgdXNlL10sXG4gICAgICAgICAgW1wibWlzc2luZy1wcm9maWxlXCIsIFtcIi1EV09SS0JFTkNIX1BHTz11c2VcIl0sIC9QR08gcHJvZmlsZXM/ICg/OmlzfGFyZSkgbWlzc2luZy9dLFxuICAgICAgICAgIFtcIm1peGVkLWNvdmVyYWdlXCIsIFtcIi1EV09SS0JFTkNIX1BHTz1nZW5lcmF0ZVwiLCBcIi1EV09SS0JFTkNIX0NPVkVSQUdFPU9OXCJdLCAvd2l0aG91dCBjb3ZlcmFnZSBvciBzYW5pdGl6ZXJzL10sXG4gICAgICAgIF07XG4gICAgICAgIGZvciAoY29uc3QgW25hbWUsIGZsYWdzLCBtZXNzYWdlXSBvZiBjYXNlcykge1xuICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGpvYi5jb21tYW5kKFxuICAgICAgICAgICAgXCJjbWFrZVwiLFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICBcIi1TXCIsXG4gICAgICAgICAgICAgIHJlamVjdGlvbixcbiAgICAgICAgICAgICAgXCItQlwiLFxuICAgICAgICAgICAgICBqb2luKHJlamVjdGlvbiwgbmFtZSksXG4gICAgICAgICAgICAgIFwiLUdcIixcbiAgICAgICAgICAgICAgXCJOaW5qYVwiLFxuICAgICAgICAgICAgICAuLi5jb21waWxlckFyZ3VtZW50cygpLFxuICAgICAgICAgICAgICBcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxlYXNlXCIsXG4gICAgICAgICAgICAgIGAtRFdPUktCRU5DSF9QR09fRElSRUNUT1JZPSR7am9pbihyZWplY3Rpb24sIFwicHJvZmlsZXNcIil9YCxcbiAgICAgICAgICAgICAgLi4uZmxhZ3MsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgeyBjYXB0dXJlOiB0cnVlLCBjd2Q6IHJvb3QgfSxcbiAgICAgICAgICApO1xuICAgICAgICAgIGFzc2VydC5vayhcbiAgICAgICAgICAgICFyZXN1bHQuZXJyb3IgJiZcbiAgICAgICAgICAgICAgcmVzdWx0LnN0YXR1cyAhPT0gbnVsbCAmJlxuICAgICAgICAgICAgICByZXN1bHQuc3RhdHVzICE9PSAwICYmXG4gICAgICAgICAgICAgIG1lc3NhZ2UudGVzdChyZXN1bHQuc3Rkb3V0ICsgcmVzdWx0LnN0ZGVyciksXG4gICAgICAgICAgICBgUEdPICR7bmFtZX0gbXVzdCBmYWlsIHdpdGggYSB1c2VmdWwgZGlhZ25vc3RpYzogJHtTdHJpbmcocmVzdWx0LmVycm9yID8/IHJlc3VsdC5zdGRvdXQgKyByZXN1bHQuc3RkZXJyKX1gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIHJtU3luYyhyZWplY3Rpb24sIHsgZm9yY2U6IHRydWUsIHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgeyBuYXRpdmVQR08gfSA9IGF3YWl0IGltcG9ydChcIi4vbmF0aXZlLXBnby5tanNcIik7XG4gICAgICBhd2FpdCBuYXRpdmVQR08oe1xuICAgICAgICBidWlsZHMsXG4gICAgICAgIGxhbmd1YWdlLFxuICAgICAgICBjb21waWxlcjogc2VsZWN0ZWRDb21waWxlcixcbiAgICAgICAgY29uZmlndXJlLFxuICAgICAgICB0ZXN0LFxuICAgICAgICB2ZXJpZnk6IHZlcmlmeVJlbGVhc2UsXG4gICAgICAgIHJ1bixcbiAgICAgICAgam9iLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIGlmIChyb2xlID09PSBcImhhcmRlbmluZ1wiKSB7XG4gICAgICBjb25zdCBkaXJlY3RvcnkgPSBqb2luKGJ1aWxkcywgXCJoYXJkZW5lZFwiKTtcbiAgICAgIGF3YWl0IGNvbmZpZ3VyZShkaXJlY3RvcnksIFtcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxlYXNlXCIsIFwiLURXT1JLQkVOQ0hfSEFSREVOSU5HPU9OXCJdKTtcbiAgICAgIGF3YWl0IHZlcmlmeVJlbGVhc2UoZGlyZWN0b3J5KTtcbiAgICAgIGNvbnN0IHsgaW5zcGVjdEhhcmRlbmluZyB9ID0gYXdhaXQgaW1wb3J0KFwiLi9leGVjdXRhYmxlLWhhcmRlbmluZy5tanNcIik7XG4gICAgICBjb25zb2xlLmxvZyhKU09OLnN0cmluZ2lmeShpbnNwZWN0SGFyZGVuaW5nKHJlYWRGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgYGNvdW50JHtzdWZmaXh9YCkpKSkpO1xuICAgIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJidWlsZFwiIHx8IHJvbGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICBjb25zdCBkaXJlY3RvcnkgPSByb2xlID09PSBcInJlbGVhc2VcIiA/IGpvaW4oYnVpbGRzLCBcInJlbGVhc2VcIikgOiBkZWJ1ZztcbiAgICAgIGF3YWl0IGNvbmZpZ3VyZShcbiAgICAgICAgZGlyZWN0b3J5LFxuICAgICAgICByb2xlID09PSBcInJlbGVhc2VcIlxuICAgICAgICAgID8gW1wiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIiwgYC1EV09SS0JFTkNIX0xUTz0ke3Byb2Nlc3MuZW52LldPUktCRU5DSF9MVE8gPz8gXCJvZmZcIn1gXVxuICAgICAgICAgIDogW10sXG4gICAgICApO1xuICAgICAgaWYgKHJvbGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICAgIGF3YWl0IHZlcmlmeVJlbGVhc2UoZGlyZWN0b3J5KTtcbiAgICAgICAgY29uc3Qgb3V0cHV0ID0gcmVzb2x2ZShwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUkVMRUFTRV9PVVRQVVQgPz8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0RJU1RfRElSID8/IFwiZGlzdFwiKTtcbiAgICAgICAgbWtkaXJTeW5jKG91dHB1dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgIGNvcHlGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgYGNvdW50JHtzdWZmaXh9YCksIGpvaW4ob3V0cHV0LCBgY291bnQke3N1ZmZpeH1gKSk7XG4gICAgICAgIGNvcHlGaWxlU3luYyhcIkxJQ0VOU0VcIiwgam9pbihvdXRwdXQsIFwiTElDRU5TRVwiKSk7XG4gICAgICB9IGVsc2UgYXdhaXQgcnVuKFwiY21ha2VcIiwgW1wiLS1idWlsZFwiLCBkaXJlY3RvcnksIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICAgIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJsdG9cIikge1xuICAgICAgZm9yIChjb25zdCBtb2RlIG9mIHNlbGVjdGVkQ29tcGlsZXIgPT09IFwiY2xhbmdcIiA/IFtcIm9mZlwiLCBcInRoaW5cIiwgXCJmdWxsXCJdIDogW1wib2ZmXCIsIFwiZnVsbFwiXSkge1xuICAgICAgICBjb25zdCBkaXJlY3RvcnkgPSBqb2luKGJ1aWxkcywgYGx0by0ke21vZGV9YCk7XG4gICAgICAgIGF3YWl0IGNvbmZpZ3VyZShkaXJlY3RvcnksIFtcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxlYXNlXCIsIGAtRFdPUktCRU5DSF9MVE89JHttb2RlfWBdKTtcbiAgICAgICAgYXdhaXQgdmVyaWZ5UmVsZWFzZShkaXJlY3RvcnkpO1xuICAgICAgfVxuICAgICAgYXdhaXQgcmVqZWN0THRvKFwiaW52YWxpZFwiLCBbXCItRFdPUktCRU5DSF9MVE89dW5rbm93blwiXSwgL211c3Qgc2VsZWN0IG9mZiwgdGhpbiwgb3IgZnVsbC8pO1xuICAgICAgYXdhaXQgcmVqZWN0THRvKFwiZGVidWdcIiwgW1wiLURDTUFLRV9CVUlMRF9UWVBFPURlYnVnXCJdLCAvc2VwYXJhdGUgb3B0aW1pemVkIHNpbmdsZS1jb25maWd1cmF0aW9uIGJ1aWxkLyk7XG4gICAgICBhd2FpdCByZWplY3RMdG8oXCJjb3ZlcmFnZVwiLCBbXCItRFdPUktCRU5DSF9DT1ZFUkFHRT1PTlwiXSwgL3NlcGFyYXRlIExUTyBidWlsZCBmcm9tIGNvdmVyYWdlIGFuZCBzYW5pdGl6ZXJzLyk7XG4gICAgICBhd2FpdCByZWplY3RMdG8oXCJzYW5pdGl6ZXJzXCIsIFtcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIl0sIC9zZXBhcmF0ZSBMVE8gYnVpbGQgZnJvbSBjb3ZlcmFnZSBhbmQgc2FuaXRpemVycy8pO1xuICAgICAgaWYgKHNlbGVjdGVkQ29tcGlsZXIgIT09IFwiY2xhbmdcIilcbiAgICAgICAgYXdhaXQgcmVqZWN0THRvKFwidGhpblwiLCBbXCItRFdPUktCRU5DSF9MVE89dGhpblwiXSwgL2RvZXMgbm90IHN1cHBvcnQgdGhlIHJlcXVlc3RlZCBMVE8gbW9kZS8pO1xuICAgICAgZWxzZSBhd2FpdCByZWplY3RMdG8oXCJ0b29sLXZlcnNpb25cIiwgW2AtRGx0b19saW5rZXI9JHtwcm9jZXNzLmV4ZWNQYXRofWBdLCAvbXVzdCBtYXRjaCBDbGFuZy8pO1xuICAgIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJ0ZXN0XCIpIHtcbiAgICAgIGF3YWl0IGNvbmZpZ3VyZShkZWJ1Zyk7XG4gICAgICBhd2FpdCB0ZXN0KGRlYnVnKTtcbiAgICB9IGVsc2UgaWYgKHJvbGUgPT09IFwiY292ZXJhZ2VcIikge1xuICAgICAgY29uc3QgeyBuYXRpdmVDb3ZlcmFnZVNvdXJjZXMsIGFzc2VydE5hdGl2ZUNvdmVyYWdlU2NvcGUgfSA9IGF3YWl0IGltcG9ydChcIi4vbmF0aXZlLWNvdmVyYWdlLm1qc1wiKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKFwiY292ZXJhZ2VcIikgJiYgbHN0YXRTeW5jKFwiY292ZXJhZ2VcIikuaXNTeW1ib2xpY0xpbmsoKSlcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiY292ZXJhZ2UgbXVzdCBiZSBhIHJlYWwgZGlyZWN0b3J5XCIpO1xuICAgICAgbWtkaXJTeW5jKFwiY292ZXJhZ2VcIiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBmb3IgKGNvbnN0IG5hbWUgb2YgcmVhZGRpclN5bmMoXCJjb3ZlcmFnZVwiKSlcbiAgICAgICAgaWYgKG5hbWUgIT09IFwiY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpIHJtU3luYyhqb2luKFwiY292ZXJhZ2VcIiwgbmFtZSksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIGlmIChzZWxlY3RlZENvbXBpbGVyICE9PSBcImNsYW5nXCIpIHtcbiAgICAgICAgYXdhaXQgY29uZmlndXJlKGRlYnVnKTtcbiAgICAgICAgYXdhaXQgdGVzdChkZWJ1Zyk7XG4gICAgICB9XG4gICAgICBjb25zdCBpbnN0cnVtZW50ZWQgPSBqb2luKGJ1aWxkcywgXCJjb3ZlcmFnZVwiKTtcbiAgICAgIGF3YWl0IGNvbmZpZ3VyZShpbnN0cnVtZW50ZWQsIFtcIi1EV09SS0JFTkNIX0NPVkVSQUdFPU9OXCJdLCBcImNsYW5nXCIpO1xuICAgICAgY29uc3QgdGVtcG9yYXJ5ID0gbWtkdGVtcFN5bmMoam9pbihpbnN0cnVtZW50ZWQsIFwicHJvZmlsZXMtXCIpKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRlc3QoaW5zdHJ1bWVudGVkLCB0ZW1wb3JhcnkpO1xuICAgICAgICBjb25zdCBwcm9maWxlcyA9IGZpbGVzKHRlbXBvcmFyeSkuZmlsdGVyKChmaWxlOiBzdHJpbmcpID0+IGZpbGUuZW5kc1dpdGgoXCIucHJvZnJhd1wiKSk7XG4gICAgICAgIGlmICghcHJvZmlsZXMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJjb3ZlcmFnZSBwcm9kdWNlZCBubyBleGVjdXRpb24gcHJvZmlsZXNcIik7XG4gICAgICAgIGNvbnN0IG1lcmdlZCA9IGpvaW4odGVtcG9yYXJ5LCBcIm1lcmdlZC5wcm9mZGF0YVwiKTtcbiAgICAgICAgYXdhaXQgcnVuKFwibGx2bS1wcm9mZGF0YVwiLCBbXCJtZXJnZVwiLCBcIi1zcGFyc2VcIiwgLi4ucHJvZmlsZXMsIFwiLW9cIiwgbWVyZ2VkXSk7XG4gICAgICAgIGNvbnN0IHNvdXJjZUZpbGVzID0gbmF0aXZlQ292ZXJhZ2VTb3VyY2VzKHNvdXJjZXMuZmlsdGVyKChmaWxlKSA9PiAhZmlsZS5zdGFydHNXaXRoKGB0ZXN0cyR7c2VwfWApKSk7XG4gICAgICAgIGNvbnN0IGNvdmVyYWdlQXJncyA9IFtcbiAgICAgICAgICBqb2luKGluc3RydW1lbnRlZCwgYGNvdW50X3Rlc3Qke3N1ZmZpeH1gKSxcbiAgICAgICAgICBcIi1vYmplY3RcIixcbiAgICAgICAgICBqb2luKGluc3RydW1lbnRlZCwgYGNvdW50JHtzdWZmaXh9YCksXG4gICAgICAgICAgXCItb2JqZWN0XCIsXG4gICAgICAgICAgam9pbihpbnN0cnVtZW50ZWQsIGBjcHVfdGVzdCR7c3VmZml4fWApLFxuICAgICAgICAgIGAtaW5zdHItcHJvZmlsZT0ke21lcmdlZH1gLFxuICAgICAgICAgIC4uLnNvdXJjZUZpbGVzLFxuICAgICAgICBdO1xuICAgICAgICBhd2FpdCBydW4oXCJsbHZtLWNvdlwiLCBbXCJyZXBvcnRcIiwgLi4uY292ZXJhZ2VBcmdzXSk7XG4gICAgICAgIGNvbnN0IHJlcG9ydCA9IEpTT04ucGFyc2UoYXdhaXQgcnVuKFwibGx2bS1jb3ZcIiwgW1wiZXhwb3J0XCIsIC4uLmNvdmVyYWdlQXJnc10sIHsgc3RkaW86IFwicGlwZVwiIH0pKSBhcyB7XG4gICAgICAgICAgZGF0YTogeyBmaWxlczogeyBmaWxlbmFtZTogc3RyaW5nIH1bXTsgdG90YWxzOiBSZWNvcmQ8c3RyaW5nLCB7IGNvdW50OiBudW1iZXI7IHBlcmNlbnQ6IG51bWJlciB9PiB9W107XG4gICAgICAgIH07XG4gICAgICAgIHdyaXRlRmlsZVN5bmMoXCJjb3ZlcmFnZS9yZXBvcnQuanNvblwiLCBKU09OLnN0cmluZ2lmeShyZXBvcnQpKTtcbiAgICAgICAgYXNzZXJ0Lm9rKHJlcG9ydC5kYXRhWzBdLCBcIkxMVk0gY292ZXJhZ2UgZGlkIG5vdCByZXBvcnQgdG90YWxzXCIpO1xuICAgICAgICBhc3NlcnROYXRpdmVDb3ZlcmFnZVNjb3BlKFxuICAgICAgICAgIHJlcG9ydC5kYXRhWzBdLmZpbGVzLm1hcCgoZmlsZSkgPT4gZmlsZS5maWxlbmFtZSksXG4gICAgICAgICAgc291cmNlRmlsZXMsXG4gICAgICAgICk7XG4gICAgICAgIGNvbnN0IHRvdGFsID0gcmVwb3J0LmRhdGFbMF0udG90YWxzO1xuICAgICAgICBmb3IgKGNvbnN0IFttZXRyaWMsIG1pbmltdW1dIG9mIE9iamVjdC5lbnRyaWVzKHBvbGljeS5jb3ZlcmFnZSkpIHtcbiAgICAgICAgICBpZiAoIXRvdGFsW21ldHJpY10gfHwgdG90YWxbbWV0cmljXS5jb3VudCA9PT0gMCB8fCB0b3RhbFttZXRyaWNdLnBlcmNlbnQgPCBtaW5pbXVtKVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICBgJHttZXRyaWN9IGNvdmVyYWdlICR7U3RyaW5nKHRvdGFsW21ldHJpY10/LnBlcmNlbnQgPz8gXCJtaXNzaW5nXCIpfSUgaXMgYmVsb3cgJHtTdHJpbmcobWluaW11bSl9JWAsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBybVN5bmModGVtcG9yYXJ5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChyb2xlID09PSBcInNhbml0aXplcnNcIikge1xuICAgICAgYXdhaXQgY29uZmlndXJlKGpvaW4oYnVpbGRzLCBcImFcIiksIFtcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIl0pO1xuICAgICAgYXdhaXQgdGVzdChqb2luKGJ1aWxkcywgXCJhXCIpKTtcbiAgICAgIGF3YWl0IGNvbmZpZ3VyZShqb2luKGJ1aWxkcywgXCJwXCIpLCBbXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCIsIFwiLURXT1JLQkVOQ0hfUE9SVEFCTEVfT05MWT1PTlwiXSk7XG4gICAgICBhd2FpdCB0ZXN0KGpvaW4oYnVpbGRzLCBcInBcIikpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJleHBlY3RlZCBidWlsZCwgcmVsZWFzZSwgZm9ybWF0LCBmb3JtYXQtd3JpdGUsIGxpbnQsIHRlc3QsIGNvdmVyYWdlLCBzYW5pdGl6ZXJzLCBvciBsdG9cIik7XG4gICAgfVxuICB9KTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sWUFBWTtBQUNuQixTQUFTLDBCQUEwRDtBQUVuRTtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxNQUFNLFVBQVUsU0FBUyxXQUFXO0FBQzdDLFNBQVMscUJBQXFCO0FBRTlCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxPQUVLO0FBRVAsZUFBc0IsZ0JBQWdCLFVBQXVCLGNBQXNCLE1BQTZCO0FBQzlHLFFBQU0sT0FBTyxhQUFhLE9BQU8sUUFBUSxJQUFJLENBQUM7QUFDOUMsUUFBTSxFQUFFLFVBQVUsSUFBSyxNQUFNLE9BQzNCLGNBQWMsS0FBSyxjQUFjLDhDQUE4QyxDQUFDLEVBQUU7QUFHcEYsUUFBTSxFQUFFLGdCQUFnQixJQUFLLE1BQU0sT0FDakMsY0FBYyxLQUFLLGNBQWMscURBQXFELENBQUMsRUFBRTtBQUUzRixRQUFNLG1CQUFtQixRQUFRLElBQUk7QUFDckMsTUFBSSxDQUFDLGlCQUFrQixPQUFNLElBQUksTUFBTSx3RUFBd0U7QUFDL0csUUFBTSxTQUFTO0FBQ2YsUUFBTSxRQUFRLEtBQUssUUFBUSxPQUFPO0FBQ2xDLFFBQU0sU0FBUyxLQUFLLE1BQU0sYUFBYSwwQkFBMEIsTUFBTSxDQUFDO0FBSXhFLFFBQU0sU0FBUyxRQUFRLGFBQWEsVUFBVSxTQUFTO0FBQ3ZELFFBQU0sb0JBQW9CLFFBQVEsSUFBSSxz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LFFBQVEsR0FBRyxFQUFFLENBQUMsQ0FBQztBQUNuRyxjQUFNLGVBQWU7QUFBQSxVQUNuQixLQUFLLGNBQWMsYUFBYSxNQUFNLEVBQUU7QUFBQSxVQUN4QztBQUFBLFVBQ0EsS0FBSyxjQUFjLFFBQVEsTUFBTSxFQUFFO0FBQUEsVUFDbkM7QUFBQSxVQUNBLEtBQUssY0FBYyxXQUFXLE1BQU0sRUFBRTtBQUFBLFVBQ3RDLGtCQUFrQixNQUFNO0FBQUEsVUFDeEIsR0FBRztBQUFBLFFBQ0w7QUFDQSxjQUFNLElBQUksWUFBWSxDQUFDLFVBQVUsR0FBRyxZQUFZLENBQUM7QUFDakQsY0FBTSxTQUFTLEtBQUssTUFBTSxNQUFNLElBQUksWUFBWSxDQUFDLFVBQVUsR0FBRyxZQUFZLEdBQUcsRUFBRSxPQUFPLE9BQU8sQ0FBQyxDQUFDO0FBRy9GLHNCQUFjLHdCQUF3QixLQUFLLFVBQVUsTUFBTSxDQUFDO0FBQzVELGVBQU8sR0FBRyxPQUFPLEtBQUssQ0FBQyxHQUFHLHFDQUFxQztBQUMvRDtBQUFBLFVBQ0UsT0FBTyxLQUFLLENBQUMsRUFBRSxNQUFNLElBQUksQ0FBQyxTQUFTLEtBQUssUUFBUTtBQUFBLFVBQ2hEO0FBQUEsUUFDRjtBQUNBLGNBQU0sUUFBUSxPQUFPLEtBQUssQ0FBQyxFQUFFO0FBQzdCLG1CQUFXLENBQUMsUUFBUSxPQUFPLEtBQUssT0FBTyxRQUFRLE9BQU8sUUFBUSxHQUFHO0FBQy9ELGNBQUksQ0FBQyxNQUFNLE1BQU0sS0FBSyxNQUFNLE1BQU0sRUFBRSxVQUFVLEtBQUssTUFBTSxNQUFNLEVBQUUsVUFBVTtBQUN6RSxrQkFBTSxJQUFJO0FBQUEsY0FDUixHQUFHLE1BQU0sYUFBYSxPQUFPLE1BQU0sTUFBTSxHQUFHLFdBQVcsU0FBUyxDQUFDLGNBQWMsT0FBTyxPQUFPLENBQUM7QUFBQSxZQUNoRztBQUFBLFFBQ0o7QUFBQSxNQUNGLFVBQUU7QUFDQSxlQUFPLFdBQVcsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxNQUNwRDtBQUFBLElBQ0YsV0FBVyxTQUFTLGNBQWM7QUFDaEMsWUFBTSxVQUFVLEtBQUssUUFBUSxHQUFHLEdBQUcsQ0FBQywyQkFBMkIsQ0FBQztBQUNoRSxZQUFNLEtBQUssS0FBSyxRQUFRLEdBQUcsQ0FBQztBQUM1QixZQUFNLFVBQVUsS0FBSyxRQUFRLEdBQUcsR0FBRyxDQUFDLDZCQUE2Qiw4QkFBOEIsQ0FBQztBQUNoRyxZQUFNLEtBQUssS0FBSyxRQUFRLEdBQUcsQ0FBQztBQUFBLElBQzlCLE9BQU87QUFDTCxZQUFNLElBQUksTUFBTSx5RkFBeUY7QUFBQSxJQUMzRztBQUFBLEVBQ0YsQ0FBQztBQUNIOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvbmF0aXZlLWMtY2hlY2tzLm1qcyJ9
