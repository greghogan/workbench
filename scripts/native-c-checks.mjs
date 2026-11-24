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
    if (role === "acquire") {
      await configure(join(builds, "dependency-preparation"));
    } else if (role === "format" || role === "format-write") {
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
    } else if (role === "build" || role === "docs" || role === "release") {
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
      } else {
        await run("cmake", ["--build", directory, "--parallel", parallelism]);
        if (role === "docs")
          await run(process.execPath, [join(distribution, "bin/workbench.mjs"), "docs", "README.md"]);
      }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5hdGl2ZS1jLWNoZWNrcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyB3aXRoRW5naW5lZXJpbmdSdW4sIHR5cGUgRW5naW5lZXJpbmdDb21tYW5kT3B0aW9ucyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvYXJ0aWZhY3RzL2VuZ2luZWVyaW5nLXJ1bi5tanNcIjtcblxuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbHN0YXRTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIG1rZGlyU3luYyxcbiAgbWtkdGVtcFN5bmMsXG4gIHJtU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbiAgY29weUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuaW1wb3J0IHtcbiAgY29tcGlsZXJDYXRhbG9nLFxuICBpc0NvbXBpbGVyRmFtaWx5LFxuICB0eXBlIENvbXBpbGVyRmFtaWx5LFxufSBmcm9tIFwiLi4vYXBwL3NyYy9jb3JlL3Rvb2xjaGFpbnMvY29tcGlsZXItY2F0YWxvZy5tanNcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bk5hdGl2ZUNoZWNrcyhsYW5ndWFnZTogXCJjXCIgfCBcImNwcFwiLCBkaXN0cmlidXRpb246IHN0cmluZywgcm9sZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJvb3QgPSByZWFscGF0aFN5bmMubmF0aXZlKHByb2Nlc3MuY3dkKCkpO1xuICBjb25zdCB7IGNwdUJ1ZGdldCB9ID0gKGF3YWl0IGltcG9ydChcbiAgICBwYXRoVG9GaWxlVVJMKGpvaW4oZGlzdHJpYnV0aW9uLCBcImFwcC9zcmMvY29yZS9leGVjdXRpb24vY2hlY2tzL2NwdS1idWRnZXQubWpzXCIpKS5ocmVmXG4gICkpIGFzIHR5cGVvZiBpbXBvcnQoXCIuLi9hcHAvc3JjL2NvcmUvZXhlY3V0aW9uL2NoZWNrcy9jcHUtYnVkZ2V0Lm1qc1wiKTtcblxuICBjb25zdCB7IGVtaXRDaGVja0RldGFpbCB9ID0gKGF3YWl0IGltcG9ydChcbiAgICBwYXRoVG9GaWxlVVJMKGpvaW4oZGlzdHJpYnV0aW9uLCBcImFwcC9zcmMvY29yZS9leGVjdXRpb24vY2hlY2tzL2NoZWNrLWRldGFpbC1kYXRhLm1qc1wiKSkuaHJlZlxuICApKSBhcyB0eXBlb2YgaW1wb3J0KFwiLi4vYXBwL3NyYy9jb3JlL2V4ZWN1dGlvbi9jaGVja3MvY2hlY2stZGV0YWlsLWRhdGEubWpzXCIpO1xuICBjb25zdCBjb25maWd1cmVkQnVpbGRzID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0JVSUxEX0RJUjtcbiAgaWYgKCFjb25maWd1cmVkQnVpbGRzKSB0aHJvdyBuZXcgRXJyb3IoXCJ1c2UgV29ya2JlbmNoIGNoZWNrcyBvciBhIGNvbmZpZ3VyZWQgV29ya2JlbmNoIHNoZWxsIGZvciBuYXRpdmUgYnVpbGRzXCIpO1xuICBjb25zdCBidWlsZHMgPSBjb25maWd1cmVkQnVpbGRzO1xuICBjb25zdCBkZWJ1ZyA9IGpvaW4oYnVpbGRzLCBcImRlYnVnXCIpO1xuICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhcIndvcmtiZW5jaC9xdWFsaXR5Lmpzb25cIiwgXCJ1dGY4XCIpKSBhcyB7XG4gICAgc2xvd190ZXN0X3NlY29uZHM6IG51bWJlcjtcbiAgICBjb3ZlcmFnZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbiAgfTtcbiAgY29uc3Qgc3VmZml4ID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCIuZXhlXCIgOiBcIlwiO1xuICBjb25zdCByZXF1ZXN0ZWRDb21waWxlciA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9DT01QSUxFUiA/PyBcImNsYW5nXCI7XG4gIGlmICghaXNDb21waWxlckZhbWlseShyZXF1ZXN0ZWRDb21waWxlcikpIHRocm93IG5ldyBFcnJvcihcIlNlbGVjdCBhIGRlY2xhcmVkIG5hdGl2ZSBjb21waWxlclwiKTtcbiAgY29uc3Qgc2VsZWN0ZWRDb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSByZXF1ZXN0ZWRDb21waWxlcjtcbiAgaWYgKFxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiAmJlxuICAgIHNlbGVjdGVkQ29tcGlsZXIgPT09IFwibXZzY1wiICYmXG4gICAgcm9sZSAhPT0gXCJmb3JtYXRcIiAmJlxuICAgIHJvbGUgIT09IFwiZm9ybWF0LXdyaXRlXCIgJiZcbiAgICBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTkFUSVZFX1VURjhfQ09OU09MRSAhPT0gXCIxXCJcbiAgKSB7XG4gICAgY29uc3QgeyBydW5XaW5kb3dzVXRmOENvbnNvbGUgfSA9IGF3YWl0IGltcG9ydChcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL3dpbmRvd3MtdXRmOC1jb25zb2xlLm1qc1wiKTtcbiAgICBhd2FpdCBydW5XaW5kb3dzVXRmOENvbnNvbGUocHJvY2Vzcy5hcmd2LnNsaWNlKDEpLCBidWlsZHMpO1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCB3aXRoRW5naW5lZXJpbmdSdW4oYnVpbGRzLCBcIm5hdGl2ZS1jaGVja1wiLCBhc3luYyAoam9iKSA9PiB7XG4gICAgY29uc3QgbWFuYWdlZCA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0NPTVBJTEVSID09PSBcIjFcIjtcbiAgICBjb25zdCBwYXJhbGxlbGlzbSA9IFN0cmluZyhjcHVCdWRnZXQoKSk7XG4gICAgcHJvY2Vzcy5lbnYuQ1RFU1RfUEFSQUxMRUxfTEVWRUwgPSBwYXJhbGxlbGlzbTtcbiAgICBjb25zdCBydW4gPSAoXG4gICAgICBjb21tYW5kOiBzdHJpbmcsXG4gICAgICBhcmdzOiBzdHJpbmdbXSA9IFtdLFxuICAgICAgb3B0aW9uczogRW5naW5lZXJpbmdDb21tYW5kT3B0aW9ucyAmIHsgc3RkaW8/OiBcInBpcGVcIiB9ID0ge30sXG4gICAgKSA9PiB7XG4gICAgICBjb25zdCBwaXBlID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0pPQlNFUlZFUl9GSUZPO1xuICAgICAgaWYgKHBpcGUgJiYgY29tbWFuZCA9PT0gXCJjbWFrZVwiICYmIGFyZ3NbMF0gPT09IFwiLS1idWlsZFwiKSB7XG4gICAgICAgIGNvbnN0IGVudiA9IHsgLi4uKG9wdGlvbnMuZW52ID8/IHByb2Nlc3MuZW52KSB9O1xuICAgICAgICBlbnYuTUFLRUZMQUdTID0gYCR7ZW52Lk1BS0VGTEFHUyA/PyBcIlwifSAtaiAtLWpvYnNlcnZlci1hdXRoPWZpZm86JHtwaXBlfWAudHJpbSgpO1xuICAgICAgICBkZWxldGUgZW52LkNNQUtFX0JVSUxEX1BBUkFMTEVMX0xFVkVMO1xuICAgICAgICBjb25zdCBleHBsaWNpdCA9IGFyZ3MuaW5kZXhPZihcIi0tcGFyYWxsZWxcIik7XG4gICAgICAgIGlmIChleHBsaWNpdCAhPT0gLTEpIGFyZ3MgPSBbLi4uYXJncy5zbGljZSgwLCBleHBsaWNpdCksIC4uLmFyZ3Muc2xpY2UoZXhwbGljaXQgKyAyKV07XG4gICAgICAgIG9wdGlvbnMgPSB7IC4uLm9wdGlvbnMsIGVudiB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIGpvYi5ydW4oY29tbWFuZCwgYXJncywgeyBjd2Q6IHJvb3QsIC4uLm9wdGlvbnMsIGNhcHR1cmU6IG9wdGlvbnMuc3RkaW8gPT09IFwicGlwZVwiIH0pO1xuICAgIH07XG4gICAgZnVuY3Rpb24gY29sbGVjdENNYWtlRmFpbHVyZUxvZ3MoZGlyZWN0b3J5OiBzdHJpbmcpIHtcbiAgICAgIGNvbnN0IGJ1aWxkdHJlZXMgPSBqb2luKGRpcmVjdG9yeSwgXCJidFwiKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG91dHB1dCA9IGpvaW4ocm9vdCwgXCJjb3ZlcmFnZVwiLCBcImNtYWtlXCIsIHJlbGF0aXZlKGJ1aWxkcywgZGlyZWN0b3J5KS5yZXBsYWNlQWxsKHNlcCwgXCItXCIpKTtcbiAgICAgICAgY29uc3QgcG9ydExvZ3MgPSBleGlzdHNTeW5jKGJ1aWxkdHJlZXMpXG4gICAgICAgICAgPyBmaWxlcyhidWlsZHRyZWVzKS5maWx0ZXIoKHBhdGgpID0+IHBhdGguZW5kc1dpdGgoXCIubG9nXCIpICYmIGxzdGF0U3luYyhwYXRoKS5pc0ZpbGUoKSlcbiAgICAgICAgICA6IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHBhdGggb2YgcG9ydExvZ3MpIHtcbiAgICAgICAgICBjb25zdCBkZXN0aW5hdGlvbiA9IGpvaW4ob3V0cHV0LCBcInZjcGtnX2J1aWxkdHJlZXNcIiwgcmVsYXRpdmUoYnVpbGR0cmVlcywgcGF0aCkpO1xuICAgICAgICAgIG1rZGlyU3luYyhqb2luKGRlc3RpbmF0aW9uLCBcIi4uXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICBjb3B5RmlsZVN5bmMocGF0aCwgZGVzdGluYXRpb24pO1xuICAgICAgICAgIGlmICgvLShvdXR8ZXJyKVxcLmxvZyQvLnRlc3QocGF0aCkpXG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKGAke3BhdGh9XFxuJHtyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpLnNsaWNlKC04MTkyKS5zcGxpdCgvXFxyP1xcbi8pLnNsaWNlKC00MCkuam9pbihcIlxcblwiKX1gKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBDb21waWxlciBkZXRlY3Rpb24gY2FuIHN1Y2NlZWQgYmVmb3JlIGEgZGVwZW5kZW5jeSBmYWlscy4gUHJlc2VydmUgdGhlIG1hbmlmZXN0J3MgYWN0dWFsIGVycm9yLFxuICAgICAgICAvLyBhbmQgcHJpbnQgaXQgbGFzdCBzbyBib3VuZGVkIHRlcm1pbmFsIGV4Y2VycHRzIHJldGFpbiB0aGUgY2F1c2UgcmF0aGVyIHRoYW4gY29tcGlsZXIgd2FybmluZ3MuXG4gICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gam9pbihkaXJlY3RvcnksIFwidmNwa2ctbWFuaWZlc3QtaW5zdGFsbC5sb2dcIik7XG4gICAgICAgIGlmIChleGlzdHNTeW5jKG1hbmlmZXN0KSAmJiBsc3RhdFN5bmMobWFuaWZlc3QpLmlzRmlsZSgpKSB7XG4gICAgICAgICAgbWtkaXJTeW5jKG91dHB1dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgICAgY29weUZpbGVTeW5jKG1hbmlmZXN0LCBqb2luKG91dHB1dCwgXCJ2Y3BrZy1tYW5pZmVzdC1pbnN0YWxsLmxvZ1wiKSk7XG4gICAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICAgIC8vIGNvZGVxbFtqcy9maWxlLXN5c3RlbS1yYWNlXSBUaGlzIGlzIGEgcmVhZC1vbmx5IGRpYWdub3N0aWMgZnJvbSB0aGUgb3duZWQgYnVpbGQgZGlyZWN0b3J5OyB0aGUgY2hlY2sgZ3JhbnRzIG5vIHBlcm1pc3Npb24gdG8gbW9kaWZ5IGl0LlxuICAgICAgICAgICAgYCR7bWFuaWZlc3R9XFxuJHtyZWFkRmlsZVN5bmMobWFuaWZlc3QsIFwidXRmOFwiKS5zbGljZSgtODE5Mikuc3BsaXQoL1xccj9cXG4vKS5zbGljZSgtNDApLmpvaW4oXCJcXG5cIil9YCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwb3J0TG9ncy5sZW5ndGggfHwgZXhpc3RzU3luYyhtYW5pZmVzdCkpIGNvbnNvbGUuZXJyb3IoYENNYWtlIGZhaWx1cmUgbG9nczogJHtvdXRwdXR9YCk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKGBDb3VsZCBub3QgcmV0YWluIENNYWtlIGZhaWx1cmUgbG9nczogJHtTdHJpbmcoZXJyb3IpfWApO1xuICAgICAgfVxuICAgIH1cbiAgICBmdW5jdGlvbiBmaWxlcyhkaXJlY3Rvcnk6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICAgIHJldHVybiByZWFkZGlyU3luYyhkaXJlY3RvcnksIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KS5mbGF0TWFwKChlbnRyeSkgPT5cbiAgICAgICAgZW50cnkuaXNEaXJlY3RvcnkoKSA/IGZpbGVzKGpvaW4oZGlyZWN0b3J5LCBlbnRyeS5uYW1lKSkgOiBbam9pbihkaXJlY3RvcnksIGVudHJ5Lm5hbWUpXSxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHNvdXJjZXMgPSBbXCJzcmNcIiwgXCJpbmNsdWRlXCIsIFwidGVzdHNcIl0uZmxhdE1hcChmaWxlcykuZmlsdGVyKChmaWxlKSA9PiAvXFwuKD86Y3xjcHB8aHxocHApJC8udGVzdChmaWxlKSk7XG4gICAgZnVuY3Rpb24gY29tcGlsZXJBcmd1bWVudHMoY29tcGlsZXI6IENvbXBpbGVyRmFtaWx5ID0gc2VsZWN0ZWRDb21waWxlcikge1xuICAgICAgY29uc3QgZXhlY3V0YWJsZSA9XG4gICAgICAgIGNvbXBpbGVyID09PSBzZWxlY3RlZENvbXBpbGVyID8gcHJvY2Vzcy5lbnZbbGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJXT1JLQkVOQ0hfQ0NcIiA6IFwiV09SS0JFTkNIX0NYWFwiXSA6IHVuZGVmaW5lZDtcbiAgICAgIHJldHVybiBbXG4gICAgICAgIGAtRENNQUtFXyR7bGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJDXCIgOiBcIkNYWFwifV9DT01QSUxFUj0ke2V4ZWN1dGFibGUgPz8gY29tcGlsZXJDYXRhbG9nW2NvbXBpbGVyXS5leGVjdXRhYmxlc1tsYW5ndWFnZV19YCxcbiAgICAgIF07XG4gICAgfVxuICAgIGFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZShkaXJlY3Rvcnk6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10gPSBbXSwgY29tcGlsZXI6IENvbXBpbGVyRmFtaWx5ID0gc2VsZWN0ZWRDb21waWxlcikge1xuICAgICAgaWYgKCFtYW5hZ2VkKSB7XG4gICAgICAgIGF3YWl0IHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbXG4gICAgICAgICAgam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgICAgXCJ2Y3BrZy1wcmVwYXJlXCIsXG4gICAgICAgICAgcm9vdCxcbiAgICAgICAgICBkaXJlY3RvcnksXG4gICAgICAgICAgXCItLWNvbXBpbGVyXCIsXG4gICAgICAgICAgY29tcGlsZXIsXG4gICAgICAgICAgLi4uKG9wdGlvbnMuaW5jbHVkZXMoXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCIpID8gW1wiLS1zYW5pdGl6ZXJzXCJdIDogW10pLFxuICAgICAgICBdKTtcbiAgICAgICAgcHJvY2Vzcy5lbnYuVkNQS0dfRElTQUJMRV9NRVRSSUNTID0gXCIxXCI7XG4gICAgICAgIHByb2Nlc3MuZW52LlZDUEtHX0ZPUkNFX1NZU1RFTV9CSU5BUklFUyA9IFwiMVwiO1xuICAgICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuVkNQS0dfRk9SQ0VfRE9XTkxPQURFRF9CSU5BUklFUztcbiAgICAgICAgcHJvY2Vzcy5lbnYuVkNQS0dfTUFYX0NPTkNVUlJFTkNZID0gcGFyYWxsZWxpc207XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBydW4oXCJjbWFrZVwiLCBbXG4gICAgICAgICAgXCItU1wiLFxuICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgXCItQlwiLFxuICAgICAgICAgIGRpcmVjdG9yeSxcbiAgICAgICAgICBcIi1HXCIsXG4gICAgICAgICAgXCJOaW5qYVwiLFxuICAgICAgICAgIFwiLURDTUFLRV9CVUlMRF9UWVBFPURlYnVnXCIsXG4gICAgICAgICAgXCItRFdPUktCRU5DSF9MVE89b2ZmXCIsXG4gICAgICAgICAgXCItRFdPUktCRU5DSF9DT1ZFUkFHRT1PRkZcIixcbiAgICAgICAgICBcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T0ZGXCIsXG4gICAgICAgICAgXCItRFdPUktCRU5DSF9QT1JUQUJMRV9PTkxZPU9GRlwiLFxuICAgICAgICAgIFwiLURXT1JLQkVOQ0hfUEdPPW9mZlwiLFxuICAgICAgICAgIFwiLURXT1JLQkVOQ0hfU1RBVElDX0FOQUxZU0lTPU9GRlwiLFxuICAgICAgICAgIFwiLURXT1JLQkVOQ0hfSEFSREVOSU5HPU9GRlwiLFxuICAgICAgICAgIC4uLihtYW5hZ2VkXG4gICAgICAgICAgICA/IGNvbXBpbGVyQXJndW1lbnRzKGNvbXBpbGVyKVxuICAgICAgICAgICAgOiBbYC1EQ01BS0VfVE9PTENIQUlOX0ZJTEU9JHtqb2luKGRpcmVjdG9yeSwgXCJ3b3JrYmVuY2gtdmNwa2cuY21ha2VcIil9YF0pLFxuICAgICAgICAgIC4uLigocHJvY2Vzcy5lbnZbbGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJXT1JLQkVOQ0hfQ19TVEFOREFSRFwiIDogXCJXT1JLQkVOQ0hfQ1hYX1NUQU5EQVJEXCJdID8/XG4gICAgICAgICAgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEKVxuICAgICAgICAgICAgPyBbXG4gICAgICAgICAgICAgICAgYC1EV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEPSR7cHJvY2Vzcy5lbnZbbGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJXT1JLQkVOQ0hfQ19TVEFOREFSRFwiIDogXCJXT1JLQkVOQ0hfQ1hYX1NUQU5EQVJEXCJdID8/IHByb2Nlc3MuZW52LldPUktCRU5DSF9MQU5HVUFHRV9TVEFOREFSRCA/PyBcIlwifWAsXG4gICAgICAgICAgICAgIF1cbiAgICAgICAgICAgIDogW10pLFxuICAgICAgICAgIGAtRFdPUktCRU5DSF9DT01QSUxFUl9GQU1JTFk9JHtjb21waWxlcn1gLFxuICAgICAgICAgIGAtRFdPUktCRU5DSF9DT01QSUxFUl9NSU5JTVVNPSR7Y29tcGlsZXIgPT09IHNlbGVjdGVkQ29tcGlsZXIgPyAocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NPTVBJTEVSX01JTklNVU0gPz8gXCJcIikgOiBcIlwifWAsXG4gICAgICAgICAgLi4uKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiAmJiBvcHRpb25zLmluY2x1ZGVzKFwiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiKVxuICAgICAgICAgICAgPyBbXCItRENNQUtFX0JVSUxEX1RZUEU9UmVsV2l0aERlYkluZm9cIl1cbiAgICAgICAgICAgIDogW10pLFxuICAgICAgICAgIC4uLm9wdGlvbnMsXG4gICAgICAgIF0pO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29sbGVjdENNYWtlRmFpbHVyZUxvZ3MoZGlyZWN0b3J5KTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgfVxuICAgIGFzeW5jIGZ1bmN0aW9uIHRlc3QoZGlyZWN0b3J5OiBzdHJpbmcsIHByb2ZpbGVzPzogc3RyaW5nKSB7XG4gICAgICBta2RpclN5bmMoXCJjb3ZlcmFnZVwiLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBqb2luKHJvb3QsIFwiY292ZXJhZ2VcIiwgYHRlc3RzLSR7ZGlyZWN0b3J5LnNsaWNlKGJ1aWxkcy5sZW5ndGggKyAxKS5yZXBsYWNlQWxsKHNlcCwgXCItXCIpfS54bWxgKTtcbiAgICAgIGF3YWl0IHJ1bihcImNtYWtlXCIsIFtcIi0tYnVpbGRcIiwgZGlyZWN0b3J5LCBcIi0tcGFyYWxsZWxcIiwgcGFyYWxsZWxpc21dKTtcbiAgICAgIGF3YWl0IHJ1bihcbiAgICAgICAgXCJjdGVzdFwiLFxuICAgICAgICBbXCItLXRlc3QtZGlyXCIsIGRpcmVjdG9yeSwgXCItLW91dHB1dC1vbi1mYWlsdXJlXCIsIFwiLS1uby10ZXN0cz1lcnJvclwiLCBcIi0tb3V0cHV0LWp1bml0XCIsIHJlc3VsdHNdLFxuICAgICAgICB7XG4gICAgICAgICAgZW52OiB7IC4uLnByb2Nlc3MuZW52LCAuLi4ocHJvZmlsZXMgPyB7IExMVk1fUFJPRklMRV9GSUxFOiBqb2luKHByb2ZpbGVzLCBcIiVwLSVtLnByb2ZyYXdcIikgfSA6IHt9KSB9LFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHJlcG9ydCA9IHJlYWRGaWxlU3luYyhyZXN1bHRzLCBcInV0ZjhcIik7XG4gICAgICBmb3IgKGNvbnN0IG1hdGNoIG9mIHJlcG9ydC5tYXRjaEFsbCgvPHRlc3RjYXNlXFxiKFtePl0rKT4vZykpIHtcbiAgICAgICAgYXNzZXJ0Lm9rKG1hdGNoWzFdLCBcIk1pc3NpbmcgdGVzdGNhc2UgYXR0cmlidXRlc1wiKTtcbiAgICAgICAgY29uc3QgbmFtZSA9IC9cXGJuYW1lPVwiKFteXCJdKylcIi8uZXhlYyhtYXRjaFsxXSk/LlsxXTtcbiAgICAgICAgY29uc3QgZWxhcHNlZCA9IE51bWJlcigvXFxidGltZT1cIihbXlwiXSspXCIvLmV4ZWMobWF0Y2hbMV0pPy5bMV0pO1xuICAgICAgICBpZiAocm9sZSAhPT0gXCJjb3ZlcmFnZVwiICYmIGVsYXBzZWQgPiBwb2xpY3kuc2xvd190ZXN0X3NlY29uZHMpIHtcbiAgICAgICAgICBlbWl0Q2hlY2tEZXRhaWwoe1xuICAgICAgICAgICAgdmVyc2lvbjogMSxcbiAgICAgICAgICAgIGtpbmQ6IFwic2xvd1wiLFxuICAgICAgICAgICAgc2NvcGU6IFwidGVzdFwiLFxuICAgICAgICAgICAgbmFtZTogU3RyaW5nKG5hbWUpLFxuICAgICAgICAgICAgZWxhcHNlZFNlY29uZHM6IGVsYXBzZWQsXG4gICAgICAgICAgICB0aHJlc2hvbGRTZWNvbmRzOiBwb2xpY3kuc2xvd190ZXN0X3NlY29uZHMsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICAgIGBTTE9XIHRlc3QgJHtTdHJpbmcobmFtZSl9OiAke1N0cmluZyhlbGFwc2VkKX1zIChzb2Z0IGNhcCAke1N0cmluZyhwb2xpY3kuc2xvd190ZXN0X3NlY29uZHMpfXM7IGFkdmlzb3J5IG9ubHkpYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gdmVyaWZ5UmVsZWFzZShkaXJlY3Rvcnk6IHN0cmluZykge1xuICAgICAgYXdhaXQgdGVzdChkaXJlY3RvcnkpO1xuICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKHJvb3QsIFwic2NyaXB0cy9yZWxlYXNlLXZlcmlmeS5tanNcIiksIGRpcmVjdG9yeV0pO1xuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIHJlamVjdEx0byhuYW1lOiBzdHJpbmcsIG9wdGlvbnM6IHN0cmluZ1tdLCBkaWFnbm9zdGljOiBSZWdFeHApIHtcbiAgICAgIC8vIFJldXNlIHRoZSB2ZXJpZmllZCBvZmYtbW9kZSBkZXBlbmRlbmN5IGluc3RhbGxhdGlvbiwgd2l0aG91dCByZWluc3RhbGxpbmcgZGVwZW5kZW5jaWVzLlxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgam9iLmNvbW1hbmQoXG4gICAgICAgIFwiY21ha2VcIixcbiAgICAgICAgW1xuICAgICAgICAgIFwiLVNcIixcbiAgICAgICAgICBcIi5cIixcbiAgICAgICAgICBcIi1CXCIsXG4gICAgICAgICAgam9pbihidWlsZHMsIGBsdG8tcmVqZWN0LSR7bmFtZX1gKSxcbiAgICAgICAgICBcIi1HXCIsXG4gICAgICAgICAgXCJOaW5qYVwiLFxuICAgICAgICAgIC4uLihtYW5hZ2VkXG4gICAgICAgICAgICA/IGNvbXBpbGVyQXJndW1lbnRzKClcbiAgICAgICAgICAgIDogW1xuICAgICAgICAgICAgICAgIGAtRENNQUtFX1RPT0xDSEFJTl9GSUxFPSR7am9pbihidWlsZHMsIFwibHRvLW9mZlwiLCBcIndvcmtiZW5jaC12Y3BrZy5jbWFrZVwiKX1gLFxuICAgICAgICAgICAgICAgIFwiLURWQ1BLR19NQU5JRkVTVF9JTlNUQUxMPU9GRlwiLFxuICAgICAgICAgICAgICBdKSxcbiAgICAgICAgICBcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxlYXNlXCIsXG4gICAgICAgICAgXCItRFdPUktCRU5DSF9MVE89ZnVsbFwiLFxuICAgICAgICAgIC4uLm9wdGlvbnMsXG4gICAgICAgIF0sXG4gICAgICAgIHsgY2FwdHVyZTogdHJ1ZSwgY3dkOiByb290IH0sXG4gICAgICApO1xuICAgICAgY29uc3Qgb3V0cHV0ID0gYCR7cmVzdWx0LnN0ZG91dH0ke3Jlc3VsdC5zdGRlcnJ9YDtcbiAgICAgIGlmIChyZXN1bHQuZXJyb3IgfHwgcmVzdWx0LnN0YXR1cyA9PT0gbnVsbCB8fCByZXN1bHQuc3RhdHVzID09PSAwIHx8ICFkaWFnbm9zdGljLnRlc3Qob3V0cHV0KSlcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFeHBlY3RlZCBMVE8gcmVqZWN0aW9uIGZvciAke25hbWV9OiAke3Jlc3VsdC5lcnJvciA/PyBvdXRwdXR9YCk7XG4gICAgICBjb25zb2xlLmxvZyhgVmVyaWZpZWQgTFRPIHJlamVjdGlvbjogJHtuYW1lfWApO1xuICAgIH1cblxuICAgIGlmIChyb2xlID09PSBcImFjcXVpcmVcIikge1xuICAgICAgYXdhaXQgY29uZmlndXJlKGpvaW4oYnVpbGRzLCBcImRlcGVuZGVuY3ktcHJlcGFyYXRpb25cIikpO1xuICAgIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJmb3JtYXRcIiB8fCByb2xlID09PSBcImZvcm1hdC13cml0ZVwiKSB7XG4gICAgICBhd2FpdCBydW4oXCJjbGFuZy1mb3JtYXRcIiwgWy4uLihyb2xlID09PSBcImZvcm1hdFwiID8gW1wiLS1kcnktcnVuXCIsIFwiLS1XZXJyb3JcIl0gOiBbXCItaVwiXSksIC4uLnNvdXJjZXNdKTtcbiAgICB9IGVsc2UgaWYgKHJvbGUgPT09IFwibGludFwiKSB7XG4gICAgICBhd2FpdCBydW4oXCJjbGFuZy10aWR5XCIsIFtcIi0tdmVyaWZ5LWNvbmZpZ1wiXSk7XG4gICAgICBjb25zdCBhbmFseXNpcyA9IHNlbGVjdGVkQ29tcGlsZXIgPT09IFwiY2xhbmdcIiA/IGRlYnVnIDogam9pbihidWlsZHMsIFwiYW5hbHlzaXMtY2xhbmdcIik7XG4gICAgICBhd2FpdCBjb25maWd1cmUoYW5hbHlzaXMsIFtdLCBcImNsYW5nXCIpO1xuICAgICAgYXdhaXQgcnVuKFwiY21ha2VcIiwgW1wiLS1idWlsZFwiLCBhbmFseXNpcywgXCItLXBhcmFsbGVsXCIsIHBhcmFsbGVsaXNtXSk7XG4gICAgICBmb3IgKGNvbnN0IHNvdXJjZSBvZiBzb3VyY2VzLmZpbHRlcigoZmlsZSkgPT4gL1xcLig/OmN8Y3BwKSQvLnRlc3QoZmlsZSkpKVxuICAgICAgICBhd2FpdCBydW4oXCJjbGFuZy10aWR5XCIsIFtcIi1wXCIsIGFuYWx5c2lzLCBzb3VyY2VdKTtcbiAgICAgIGlmICgoc2VsZWN0ZWRDb21waWxlciA9PT0gXCJnY2NcIiAmJiBsYW5ndWFnZSA9PT0gXCJjXCIpIHx8IHNlbGVjdGVkQ29tcGlsZXIgPT09IFwibXZzY1wiKSB7XG4gICAgICAgIGNvbnN0IGFkZGl0aW9uYWwgPSBqb2luKGJ1aWxkcywgYGFuYWx5c2lzLSR7c2VsZWN0ZWRDb21waWxlcn1gKTtcbiAgICAgICAgYXdhaXQgY29uZmlndXJlKGFkZGl0aW9uYWwsIFtcIi1EV09SS0JFTkNIX1NUQVRJQ19BTkFMWVNJUz1PTlwiXSk7XG4gICAgICAgIGF3YWl0IHJ1bihcImNtYWtlXCIsIFtcIi0tYnVpbGRcIiwgYWRkaXRpb25hbCwgXCItLXBhcmFsbGVsXCIsIHBhcmFsbGVsaXNtXSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChyb2xlID09PSBcInBnb1wiKSB7XG4gICAgICBjb25zdCByZWplY3Rpb24gPSBqb2luKGpvYi5kaXJlY3RvcnksIFwib3B0aW1pemF0aW9uLWNvbnRyYWN0XCIpO1xuICAgICAgbWtkaXJTeW5jKHJlamVjdGlvbik7XG4gICAgICB0cnkge1xuICAgICAgICBjb3B5RmlsZVN5bmMoam9pbihyb290LCBcImNtYWtlL1dvcmtiZW5jaE9wdGltaXphdGlvbi5jbWFrZVwiKSwgam9pbihyZWplY3Rpb24sIFwib3B0aW1pemF0aW9uLmNtYWtlXCIpKTtcbiAgICAgICAgY29uc3QgY21ha2VMYW5ndWFnZSA9IGxhbmd1YWdlID09PSBcImNcIiA/IFwiQ1wiIDogXCJDWFhcIjtcbiAgICAgICAgd3JpdGVGaWxlU3luYyhcbiAgICAgICAgICBqb2luKHJlamVjdGlvbiwgXCJDTWFrZUxpc3RzLnR4dFwiKSxcbiAgICAgICAgICBgY21ha2VfbWluaW11bV9yZXF1aXJlZChWRVJTSU9OIDMuMjUpXFxucHJvamVjdChPcHRpbWl6YXRpb24gTEFOR1VBR0VTICR7Y21ha2VMYW5ndWFnZX0pXFxuaW5jbHVkZShvcHRpbWl6YXRpb24uY21ha2UpXFxud29ya2JlbmNoX29wdGltaXphdGlvbigke2NtYWtlTGFuZ3VhZ2V9KVxcbmAsXG4gICAgICAgICk7XG4gICAgICAgIGNvbnN0IGNhc2VzOiBbc3RyaW5nLCBzdHJpbmdbXSwgUmVnRXhwXVtdID0gW1xuICAgICAgICAgIFtcImludmFsaWQtbW9kZVwiLCBbXCItRFdPUktCRU5DSF9QR089aW52YWxpZFwiXSwgL211c3Qgc2VsZWN0IG9mZiwgZ2VuZXJhdGUsIG9yIHVzZS9dLFxuICAgICAgICAgIFtcIm1pc3NpbmctcHJvZmlsZVwiLCBbXCItRFdPUktCRU5DSF9QR089dXNlXCJdLCAvUEdPIHByb2ZpbGVzPyAoPzppc3xhcmUpIG1pc3NpbmcvXSxcbiAgICAgICAgICBbXCJtaXhlZC1jb3ZlcmFnZVwiLCBbXCItRFdPUktCRU5DSF9QR089Z2VuZXJhdGVcIiwgXCItRFdPUktCRU5DSF9DT1ZFUkFHRT1PTlwiXSwgL3dpdGhvdXQgY292ZXJhZ2Ugb3Igc2FuaXRpemVycy9dLFxuICAgICAgICBdO1xuICAgICAgICBmb3IgKGNvbnN0IFtuYW1lLCBmbGFncywgbWVzc2FnZV0gb2YgY2FzZXMpIHtcbiAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBqb2IuY29tbWFuZChcbiAgICAgICAgICAgIFwiY21ha2VcIixcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgXCItU1wiLFxuICAgICAgICAgICAgICByZWplY3Rpb24sXG4gICAgICAgICAgICAgIFwiLUJcIixcbiAgICAgICAgICAgICAgam9pbihyZWplY3Rpb24sIG5hbWUpLFxuICAgICAgICAgICAgICBcIi1HXCIsXG4gICAgICAgICAgICAgIFwiTmluamFcIixcbiAgICAgICAgICAgICAgLi4uY29tcGlsZXJBcmd1bWVudHMoKSxcbiAgICAgICAgICAgICAgXCItRENNQUtFX0JVSUxEX1RZUEU9UmVsZWFzZVwiLFxuICAgICAgICAgICAgICBgLURXT1JLQkVOQ0hfUEdPX0RJUkVDVE9SWT0ke2pvaW4ocmVqZWN0aW9uLCBcInByb2ZpbGVzXCIpfWAsXG4gICAgICAgICAgICAgIC4uLmZsYWdzLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIHsgY2FwdHVyZTogdHJ1ZSwgY3dkOiByb290IH0sXG4gICAgICAgICAgKTtcbiAgICAgICAgICBhc3NlcnQub2soXG4gICAgICAgICAgICAhcmVzdWx0LmVycm9yICYmXG4gICAgICAgICAgICAgIHJlc3VsdC5zdGF0dXMgIT09IG51bGwgJiZcbiAgICAgICAgICAgICAgcmVzdWx0LnN0YXR1cyAhPT0gMCAmJlxuICAgICAgICAgICAgICBtZXNzYWdlLnRlc3QocmVzdWx0LnN0ZG91dCArIHJlc3VsdC5zdGRlcnIpLFxuICAgICAgICAgICAgYFBHTyAke25hbWV9IG11c3QgZmFpbCB3aXRoIGEgdXNlZnVsIGRpYWdub3N0aWM6ICR7U3RyaW5nKHJlc3VsdC5lcnJvciA/PyByZXN1bHQuc3Rkb3V0ICsgcmVzdWx0LnN0ZGVycil9YCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBybVN5bmMocmVqZWN0aW9uLCB7IGZvcmNlOiB0cnVlLCByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHsgbmF0aXZlUEdPIH0gPSBhd2FpdCBpbXBvcnQoXCIuL25hdGl2ZS1wZ28ubWpzXCIpO1xuICAgICAgYXdhaXQgbmF0aXZlUEdPKHtcbiAgICAgICAgYnVpbGRzLFxuICAgICAgICBsYW5ndWFnZSxcbiAgICAgICAgY29tcGlsZXI6IHNlbGVjdGVkQ29tcGlsZXIsXG4gICAgICAgIGNvbmZpZ3VyZSxcbiAgICAgICAgdGVzdCxcbiAgICAgICAgdmVyaWZ5OiB2ZXJpZnlSZWxlYXNlLFxuICAgICAgICBydW4sXG4gICAgICAgIGpvYixcbiAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJoYXJkZW5pbmdcIikge1xuICAgICAgY29uc3QgZGlyZWN0b3J5ID0gam9pbihidWlsZHMsIFwiaGFyZGVuZWRcIik7XG4gICAgICBhd2FpdCBjb25maWd1cmUoZGlyZWN0b3J5LCBbXCItRENNQUtFX0JVSUxEX1RZUEU9UmVsZWFzZVwiLCBcIi1EV09SS0JFTkNIX0hBUkRFTklORz1PTlwiXSk7XG4gICAgICBhd2FpdCB2ZXJpZnlSZWxlYXNlKGRpcmVjdG9yeSk7XG4gICAgICBjb25zdCB7IGluc3BlY3RIYXJkZW5pbmcgfSA9IGF3YWl0IGltcG9ydChcIi4vZXhlY3V0YWJsZS1oYXJkZW5pbmcubWpzXCIpO1xuICAgICAgY29uc29sZS5sb2coSlNPTi5zdHJpbmdpZnkoaW5zcGVjdEhhcmRlbmluZyhyZWFkRmlsZVN5bmMoam9pbihkaXJlY3RvcnksIGBjb3VudCR7c3VmZml4fWApKSkpKTtcbiAgICB9IGVsc2UgaWYgKHJvbGUgPT09IFwiYnVpbGRcIiB8fCByb2xlID09PSBcImRvY3NcIiB8fCByb2xlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgY29uc3QgZGlyZWN0b3J5ID0gcm9sZSA9PT0gXCJyZWxlYXNlXCIgPyBqb2luKGJ1aWxkcywgXCJyZWxlYXNlXCIpIDogZGVidWc7XG4gICAgICBhd2FpdCBjb25maWd1cmUoXG4gICAgICAgIGRpcmVjdG9yeSxcbiAgICAgICAgcm9sZSA9PT0gXCJyZWxlYXNlXCJcbiAgICAgICAgICA/IFtcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxlYXNlXCIsIGAtRFdPUktCRU5DSF9MVE89JHtwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTFRPID8/IFwib2ZmXCJ9YF1cbiAgICAgICAgICA6IFtdLFxuICAgICAgKTtcbiAgICAgIGlmIChyb2xlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgICBhd2FpdCB2ZXJpZnlSZWxlYXNlKGRpcmVjdG9yeSk7XG4gICAgICAgIGNvbnN0IG91dHB1dCA9IHJlc29sdmUocHJvY2Vzcy5lbnYuV09SS0JFTkNIX1JFTEVBU0VfT1VUUFVUID8/IHByb2Nlc3MuZW52LldPUktCRU5DSF9ESVNUX0RJUiA/PyBcImRpc3RcIik7XG4gICAgICAgIG1rZGlyU3luYyhvdXRwdXQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICBjb3B5RmlsZVN5bmMoam9pbihkaXJlY3RvcnksIGBjb3VudCR7c3VmZml4fWApLCBqb2luKG91dHB1dCwgYGNvdW50JHtzdWZmaXh9YCkpO1xuICAgICAgICBjb3B5RmlsZVN5bmMoXCJMSUNFTlNFXCIsIGpvaW4ob3V0cHV0LCBcIkxJQ0VOU0VcIikpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXdhaXQgcnVuKFwiY21ha2VcIiwgW1wiLS1idWlsZFwiLCBkaXJlY3RvcnksIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICAgICAgICBpZiAocm9sZSA9PT0gXCJkb2NzXCIpXG4gICAgICAgICAgYXdhaXQgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSwgXCJkb2NzXCIsIFwiUkVBRE1FLm1kXCJdKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHJvbGUgPT09IFwibHRvXCIpIHtcbiAgICAgIGZvciAoY29uc3QgbW9kZSBvZiBzZWxlY3RlZENvbXBpbGVyID09PSBcImNsYW5nXCIgPyBbXCJvZmZcIiwgXCJ0aGluXCIsIFwiZnVsbFwiXSA6IFtcIm9mZlwiLCBcImZ1bGxcIl0pIHtcbiAgICAgICAgY29uc3QgZGlyZWN0b3J5ID0gam9pbihidWlsZHMsIGBsdG8tJHttb2RlfWApO1xuICAgICAgICBhd2FpdCBjb25maWd1cmUoZGlyZWN0b3J5LCBbXCItRENNQUtFX0JVSUxEX1RZUEU9UmVsZWFzZVwiLCBgLURXT1JLQkVOQ0hfTFRPPSR7bW9kZX1gXSk7XG4gICAgICAgIGF3YWl0IHZlcmlmeVJlbGVhc2UoZGlyZWN0b3J5KTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHJlamVjdEx0byhcImludmFsaWRcIiwgW1wiLURXT1JLQkVOQ0hfTFRPPXVua25vd25cIl0sIC9tdXN0IHNlbGVjdCBvZmYsIHRoaW4sIG9yIGZ1bGwvKTtcbiAgICAgIGF3YWl0IHJlamVjdEx0byhcImRlYnVnXCIsIFtcIi1EQ01BS0VfQlVJTERfVFlQRT1EZWJ1Z1wiXSwgL3NlcGFyYXRlIG9wdGltaXplZCBzaW5nbGUtY29uZmlndXJhdGlvbiBidWlsZC8pO1xuICAgICAgYXdhaXQgcmVqZWN0THRvKFwiY292ZXJhZ2VcIiwgW1wiLURXT1JLQkVOQ0hfQ09WRVJBR0U9T05cIl0sIC9zZXBhcmF0ZSBMVE8gYnVpbGQgZnJvbSBjb3ZlcmFnZSBhbmQgc2FuaXRpemVycy8pO1xuICAgICAgYXdhaXQgcmVqZWN0THRvKFwic2FuaXRpemVyc1wiLCBbXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCJdLCAvc2VwYXJhdGUgTFRPIGJ1aWxkIGZyb20gY292ZXJhZ2UgYW5kIHNhbml0aXplcnMvKTtcbiAgICAgIGlmIChzZWxlY3RlZENvbXBpbGVyICE9PSBcImNsYW5nXCIpXG4gICAgICAgIGF3YWl0IHJlamVjdEx0byhcInRoaW5cIiwgW1wiLURXT1JLQkVOQ0hfTFRPPXRoaW5cIl0sIC9kb2VzIG5vdCBzdXBwb3J0IHRoZSByZXF1ZXN0ZWQgTFRPIG1vZGUvKTtcbiAgICAgIGVsc2UgYXdhaXQgcmVqZWN0THRvKFwidG9vbC12ZXJzaW9uXCIsIFtgLURsdG9fbGlua2VyPSR7cHJvY2Vzcy5leGVjUGF0aH1gXSwgL211c3QgbWF0Y2ggQ2xhbmcvKTtcbiAgICB9IGVsc2UgaWYgKHJvbGUgPT09IFwidGVzdFwiKSB7XG4gICAgICBhd2FpdCBjb25maWd1cmUoZGVidWcpO1xuICAgICAgYXdhaXQgdGVzdChkZWJ1Zyk7XG4gICAgfSBlbHNlIGlmIChyb2xlID09PSBcImNvdmVyYWdlXCIpIHtcbiAgICAgIGNvbnN0IHsgbmF0aXZlQ292ZXJhZ2VTb3VyY2VzLCBhc3NlcnROYXRpdmVDb3ZlcmFnZVNjb3BlIH0gPSBhd2FpdCBpbXBvcnQoXCIuL25hdGl2ZS1jb3ZlcmFnZS5tanNcIik7XG4gICAgICBpZiAoZXhpc3RzU3luYyhcImNvdmVyYWdlXCIpICYmIGxzdGF0U3luYyhcImNvdmVyYWdlXCIpLmlzU3ltYm9saWNMaW5rKCkpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIG11c3QgYmUgYSByZWFsIGRpcmVjdG9yeVwiKTtcbiAgICAgIG1rZGlyU3luYyhcImNvdmVyYWdlXCIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgZm9yIChjb25zdCBuYW1lIG9mIHJlYWRkaXJTeW5jKFwiY292ZXJhZ2VcIikpXG4gICAgICAgIGlmIChuYW1lICE9PSBcImNvdmVyYWdlLXN1bW1hcnkuanNvblwiKSBybVN5bmMoam9pbihcImNvdmVyYWdlXCIsIG5hbWUpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICBpZiAoc2VsZWN0ZWRDb21waWxlciAhPT0gXCJjbGFuZ1wiKSB7XG4gICAgICAgIGF3YWl0IGNvbmZpZ3VyZShkZWJ1Zyk7XG4gICAgICAgIGF3YWl0IHRlc3QoZGVidWcpO1xuICAgICAgfVxuICAgICAgY29uc3QgaW5zdHJ1bWVudGVkID0gam9pbihidWlsZHMsIFwiY292ZXJhZ2VcIik7XG4gICAgICBhd2FpdCBjb25maWd1cmUoaW5zdHJ1bWVudGVkLCBbXCItRFdPUktCRU5DSF9DT1ZFUkFHRT1PTlwiXSwgXCJjbGFuZ1wiKTtcbiAgICAgIGNvbnN0IHRlbXBvcmFyeSA9IG1rZHRlbXBTeW5jKGpvaW4oaW5zdHJ1bWVudGVkLCBcInByb2ZpbGVzLVwiKSk7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCB0ZXN0KGluc3RydW1lbnRlZCwgdGVtcG9yYXJ5KTtcbiAgICAgICAgY29uc3QgcHJvZmlsZXMgPSBmaWxlcyh0ZW1wb3JhcnkpLmZpbHRlcigoZmlsZTogc3RyaW5nKSA9PiBmaWxlLmVuZHNXaXRoKFwiLnByb2ZyYXdcIikpO1xuICAgICAgICBpZiAoIXByb2ZpbGVzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiY292ZXJhZ2UgcHJvZHVjZWQgbm8gZXhlY3V0aW9uIHByb2ZpbGVzXCIpO1xuICAgICAgICBjb25zdCBtZXJnZWQgPSBqb2luKHRlbXBvcmFyeSwgXCJtZXJnZWQucHJvZmRhdGFcIik7XG4gICAgICAgIGF3YWl0IHJ1bihcImxsdm0tcHJvZmRhdGFcIiwgW1wibWVyZ2VcIiwgXCItc3BhcnNlXCIsIC4uLnByb2ZpbGVzLCBcIi1vXCIsIG1lcmdlZF0pO1xuICAgICAgICBjb25zdCBzb3VyY2VGaWxlcyA9IG5hdGl2ZUNvdmVyYWdlU291cmNlcyhzb3VyY2VzLmZpbHRlcigoZmlsZSkgPT4gIWZpbGUuc3RhcnRzV2l0aChgdGVzdHMke3NlcH1gKSkpO1xuICAgICAgICBjb25zdCBjb3ZlcmFnZUFyZ3MgPSBbXG4gICAgICAgICAgam9pbihpbnN0cnVtZW50ZWQsIGBjb3VudF90ZXN0JHtzdWZmaXh9YCksXG4gICAgICAgICAgXCItb2JqZWN0XCIsXG4gICAgICAgICAgam9pbihpbnN0cnVtZW50ZWQsIGBjb3VudCR7c3VmZml4fWApLFxuICAgICAgICAgIFwiLW9iamVjdFwiLFxuICAgICAgICAgIGpvaW4oaW5zdHJ1bWVudGVkLCBgY3B1X3Rlc3Qke3N1ZmZpeH1gKSxcbiAgICAgICAgICBgLWluc3RyLXByb2ZpbGU9JHttZXJnZWR9YCxcbiAgICAgICAgICAuLi5zb3VyY2VGaWxlcyxcbiAgICAgICAgXTtcbiAgICAgICAgYXdhaXQgcnVuKFwibGx2bS1jb3ZcIiwgW1wicmVwb3J0XCIsIC4uLmNvdmVyYWdlQXJnc10pO1xuICAgICAgICBjb25zdCByZXBvcnQgPSBKU09OLnBhcnNlKGF3YWl0IHJ1bihcImxsdm0tY292XCIsIFtcImV4cG9ydFwiLCAuLi5jb3ZlcmFnZUFyZ3NdLCB7IHN0ZGlvOiBcInBpcGVcIiB9KSkgYXMge1xuICAgICAgICAgIGRhdGE6IHsgZmlsZXM6IHsgZmlsZW5hbWU6IHN0cmluZyB9W107IHRvdGFsczogUmVjb3JkPHN0cmluZywgeyBjb3VudDogbnVtYmVyOyBwZXJjZW50OiBudW1iZXIgfT4gfVtdO1xuICAgICAgICB9O1xuICAgICAgICB3cml0ZUZpbGVTeW5jKFwiY292ZXJhZ2UvcmVwb3J0Lmpzb25cIiwgSlNPTi5zdHJpbmdpZnkocmVwb3J0KSk7XG4gICAgICAgIGFzc2VydC5vayhyZXBvcnQuZGF0YVswXSwgXCJMTFZNIGNvdmVyYWdlIGRpZCBub3QgcmVwb3J0IHRvdGFsc1wiKTtcbiAgICAgICAgYXNzZXJ0TmF0aXZlQ292ZXJhZ2VTY29wZShcbiAgICAgICAgICByZXBvcnQuZGF0YVswXS5maWxlcy5tYXAoKGZpbGUpID0+IGZpbGUuZmlsZW5hbWUpLFxuICAgICAgICAgIHNvdXJjZUZpbGVzLFxuICAgICAgICApO1xuICAgICAgICBjb25zdCB0b3RhbCA9IHJlcG9ydC5kYXRhWzBdLnRvdGFscztcbiAgICAgICAgZm9yIChjb25zdCBbbWV0cmljLCBtaW5pbXVtXSBvZiBPYmplY3QuZW50cmllcyhwb2xpY3kuY292ZXJhZ2UpKSB7XG4gICAgICAgICAgaWYgKCF0b3RhbFttZXRyaWNdIHx8IHRvdGFsW21ldHJpY10uY291bnQgPT09IDAgfHwgdG90YWxbbWV0cmljXS5wZXJjZW50IDwgbWluaW11bSlcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgYCR7bWV0cmljfSBjb3ZlcmFnZSAke1N0cmluZyh0b3RhbFttZXRyaWNdPy5wZXJjZW50ID8/IFwibWlzc2luZ1wiKX0lIGlzIGJlbG93ICR7U3RyaW5nKG1pbmltdW0pfSVgLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgcm1TeW5jKHRlbXBvcmFyeSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJzYW5pdGl6ZXJzXCIpIHtcbiAgICAgIGF3YWl0IGNvbmZpZ3VyZShqb2luKGJ1aWxkcywgXCJhXCIpLCBbXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCJdKTtcbiAgICAgIGF3YWl0IHRlc3Qoam9pbihidWlsZHMsIFwiYVwiKSk7XG4gICAgICBhd2FpdCBjb25maWd1cmUoam9pbihidWlsZHMsIFwicFwiKSwgW1wiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiLCBcIi1EV09SS0JFTkNIX1BPUlRBQkxFX09OTFk9T05cIl0pO1xuICAgICAgYXdhaXQgdGVzdChqb2luKGJ1aWxkcywgXCJwXCIpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiZXhwZWN0ZWQgYnVpbGQsIHJlbGVhc2UsIGZvcm1hdCwgZm9ybWF0LXdyaXRlLCBsaW50LCB0ZXN0LCBjb3ZlcmFnZSwgc2FuaXRpemVycywgb3IgbHRvXCIpO1xuICAgIH1cbiAgfSk7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPLFlBQVk7QUFDbkIsU0FBUywwQkFBMEQ7QUFFbkU7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsTUFBTSxVQUFVLFNBQVMsV0FBVztBQUM3QyxTQUFTLHFCQUFxQjtBQUU5QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FFSztBQUVQLGVBQXNCLGdCQUFnQixVQUF1QixjQUFzQixNQUE2QjtBQUM5RyxRQUFNLE9BQU8sYUFBYSxPQUFPLFFBQVEsSUFBSSxDQUFDO0FBQzlDLFFBQU0sRUFBRSxVQUFVLElBQUssTUFBTSxPQUMzQixjQUFjLEtBQUssY0FBYyw4Q0FBOEMsQ0FBQyxFQUFFO0FBR3BGLFFBQU0sRUFB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
