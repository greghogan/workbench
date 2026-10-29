import assert from "node:assert/strict";
import { withEngineeringRun, type EngineeringCommandOptions } from "./engineering-run.mjs";

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
  copyFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { compilerCatalog, isCompilerFamily, type CompilerFamily } from "./compiler-catalog.mjs";

export async function runNativeChecks(language: "c" | "cpp", distribution: string, role: string): Promise<void> {
  const root = realpathSync.native(process.cwd());
  const { cpuBudget } = (await import(
    pathToFileURL(join(distribution, "scripts/cpu-budget.mjs")).href
  )) as typeof import("./cpu-budget.mjs");

  const { emitCheckDetail } = (await import(
    pathToFileURL(join(distribution, "scripts/check-detail-data.mjs")).href
  )) as typeof import("./check-detail-data.mjs");
  const configuredBuilds = process.env.WORKBENCH_BUILD_DIR;
  if (!configuredBuilds) throw new Error("use Workbench checks or a configured Workbench shell for native builds");
  const builds = configuredBuilds;
  const debug = join(builds, "debug");
  const policy = JSON.parse(readFileSync("workbench/quality.json", "utf8")) as {
    slow_test_seconds: number;
    coverage: Record<string, number>;
  };
  const suffix = process.platform === "win32" ? ".exe" : "";
  const requestedCompiler = process.env.WORKBENCH_COMPILER ?? "clang";
  if (!isCompilerFamily(requestedCompiler)) throw new Error("Select a declared native compiler");
  const selectedCompiler: CompilerFamily = requestedCompiler;
  if (
    process.platform === "win32" &&
    selectedCompiler === "mvsc" &&
    role !== "format" &&
    role !== "format-write" &&
    process.env.WORKBENCH_NATIVE_UTF8_CONSOLE !== "1"
  ) {
    const { runWindowsUtf8Console } = await import("./windows-utf8-console.mjs");
    await runWindowsUtf8Console(process.argv.slice(1), builds);
    return;
  }
  await withEngineeringRun(builds, "native-check", async (job) => {
    const managed = process.env.WORKBENCH_MANAGED_COMPILER === "1";
    const parallelism = String(cpuBudget());
    process.env.CTEST_PARALLEL_LEVEL = parallelism;
    const run = (command: string, args: string[] = [], options: EngineeringCommandOptions & { stdio?: "pipe" } = {}) =>
      job.run(command, args, { cwd: root, ...options, capture: options.stdio === "pipe" });
    function collectCMakeFailureLogs(directory: string) {
      const buildtrees = join(directory, "bt");
      try {
        const output = join(root, "coverage", "cmake", relative(builds, directory).replaceAll(sep, "-"));
        const portLogs = existsSync(buildtrees)
          ? files(buildtrees).filter((path) => path.endsWith(".log") && lstatSync(path).isFile())
          : [];
        for (const path of portLogs) {
          const destination = join(output, "vcpkg_buildtrees", relative(buildtrees, path));
          mkdirSync(join(destination, ".."), { recursive: true });
          copyFileSync(path, destination);
          if (/-(out|err)\.log$/.test(path))
            console.error(`${path}\n${readFileSync(path, "utf8").slice(-8192).split(/\r?\n/).slice(-40).join("\n")}`);
        }
        // Compiler detection can succeed before a dependency fails. Preserve the manifest's actual error,
        // and print it last so bounded terminal excerpts retain the cause rather than compiler warnings.
        const manifest = join(directory, "vcpkg-manifest-install.log");
        if (existsSync(manifest) && lstatSync(manifest).isFile()) {
          mkdirSync(output, { recursive: true });
          copyFileSync(manifest, join(output, "vcpkg-manifest-install.log"));
          console.error(
            // codeql[js/file-system-race] This is a read-only diagnostic from the owned build directory; the check grants no permission to modify it.
            `${manifest}\n${readFileSync(manifest, "utf8").slice(-8192).split(/\r?\n/).slice(-40).join("\n")}`,
          );
        }
        if (portLogs.length || existsSync(manifest)) console.error(`CMake failure logs: ${output}`);
      } catch (error) {
        console.error(`Could not retain CMake failure logs: ${String(error)}`);
      }
    }
    function files(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
      );
    }
    const sources = ["src", "include", "tests"].flatMap(files).filter((file) => /\.(?:c|cpp|h|hpp)$/.test(file));
    function compilerArguments(compiler: CompilerFamily = selectedCompiler) {
      const executable =
        compiler === selectedCompiler ? process.env[language === "c" ? "WORKBENCH_CC" : "WORKBENCH_CXX"] : undefined;
      return [
        `-DCMAKE_${language === "c" ? "C" : "CXX"}_COMPILER=${executable ?? compilerCatalog[compiler].executables[language]}`,
      ];
    }
    async function configure(directory: string, options: string[] = [], compiler: CompilerFamily = selectedCompiler) {
      if (!managed) {
        await run(process.execPath, [
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
          ...(managed
            ? compilerArguments(compiler)
            : [`-DCMAKE_TOOLCHAIN_FILE=${join(directory, "workbench-vcpkg.cmake")}`]),
          ...((process.env[language === "c" ? "WORKBENCH_C_STANDARD" : "WORKBENCH_CXX_STANDARD"] ??
          process.env.WORKBENCH_LANGUAGE_STANDARD)
            ? [
                `-DWORKBENCH_LANGUAGE_STANDARD=${process.env[language === "c" ? "WORKBENCH_C_STANDARD" : "WORKBENCH_CXX_STANDARD"] ?? process.env.WORKBENCH_LANGUAGE_STANDARD ?? ""}`,
              ]
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
    async function test(directory: string, profiles?: string) {
      mkdirSync("coverage", { recursive: true });
      const results = join(root, "coverage", `tests-${directory.slice(builds.length + 1).replaceAll(sep, "-")}.xml`);
      await run("cmake", ["--build", directory, "--parallel", parallelism]);
      await run(
        "ctest",
        ["--test-dir", directory, "--output-on-failure", "--no-tests=error", "--output-junit", results],
        {
          env: { ...process.env, ...(profiles ? { LLVM_PROFILE_FILE: join(profiles, "%p-%m.profraw") } : {}) },
        },
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
            thresholdSeconds: policy.slow_test_seconds,
          });
          console.error(
            `SLOW test ${String(name)}: ${String(elapsed)}s (soft cap ${String(policy.slow_test_seconds)}s; advisory only)`,
          );
        }
      }
    }

    async function verifyRelease(directory: string) {
      await test(directory);
      await run(process.execPath, [join(root, "scripts/release-verify.mjs"), directory]);
    }

    async function rejectLto(name: string, options: string[], diagnostic: RegExp) {
      // Reuse the verified off-mode dependency installation, without reinstalling dependencies.
      const result = await job.command(
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
        { capture: true, cwd: root },
      );
      const output = `${result.stdout}${result.stderr}`;
      if (result.error || result.status === null || result.status === 0 || !diagnostic.test(output))
        throw new Error(`Expected LTO rejection for ${name}: ${result.error ?? output}`);
      console.log(`Verified LTO rejection: ${name}`);
    }

    if (role === "format" || role === "format-write") {
      await run("clang-format", [...(role === "format" ? ["--dry-run", "--Werror"] : ["-i"]), ...sources]);
    } else if (role === "lint") {
      await run("clang-tidy", ["--verify-config"]);
      const analysis = selectedCompiler === "clang" ? debug : join(builds, "analysis-clang");
      await configure(analysis, [], "clang");
      await run("cmake", ["--build", analysis, "--parallel", parallelism]);
      for (const source of sources.filter((file) => /\.(?:c|cpp)$/.test(file)))
        await run("clang-tidy", ["-p", analysis, source]);
      if ((selectedCompiler === "gcc" && language === "c") || selectedCompiler === "mvsc") {
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
          `cmake_minimum_required(VERSION 3.25)\nproject(Optimization LANGUAGES ${cmakeLanguage})\ninclude(optimization.cmake)\nworkbench_optimization(${cmakeLanguage})\n`,
        );
        const cases: [string, string[], RegExp][] = [
          ["invalid-mode", ["-DWORKBENCH_PGO=invalid"], /must select off, generate, or use/],
          ["missing-profile", ["-DWORKBENCH_PGO=use"], /PGO profiles? (?:is|are) missing/],
          ["mixed-coverage", ["-DWORKBENCH_PGO=generate", "-DWORKBENCH_COVERAGE=ON"], /without coverage or sanitizers/],
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
              ...flags,
            ],
            { capture: true, cwd: root },
          );
          assert.ok(
            !result.error &&
              result.status !== null &&
              result.status !== 0 &&
              message.test(result.stdout + result.stderr),
            `PGO ${name} must fail with a useful diagnostic: ${String(result.error ?? result.stdout + result.stderr)}`,
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
        job,
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
        role === "release"
          ? ["-DCMAKE_BUILD_TYPE=Release", `-DWORKBENCH_LTO=${process.env.WORKBENCH_LTO ?? "off"}`]
          : [],
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
        const profiles = files(temporary).filter((file: string) => file.endsWith(".profraw"));
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
          ...sourceFiles,
        ];
        await run("llvm-cov", ["report", ...coverageArgs]);
        const report = JSON.parse(await run("llvm-cov", ["export", ...coverageArgs], { stdio: "pipe" })) as {
          data: { files: { filename: string }[]; totals: Record<string, { count: number; percent: number }> }[];
        };
        writeFileSync("coverage/report.json", JSON.stringify(report));
        assert.ok(report.data[0], "LLVM coverage did not report totals");
        assertNativeCoverageScope(
          report.data[0].files.map((file) => file.filename),
          sourceFiles,
        );
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
      await configure(join(builds, "a"), ["-DWORKBENCH_SANITIZERS=ON"]);
      await test(join(builds, "a"));
      await configure(join(builds, "p"), ["-DWORKBENCH_SANITIZERS=ON", "-DWORKBENCH_PORTABLE_ONLY=ON"]);
      await test(join(builds, "p"));
    } else {
      throw new Error("expected build, release, format, format-write, lint, test, coverage, sanitizers, or lto");
    }
  });
}
