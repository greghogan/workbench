// Generated from native-c-checks.mts; edit the TypeScript source.
import assert from "node:assert/strict";
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
  copyFileSync
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { compilerCatalog, isCompilerFamily } from "./compiler-catalog.mjs";
async function runNativeChecks(language, distribution, role) {
  const root = process.cwd();
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
      const sourceFiles = sources.filter((file) => !file.startsWith(`tests${sep}`));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5hdGl2ZS1jLWNoZWNrcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyB0eXBlIFNwYXduU3luY09wdGlvbnMsIHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbHN0YXRTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICBta2RpclN5bmMsXG4gIG1rZHRlbXBTeW5jLFxuICBybVN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG4gIGNvcHlGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5cbmltcG9ydCB7IGNvbXBpbGVyQ2F0YWxvZywgaXNDb21waWxlckZhbWlseSwgdHlwZSBDb21waWxlckZhbWlseSB9IGZyb20gXCIuL2NvbXBpbGVyLWNhdGFsb2cubWpzXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5OYXRpdmVDaGVja3MobGFuZ3VhZ2U6IFwiY1wiIHwgXCJjcHBcIiwgZGlzdHJpYnV0aW9uOiBzdHJpbmcsIHJvbGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByb290ID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgeyBjcHVCdWRnZXQgfSA9IChhd2FpdCBpbXBvcnQoXG4gICAgcGF0aFRvRmlsZVVSTChqb2luKGRpc3RyaWJ1dGlvbiwgXCJzY3JpcHRzL2NwdS1idWRnZXQubWpzXCIpKS5ocmVmXG4gICkpIGFzIHR5cGVvZiBpbXBvcnQoXCIuL2NwdS1idWRnZXQubWpzXCIpO1xuXG4gIGNvbnN0IHsgZW1pdENoZWNrRGV0YWlsIH0gPSAoYXdhaXQgaW1wb3J0KFxuICAgIHBhdGhUb0ZpbGVVUkwoam9pbihkaXN0cmlidXRpb24sIFwic2NyaXB0cy9jaGVjay1kZXRhaWwtZGF0YS5tanNcIikpLmhyZWZcbiAgKSkgYXMgdHlwZW9mIGltcG9ydChcIi4vY2hlY2stZGV0YWlsLWRhdGEubWpzXCIpO1xuICBjb25zdCBjb25maWd1cmVkQnVpbGRzID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0JVSUxEX0RJUjtcbiAgaWYgKCFjb25maWd1cmVkQnVpbGRzKSB0aHJvdyBuZXcgRXJyb3IoXCJ1c2UgV29ya2JlbmNoIGNoZWNrcyBvciBhIGNvbmZpZ3VyZWQgV29ya2JlbmNoIHNoZWxsIGZvciBuYXRpdmUgYnVpbGRzXCIpO1xuICBjb25zdCBidWlsZHMgPSBjb25maWd1cmVkQnVpbGRzO1xuICBjb25zdCBkZWJ1ZyA9IGpvaW4oYnVpbGRzLCBcImRlYnVnXCIpO1xuICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhcIndvcmtiZW5jaC9xdWFsaXR5Lmpzb25cIiwgXCJ1dGY4XCIpKSBhcyB7XG4gICAgc2xvd190ZXN0X3NlY29uZHM6IG51bWJlcjtcbiAgICBjb3ZlcmFnZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbiAgfTtcbiAgY29uc3Qgc3VmZml4ID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCIuZXhlXCIgOiBcIlwiO1xuICBjb25zdCByZXF1ZXN0ZWRDb21waWxlciA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9DT01QSUxFUiA/PyBcImNsYW5nXCI7XG4gIGlmICghaXNDb21waWxlckZhbWlseShyZXF1ZXN0ZWRDb21waWxlcikpIHRocm93IG5ldyBFcnJvcihcIlNlbGVjdCBhIGRlY2xhcmVkIG5hdGl2ZSBjb21waWxlclwiKTtcbiAgY29uc3Qgc2VsZWN0ZWRDb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSByZXF1ZXN0ZWRDb21waWxlcjtcbiAgaWYgKFxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiAmJlxuICAgIHNlbGVjdGVkQ29tcGlsZXIgPT09IFwibXZzY1wiICYmXG4gICAgcm9sZSAhPT0gXCJmb3JtYXRcIiAmJlxuICAgIHJvbGUgIT09IFwiZm9ybWF0LXdyaXRlXCIgJiZcbiAgICBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTkFUSVZFX1VURjhfQ09OU09MRSAhPT0gXCIxXCJcbiAgKSB7XG4gICAgY29uc3QgeyBydW5XaW5kb3dzVXRmOENvbnNvbGUgfSA9IGF3YWl0IGltcG9ydChcIi4vd2luZG93cy11dGY4LWNvbnNvbGUubWpzXCIpO1xuICAgIGF3YWl0IHJ1bldpbmRvd3NVdGY4Q29uc29sZShwcm9jZXNzLmFyZ3Yuc2xpY2UoMSksIGJ1aWxkcyk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IG1hbmFnZWQgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9DT01QSUxFUiA9PT0gXCIxXCI7XG4gIGNvbnN0IHBhcmFsbGVsaXNtID0gU3RyaW5nKGNwdUJ1ZGdldCgpKTtcbiAgcHJvY2Vzcy5lbnYuQ1RFU1RfUEFSQUxMRUxfTEVWRUwgPSBwYXJhbGxlbGlzbTtcbiAgZnVuY3Rpb24gcnVuKGNvbW1hbmQ6IHN0cmluZywgYXJnczogc3RyaW5nW10gPSBbXSwgb3B0aW9uczogT21pdDxTcGF3blN5bmNPcHRpb25zLCBcImVuY29kaW5nXCI+ID0ge30pIHtcbiAgICBjb25zdCByZXN1bHQ6IGltcG9ydChcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiKS5TcGF3blN5bmNSZXR1cm5zPHN0cmluZyB8IG51bGw+ID0gc3Bhd25TeW5jKGNvbW1hbmQsIGFyZ3MsIHtcbiAgICAgIGVuY29kaW5nOiBcInV0ZjhcIixcbiAgICAgIHN0ZGlvOiBcImluaGVyaXRcIixcbiAgICAgIC4uLm9wdGlvbnMsXG4gICAgfSk7XG4gICAgaWYgKHJlc3VsdC5lcnJvciB8fCByZXN1bHQuc3RhdHVzICE9PSAwKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGAke2NvbW1hbmR9IGZhaWxlZDogJHtTdHJpbmcocmVzdWx0LmVycm9yID8/IHJlc3VsdC5zdGF0dXMpfWApO1xuICAgIHJldHVybiByZXN1bHQuc3Rkb3V0ID8/IFwiXCI7XG4gIH1cbiAgZnVuY3Rpb24gY29sbGVjdENNYWtlRmFpbHVyZUxvZ3MoZGlyZWN0b3J5OiBzdHJpbmcpIHtcbiAgICBjb25zdCBidWlsZHRyZWVzID0gam9pbihkaXJlY3RvcnksIFwiYnRcIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG91dHB1dCA9IGpvaW4ocm9vdCwgXCJjb3ZlcmFnZVwiLCBcImNtYWtlXCIsIHJlbGF0aXZlKGJ1aWxkcywgZGlyZWN0b3J5KS5yZXBsYWNlQWxsKHNlcCwgXCItXCIpKTtcbiAgICAgIGNvbnN0IHBvcnRMb2dzID0gZXhpc3RzU3luYyhidWlsZHRyZWVzKVxuICAgICAgICA/IGZpbGVzKGJ1aWxkdHJlZXMpLmZpbHRlcigocGF0aCkgPT4gcGF0aC5lbmRzV2l0aChcIi5sb2dcIikgJiYgbHN0YXRTeW5jKHBhdGgpLmlzRmlsZSgpKVxuICAgICAgICA6IFtdO1xuICAgICAgZm9yIChjb25zdCBwYXRoIG9mIHBvcnRMb2dzKSB7XG4gICAgICAgIGNvbnN0IGRlc3RpbmF0aW9uID0gam9pbihvdXRwdXQsIFwidmNwa2dfYnVpbGR0cmVlc1wiLCByZWxhdGl2ZShidWlsZHRyZWVzLCBwYXRoKSk7XG4gICAgICAgIG1rZGlyU3luYyhqb2luKGRlc3RpbmF0aW9uLCBcIi4uXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgY29weUZpbGVTeW5jKHBhdGgsIGRlc3RpbmF0aW9uKTtcbiAgICAgICAgaWYgKC8tKG91dHxlcnIpXFwubG9nJC8udGVzdChwYXRoKSlcbiAgICAgICAgICBjb25zb2xlLmVycm9yKGAke3BhdGh9XFxuJHtyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpLnNsaWNlKC04MTkyKS5zcGxpdCgvXFxyP1xcbi8pLnNsaWNlKC00MCkuam9pbihcIlxcblwiKX1gKTtcbiAgICAgIH1cbiAgICAgIC8vIENvbXBpbGVyIGRldGVjdGlvbiBjYW4gc3VjY2VlZCBiZWZvcmUgYSBkZXBlbmRlbmN5IGZhaWxzLiBQcmVzZXJ2ZSB0aGUgbWFuaWZlc3QncyBhY3R1YWwgZXJyb3IsXG4gICAgICAvLyBhbmQgcHJpbnQgaXQgbGFzdCBzbyBib3VuZGVkIHRlcm1pbmFsIGV4Y2VycHRzIHJldGFpbiB0aGUgY2F1c2UgcmF0aGVyIHRoYW4gY29tcGlsZXIgd2FybmluZ3MuXG4gICAgICBjb25zdCBtYW5pZmVzdCA9IGpvaW4oZGlyZWN0b3J5LCBcInZjcGtnLW1hbmlmZXN0LWluc3RhbGwubG9nXCIpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMobWFuaWZlc3QpICYmIGxzdGF0U3luYyhtYW5pZmVzdCkuaXNGaWxlKCkpIHtcbiAgICAgICAgbWtkaXJTeW5jKG91dHB1dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgIGNvcHlGaWxlU3luYyhtYW5pZmVzdCwgam9pbihvdXRwdXQsIFwidmNwa2ctbWFuaWZlc3QtaW5zdGFsbC5sb2dcIikpO1xuICAgICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICAgIGAke21hbmlmZXN0fVxcbiR7cmVhZEZpbGVTeW5jKG1hbmlmZXN0LCBcInV0ZjhcIikuc2xpY2UoLTgxOTIpLnNwbGl0KC9cXHI/XFxuLykuc2xpY2UoLTQwKS5qb2luKFwiXFxuXCIpfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAocG9ydExvZ3MubGVuZ3RoIHx8IGV4aXN0c1N5bmMobWFuaWZlc3QpKSBjb25zb2xlLmVycm9yKGBDTWFrZSBmYWlsdXJlIGxvZ3M6ICR7b3V0cHV0fWApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKGBDb3VsZCBub3QgcmV0YWluIENNYWtlIGZhaWx1cmUgbG9nczogJHtTdHJpbmcoZXJyb3IpfWApO1xuICAgIH1cbiAgfVxuICBmdW5jdGlvbiBmaWxlcyhkaXJlY3Rvcnk6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyZWN0b3J5LCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSkuZmxhdE1hcCgoZW50cnkpID0+XG4gICAgICBlbnRyeS5pc0RpcmVjdG9yeSgpID8gZmlsZXMoam9pbihkaXJlY3RvcnksIGVudHJ5Lm5hbWUpKSA6IFtqb2luKGRpcmVjdG9yeSwgZW50cnkubmFtZSldLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgc291cmNlcyA9IFtcInNyY1wiLCBcImluY2x1ZGVcIiwgXCJ0ZXN0c1wiXS5mbGF0TWFwKGZpbGVzKS5maWx0ZXIoKGZpbGUpID0+IC9cXC4oPzpjfGNwcHxofGhwcCkkLy50ZXN0KGZpbGUpKTtcbiAgZnVuY3Rpb24gY29tcGlsZXJBcmd1bWVudHMoY29tcGlsZXI6IENvbXBpbGVyRmFtaWx5ID0gc2VsZWN0ZWRDb21waWxlcikge1xuICAgIGNvbnN0IGV4ZWN1dGFibGUgPVxuICAgICAgY29tcGlsZXIgPT09IHNlbGVjdGVkQ29tcGlsZXIgPyBwcm9jZXNzLmVudltsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIldPUktCRU5DSF9DQ1wiIDogXCJXT1JLQkVOQ0hfQ1hYXCJdIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiBbXG4gICAgICBgLURDTUFLRV8ke2xhbmd1YWdlID09PSBcImNcIiA/IFwiQ1wiIDogXCJDWFhcIn1fQ09NUElMRVI9JHtleGVjdXRhYmxlID8/IGNvbXBpbGVyQ2F0YWxvZ1tjb21waWxlcl0uZXhlY3V0YWJsZXNbbGFuZ3VhZ2VdfWAsXG4gICAgXTtcbiAgfVxuICBmdW5jdGlvbiBjb25maWd1cmUoZGlyZWN0b3J5OiBzdHJpbmcsIG9wdGlvbnM6IHN0cmluZ1tdID0gW10sIGNvbXBpbGVyOiBDb21waWxlckZhbWlseSA9IHNlbGVjdGVkQ29tcGlsZXIpIHtcbiAgICBpZiAoIW1hbmFnZWQpIHtcbiAgICAgIHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbXG4gICAgICAgIGpvaW4oZGlzdHJpYnV0aW9uLCBcImJpbi93b3JrYmVuY2gubWpzXCIpLFxuICAgICAgICBcInZjcGtnLXByZXBhcmVcIixcbiAgICAgICAgcm9vdCxcbiAgICAgICAgZGlyZWN0b3J5LFxuICAgICAgICBcIi0tY29tcGlsZXJcIixcbiAgICAgICAgY29tcGlsZXIsXG4gICAgICAgIC4uLihvcHRpb25zLmluY2x1ZGVzKFwiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiKSA/IFtcIi0tc2FuaXRpemVyc1wiXSA6IFtdKSxcbiAgICAgIF0pO1xuICAgICAgcHJvY2Vzcy5lbnYuVkNQS0dfRElTQUJMRV9NRVRSSUNTID0gXCIxXCI7XG4gICAgICBwcm9jZXNzLmVudi5WQ1BLR19GT1JDRV9TWVNURU1fQklOQVJJRVMgPSBcIjFcIjtcbiAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5WQ1BLR19GT1JDRV9ET1dOTE9BREVEX0JJTkFSSUVTO1xuICAgICAgcHJvY2Vzcy5lbnYuVkNQS0dfTUFYX0NPTkNVUlJFTkNZID0gcGFyYWxsZWxpc207XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBydW4oXCJjbWFrZVwiLCBbXG4gICAgICAgIFwiLVNcIixcbiAgICAgICAgXCIuXCIsXG4gICAgICAgIFwiLUJcIixcbiAgICAgICAgZGlyZWN0b3J5LFxuICAgICAgICBcIi1HXCIsXG4gICAgICAgIFwiTmluamFcIixcbiAgICAgICAgXCItRENNQUtFX0JVSUxEX1RZUEU9RGVidWdcIixcbiAgICAgICAgXCItRFdPUktCRU5DSF9MVE89b2ZmXCIsXG4gICAgICAgIFwiLURXT1JLQkVOQ0hfQ09WRVJBR0U9T0ZGXCIsXG4gICAgICAgIFwiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PRkZcIixcbiAgICAgICAgXCItRFdPUktCRU5DSF9QT1JUQUJMRV9PTkxZPU9GRlwiLFxuICAgICAgICAuLi4obWFuYWdlZFxuICAgICAgICAgID8gY29tcGlsZXJBcmd1bWVudHMoY29tcGlsZXIpXG4gICAgICAgICAgOiBbYC1EQ01BS0VfVE9PTENIQUlOX0ZJTEU9JHtqb2luKGRpcmVjdG9yeSwgXCJ3b3JrYmVuY2gtdmNwa2cuY21ha2VcIil9YF0pLFxuICAgICAgICAuLi4oKHByb2Nlc3MuZW52W2xhbmd1YWdlID09PSBcImNcIiA/IFwiV09SS0JFTkNIX0NfU1RBTkRBUkRcIiA6IFwiV09SS0JFTkNIX0NYWF9TVEFOREFSRFwiXSA/P1xuICAgICAgICBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTEFOR1VBR0VfU1RBTkRBUkQpXG4gICAgICAgICAgPyBbXG4gICAgICAgICAgICAgIGAtRFdPUktCRU5DSF9MQU5HVUFHRV9TVEFOREFSRD0ke3Byb2Nlc3MuZW52W2xhbmd1YWdlID09PSBcImNcIiA/IFwiV09SS0JFTkNIX0NfU1RBTkRBUkRcIiA6IFwiV09SS0JFTkNIX0NYWF9TVEFOREFSRFwiXSA/PyBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTEFOR1VBR0VfU1RBTkRBUkQgPz8gXCJcIn1gLFxuICAgICAgICAgICAgXVxuICAgICAgICAgIDogW10pLFxuICAgICAgICBgLURXT1JLQkVOQ0hfQ09NUElMRVJfRkFNSUxZPSR7Y29tcGlsZXJ9YCxcbiAgICAgICAgYC1EV09SS0JFTkNIX0NPTVBJTEVSX01JTklNVU09JHtjb21waWxlciA9PT0gc2VsZWN0ZWRDb21waWxlciA/IChwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ09NUElMRVJfTUlOSU1VTSA/PyBcIlwiKSA6IFwiXCJ9YCxcbiAgICAgICAgLi4uKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiAmJiBvcHRpb25zLmluY2x1ZGVzKFwiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiKVxuICAgICAgICAgID8gW1wiLURDTUFLRV9CVUlMRF9UWVBFPVJlbFdpdGhEZWJJbmZvXCJdXG4gICAgICAgICAgOiBbXSksXG4gICAgICAgIC4uLm9wdGlvbnMsXG4gICAgICBdKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29sbGVjdENNYWtlRmFpbHVyZUxvZ3MoZGlyZWN0b3J5KTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuICBmdW5jdGlvbiB0ZXN0KGRpcmVjdG9yeTogc3RyaW5nLCBwcm9maWxlcz86IHN0cmluZykge1xuICAgIG1rZGlyU3luYyhcImNvdmVyYWdlXCIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IHJlc3VsdHMgPSBqb2luKHJvb3QsIFwiY292ZXJhZ2VcIiwgYHRlc3RzLSR7ZGlyZWN0b3J5LnNsaWNlKGJ1aWxkcy5sZW5ndGggKyAxKS5yZXBsYWNlQWxsKHNlcCwgXCItXCIpfS54bWxgKTtcbiAgICBydW4oXCJjbWFrZVwiLCBbXCItLWJ1aWxkXCIsIGRpcmVjdG9yeSwgXCItLXBhcmFsbGVsXCIsIHBhcmFsbGVsaXNtXSk7XG4gICAgcnVuKFwiY3Rlc3RcIiwgW1wiLS10ZXN0LWRpclwiLCBkaXJlY3RvcnksIFwiLS1vdXRwdXQtb24tZmFpbHVyZVwiLCBcIi0tbm8tdGVzdHM9ZXJyb3JcIiwgXCItLW91dHB1dC1qdW5pdFwiLCByZXN1bHRzXSwge1xuICAgICAgZW52OiB7IC4uLnByb2Nlc3MuZW52LCAuLi4ocHJvZmlsZXMgPyB7IExMVk1fUFJPRklMRV9GSUxFOiBqb2luKHByb2ZpbGVzLCBcIiVwLSVtLnByb2ZyYXdcIikgfSA6IHt9KSB9LFxuICAgIH0pO1xuICAgIGNvbnN0IHJlcG9ydCA9IHJlYWRGaWxlU3luYyhyZXN1bHRzLCBcInV0ZjhcIik7XG4gICAgZm9yIChjb25zdCBtYXRjaCBvZiByZXBvcnQubWF0Y2hBbGwoLzx0ZXN0Y2FzZVxcYihbXj5dKyk+L2cpKSB7XG4gICAgICBhc3NlcnQub2sobWF0Y2hbMV0sIFwiTWlzc2luZyB0ZXN0Y2FzZSBhdHRyaWJ1dGVzXCIpO1xuICAgICAgY29uc3QgbmFtZSA9IC9cXGJuYW1lPVwiKFteXCJdKylcIi8uZXhlYyhtYXRjaFsxXSk/LlsxXTtcbiAgICAgIGNvbnN0IGVsYXBzZWQgPSBOdW1iZXIoL1xcYnRpbWU9XCIoW15cIl0rKVwiLy5leGVjKG1hdGNoWzFdKT8uWzFdKTtcbiAgICAgIGlmIChyb2xlICE9PSBcImNvdmVyYWdlXCIgJiYgZWxhcHNlZCA+IHBvbGljeS5zbG93X3Rlc3Rfc2Vjb25kcykge1xuICAgICAgICBlbWl0Q2hlY2tEZXRhaWwoe1xuICAgICAgICAgIHZlcnNpb246IDEsXG4gICAgICAgICAga2luZDogXCJzbG93XCIsXG4gICAgICAgICAgc2NvcGU6IFwidGVzdFwiLFxuICAgICAgICAgIG5hbWU6IFN0cmluZyhuYW1lKSxcbiAgICAgICAgICBlbGFwc2VkU2Vjb25kczogZWxhcHNlZCxcbiAgICAgICAgICB0aHJlc2hvbGRTZWNvbmRzOiBwb2xpY3kuc2xvd190ZXN0X3NlY29uZHMsXG4gICAgICAgIH0pO1xuICAgICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICAgIGBTTE9XIHRlc3QgJHtTdHJpbmcobmFtZSl9OiAke1N0cmluZyhlbGFwc2VkKX1zIChzb2Z0IGNhcCAke1N0cmluZyhwb2xpY3kuc2xvd190ZXN0X3NlY29uZHMpfXM7IGFkdmlzb3J5IG9ubHkpYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiB2ZXJpZnlSZWxlYXNlKGRpcmVjdG9yeTogc3RyaW5nKSB7XG4gICAgdGVzdChkaXJlY3RvcnkpO1xuICAgIHJ1bihwcm9jZXNzLmV4ZWNQYXRoLCBbam9pbihyb290LCBcInNjcmlwdHMvcmVsZWFzZS12ZXJpZnkubWpzXCIpLCBkaXJlY3RvcnldKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlamVjdEx0byhuYW1lOiBzdHJpbmcsIG9wdGlvbnM6IHN0cmluZ1tdLCBkaWFnbm9zdGljOiBSZWdFeHApIHtcbiAgICAvLyBSZXVzZSB0aGUgdmVyaWZpZWQgb2ZmLW1vZGUgZGVwZW5kZW5jeSBpbnN0YWxsYXRpb24sIHdpdGhvdXQgcmVpbnN0YWxsaW5nIGRlcGVuZGVuY2llcy5cbiAgICBjb25zdCByZXN1bHQ6IGltcG9ydChcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiKS5TcGF3blN5bmNSZXR1cm5zPHN0cmluZyB8IG51bGw+ID0gc3Bhd25TeW5jKFxuICAgICAgXCJjbWFrZVwiLFxuICAgICAgW1xuICAgICAgICBcIi1TXCIsXG4gICAgICAgIFwiLlwiLFxuICAgICAgICBcIi1CXCIsXG4gICAgICAgIGpvaW4oYnVpbGRzLCBgbHRvLXJlamVjdC0ke25hbWV9YCksXG4gICAgICAgIFwiLUdcIixcbiAgICAgICAgXCJOaW5qYVwiLFxuICAgICAgICAuLi4obWFuYWdlZFxuICAgICAgICAgID8gY29tcGlsZXJBcmd1bWVudHMoKVxuICAgICAgICAgIDogW1xuICAgICAgICAgICAgICBgLURDTUFLRV9UT09MQ0hBSU5fRklMRT0ke2pvaW4oYnVpbGRzLCBcImx0by1vZmZcIiwgXCJ3b3JrYmVuY2gtdmNwa2cuY21ha2VcIil9YCxcbiAgICAgICAgICAgICAgXCItRFZDUEtHX01BTklGRVNUX0lOU1RBTEw9T0ZGXCIsXG4gICAgICAgICAgICBdKSxcbiAgICAgICAgXCItRENNQUtFX0JVSUxEX1RZUEU9UmVsZWFzZVwiLFxuICAgICAgICBcIi1EV09SS0JFTkNIX0xUTz1mdWxsXCIsXG4gICAgICAgIC4uLm9wdGlvbnMsXG4gICAgICBdLFxuICAgICAgeyBlbmNvZGluZzogXCJ1dGY4XCIgfSxcbiAgICApO1xuICAgIGNvbnN0IG91dHB1dCA9IGAke3Jlc3VsdC5zdGRvdXQgPz8gXCJcIn0ke3Jlc3VsdC5zdGRlcnIgPz8gXCJcIn1gO1xuICAgIGlmIChyZXN1bHQuZXJyb3IgfHwgcmVzdWx0LnN0YXR1cyA9PT0gbnVsbCB8fCByZXN1bHQuc3RhdHVzID09PSAwIHx8ICFkaWFnbm9zdGljLnRlc3Qob3V0cHV0KSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgRXhwZWN0ZWQgTFRPIHJlamVjdGlvbiBmb3IgJHtuYW1lfTogJHtyZXN1bHQuZXJyb3IgPz8gb3V0cHV0fWApO1xuICAgIGNvbnNvbGUubG9nKGBWZXJpZmllZCBMVE8gcmVqZWN0aW9uOiAke25hbWV9YCk7XG4gIH1cblxuICBpZiAocm9sZSA9PT0gXCJmb3JtYXRcIiB8fCByb2xlID09PSBcImZvcm1hdC13cml0ZVwiKSB7XG4gICAgcnVuKFwiY2xhbmctZm9ybWF0XCIsIFsuLi4ocm9sZSA9PT0gXCJmb3JtYXRcIiA/IFtcIi0tZHJ5LXJ1blwiLCBcIi0tV2Vycm9yXCJdIDogW1wiLWlcIl0pLCAuLi5zb3VyY2VzXSk7XG4gIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJsaW50XCIpIHtcbiAgICBydW4oXCJjbGFuZy10aWR5XCIsIFtcIi0tdmVyaWZ5LWNvbmZpZ1wiXSk7XG4gICAgY29uc3QgYW5hbHlzaXMgPSBzZWxlY3RlZENvbXBpbGVyID09PSBcImNsYW5nXCIgPyBkZWJ1ZyA6IGpvaW4oYnVpbGRzLCBcImFuYWx5c2lzLWNsYW5nXCIpO1xuICAgIGNvbmZpZ3VyZShhbmFseXNpcywgW10sIFwiY2xhbmdcIik7XG4gICAgcnVuKFwiY21ha2VcIiwgW1wiLS1idWlsZFwiLCBhbmFseXNpcywgXCItLXBhcmFsbGVsXCIsIHBhcmFsbGVsaXNtXSk7XG4gICAgZm9yIChjb25zdCBzb3VyY2Ugb2Ygc291cmNlcy5maWx0ZXIoKGZpbGUpID0+IC9cXC4oPzpjfGNwcCkkLy50ZXN0KGZpbGUpKSlcbiAgICAgIHJ1bihcImNsYW5nLXRpZHlcIiwgW1wiLXBcIiwgYW5hbHlzaXMsIHNvdXJjZV0pO1xuICB9IGVsc2UgaWYgKHJvbGUgPT09IFwiYnVpbGRcIiB8fCByb2xlID09PSBcInJlbGVhc2VcIikge1xuICAgIGNvbnN0IGRpcmVjdG9yeSA9IHJvbGUgPT09IFwicmVsZWFzZVwiID8gam9pbihidWlsZHMsIFwicmVsZWFzZVwiKSA6IGRlYnVnO1xuICAgIGNvbmZpZ3VyZShcbiAgICAgIGRpcmVjdG9yeSxcbiAgICAgIHJvbGUgPT09IFwicmVsZWFzZVwiID8gW1wiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIiwgYC1EV09SS0JFTkNIX0xUTz0ke3Byb2Nlc3MuZW52LldPUktCRU5DSF9MVE8gPz8gXCJvZmZcIn1gXSA6IFtdLFxuICAgICk7XG4gICAgaWYgKHJvbGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgICB2ZXJpZnlSZWxlYXNlKGRpcmVjdG9yeSk7XG4gICAgICBjb25zdCBvdXRwdXQgPSByZXNvbHZlKHByb2Nlc3MuZW52LldPUktCRU5DSF9SRUxFQVNFX09VVFBVVCA/PyBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfRElTVF9ESVIgPz8gXCJkaXN0XCIpO1xuICAgICAgbWtkaXJTeW5jKG91dHB1dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb3B5RmlsZVN5bmMoam9pbihkaXJlY3RvcnksIGBjb3VudCR7c3VmZml4fWApLCBqb2luKG91dHB1dCwgYGNvdW50JHtzdWZmaXh9YCkpO1xuICAgICAgY29weUZpbGVTeW5jKFwiTElDRU5TRVwiLCBqb2luKG91dHB1dCwgXCJMSUNFTlNFXCIpKTtcbiAgICB9IGVsc2UgcnVuKFwiY21ha2VcIiwgW1wiLS1idWlsZFwiLCBkaXJlY3RvcnksIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICB9IGVsc2UgaWYgKHJvbGUgPT09IFwibHRvXCIpIHtcbiAgICBmb3IgKGNvbnN0IG1vZGUgb2Ygc2VsZWN0ZWRDb21waWxlciA9PT0gXCJjbGFuZ1wiID8gW1wib2ZmXCIsIFwidGhpblwiLCBcImZ1bGxcIl0gOiBbXCJvZmZcIiwgXCJmdWxsXCJdKSB7XG4gICAgICBjb25zdCBkaXJlY3RvcnkgPSBqb2luKGJ1aWxkcywgYGx0by0ke21vZGV9YCk7XG4gICAgICBjb25maWd1cmUoZGlyZWN0b3J5LCBbXCItRENNQUtFX0JVSUxEX1RZUEU9UmVsZWFzZVwiLCBgLURXT1JLQkVOQ0hfTFRPPSR7bW9kZX1gXSk7XG4gICAgICB2ZXJpZnlSZWxlYXNlKGRpcmVjdG9yeSk7XG4gICAgfVxuICAgIHJlamVjdEx0byhcImludmFsaWRcIiwgW1wiLURXT1JLQkVOQ0hfTFRPPXVua25vd25cIl0sIC9tdXN0IHNlbGVjdCBvZmYsIHRoaW4sIG9yIGZ1bGwvKTtcbiAgICByZWplY3RMdG8oXCJkZWJ1Z1wiLCBbXCItRENNQUtFX0JVSUxEX1RZUEU9RGVidWdcIl0sIC9zZXBhcmF0ZSBvcHRpbWl6ZWQgc2luZ2xlLWNvbmZpZ3VyYXRpb24gYnVpbGQvKTtcbiAgICByZWplY3RMdG8oXCJjb3ZlcmFnZVwiLCBbXCItRFdPUktCRU5DSF9DT1ZFUkFHRT1PTlwiXSwgL3NlcGFyYXRlIExUTyBidWlsZCBmcm9tIGNvdmVyYWdlIGFuZCBzYW5pdGl6ZXJzLyk7XG4gICAgcmVqZWN0THRvKFwic2FuaXRpemVyc1wiLCBbXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCJdLCAvc2VwYXJhdGUgTFRPIGJ1aWxkIGZyb20gY292ZXJhZ2UgYW5kIHNhbml0aXplcnMvKTtcbiAgICBpZiAoc2VsZWN0ZWRDb21waWxlciAhPT0gXCJjbGFuZ1wiKVxuICAgICAgcmVqZWN0THRvKFwidGhpblwiLCBbXCItRFdPUktCRU5DSF9MVE89dGhpblwiXSwgL2RvZXMgbm90IHN1cHBvcnQgdGhlIHJlcXVlc3RlZCBMVE8gbW9kZS8pO1xuICAgIGVsc2UgcmVqZWN0THRvKFwidG9vbC12ZXJzaW9uXCIsIFtgLURsdG9fbGlua2VyPSR7cHJvY2Vzcy5leGVjUGF0aH1gXSwgL211c3QgbWF0Y2ggQ2xhbmcvKTtcbiAgfSBlbHNlIGlmIChyb2xlID09PSBcInRlc3RcIikge1xuICAgIGNvbmZpZ3VyZShkZWJ1Zyk7XG4gICAgdGVzdChkZWJ1Zyk7XG4gIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJjb3ZlcmFnZVwiKSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoXCJjb3ZlcmFnZVwiKSAmJiBsc3RhdFN5bmMoXCJjb3ZlcmFnZVwiKS5pc1N5bWJvbGljTGluaygpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiY292ZXJhZ2UgbXVzdCBiZSBhIHJlYWwgZGlyZWN0b3J5XCIpO1xuICAgIG1rZGlyU3luYyhcImNvdmVyYWdlXCIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyhcImNvdmVyYWdlXCIpKVxuICAgICAgaWYgKG5hbWUgIT09IFwiY292ZXJhZ2Utc3VtbWFyeS5qc29uXCIpIHJtU3luYyhqb2luKFwiY292ZXJhZ2VcIiwgbmFtZSksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBpZiAoc2VsZWN0ZWRDb21waWxlciAhPT0gXCJjbGFuZ1wiKSB7XG4gICAgICBjb25maWd1cmUoZGVidWcpO1xuICAgICAgdGVzdChkZWJ1Zyk7XG4gICAgfVxuICAgIGNvbnN0IGluc3RydW1lbnRlZCA9IGpvaW4oYnVpbGRzLCBcImNvdmVyYWdlXCIpO1xuICAgIGNvbmZpZ3VyZShpbnN0cnVtZW50ZWQsIFtcIi1EV09SS0JFTkNIX0NPVkVSQUdFPU9OXCJdLCBcImNsYW5nXCIpO1xuICAgIGNvbnN0IHRlbXBvcmFyeSA9IG1rZHRlbXBTeW5jKGpvaW4oaW5zdHJ1bWVudGVkLCBcInByb2ZpbGVzLVwiKSk7XG4gICAgdHJ5IHtcbiAgICAgIHRlc3QoaW5zdHJ1bWVudGVkLCB0ZW1wb3JhcnkpO1xuICAgICAgY29uc3QgcHJvZmlsZXMgPSBmaWxlcyh0ZW1wb3JhcnkpLmZpbHRlcigoZmlsZTogc3RyaW5nKSA9PiBmaWxlLmVuZHNXaXRoKFwiLnByb2ZyYXdcIikpO1xuICAgICAgaWYgKCFwcm9maWxlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIHByb2R1Y2VkIG5vIGV4ZWN1dGlvbiBwcm9maWxlc1wiKTtcbiAgICAgIGNvbnN0IG1lcmdlZCA9IGpvaW4odGVtcG9yYXJ5LCBcIm1lcmdlZC5wcm9mZGF0YVwiKTtcbiAgICAgIHJ1bihcImxsdm0tcHJvZmRhdGFcIiwgW1wibWVyZ2VcIiwgXCItc3BhcnNlXCIsIC4uLnByb2ZpbGVzLCBcIi1vXCIsIG1lcmdlZF0pO1xuICAgICAgY29uc3Qgc291cmNlRmlsZXMgPSBzb3VyY2VzLmZpbHRlcigoZmlsZSkgPT4gIWZpbGUuc3RhcnRzV2l0aChgdGVzdHMke3NlcH1gKSk7XG4gICAgICBjb25zdCBjb3ZlcmFnZUFyZ3MgPSBbXG4gICAgICAgIGpvaW4oaW5zdHJ1bWVudGVkLCBgY291bnRfdGVzdCR7c3VmZml4fWApLFxuICAgICAgICBcIi1vYmplY3RcIixcbiAgICAgICAgam9pbihpbnN0cnVtZW50ZWQsIGBjb3VudCR7c3VmZml4fWApLFxuICAgICAgICBcIi1vYmplY3RcIixcbiAgICAgICAgam9pbihpbnN0cnVtZW50ZWQsIGBjcHVfdGVzdCR7c3VmZml4fWApLFxuICAgICAgICBgLWluc3RyLXByb2ZpbGU9JHttZXJnZWR9YCxcbiAgICAgICAgLi4uc291cmNlRmlsZXMsXG4gICAgICBdO1xuICAgICAgcnVuKFwibGx2bS1jb3ZcIiwgW1wicmVwb3J0XCIsIC4uLmNvdmVyYWdlQXJnc10pO1xuICAgICAgY29uc3QgcmVwb3J0ID0gSlNPTi5wYXJzZShydW4oXCJsbHZtLWNvdlwiLCBbXCJleHBvcnRcIiwgLi4uY292ZXJhZ2VBcmdzXSwgeyBzdGRpbzogXCJwaXBlXCIgfSkpIGFzIHtcbiAgICAgICAgZGF0YTogeyB0b3RhbHM6IFJlY29yZDxzdHJpbmcsIHsgY291bnQ6IG51bWJlcjsgcGVyY2VudDogbnVtYmVyIH0+IH1bXTtcbiAgICAgIH07XG4gICAgICB3cml0ZUZpbGVTeW5jKFwiY292ZXJhZ2UvcmVwb3J0Lmpzb25cIiwgSlNPTi5zdHJpbmdpZnkocmVwb3J0KSk7XG4gICAgICBhc3NlcnQub2socmVwb3J0LmRhdGFbMF0sIFwiTExWTSBjb3ZlcmFnZSBkaWQgbm90IHJlcG9ydCB0b3RhbHNcIik7XG4gICAgICBjb25zdCB0b3RhbCA9IHJlcG9ydC5kYXRhWzBdLnRvdGFscztcbiAgICAgIGZvciAoY29uc3QgW21ldHJpYywgbWluaW11bV0gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5LmNvdmVyYWdlKSkge1xuICAgICAgICBpZiAoIXRvdGFsW21ldHJpY10gfHwgdG90YWxbbWV0cmljXS5jb3VudCA9PT0gMCB8fCB0b3RhbFttZXRyaWNdLnBlcmNlbnQgPCBtaW5pbXVtKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGAke21ldHJpY30gY292ZXJhZ2UgJHtTdHJpbmcodG90YWxbbWV0cmljXT8ucGVyY2VudCA/PyBcIm1pc3NpbmdcIil9JSBpcyBiZWxvdyAke1N0cmluZyhtaW5pbXVtKX0lYCxcbiAgICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcG9yYXJ5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9IGVsc2UgaWYgKHJvbGUgPT09IFwic2FuaXRpemVyc1wiKSB7XG4gICAgY29uZmlndXJlKGpvaW4oYnVpbGRzLCBcImFcIiksIFtcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIl0pO1xuICAgIHRlc3Qoam9pbihidWlsZHMsIFwiYVwiKSk7XG4gICAgY29uZmlndXJlKGpvaW4oYnVpbGRzLCBcInBcIiksIFtcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIiwgXCItRFdPUktCRU5DSF9QT1JUQUJMRV9PTkxZPU9OXCJdKTtcbiAgICB0ZXN0KGpvaW4oYnVpbGRzLCBcInBcIikpO1xuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBFcnJvcihcImV4cGVjdGVkIGJ1aWxkLCByZWxlYXNlLCBmb3JtYXQsIGZvcm1hdC13cml0ZSwgbGludCwgdGVzdCwgY292ZXJhZ2UsIHNhbml0aXplcnMsIG9yIGx0b1wiKTtcbiAgfVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxZQUFZO0FBQ25CLFNBQWdDLGlCQUFpQjtBQUVqRDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLE1BQU0sVUFBVSxTQUFTLFdBQVc7QUFDN0MsU0FBUyxxQkFBcUI7QUFFOUIsU0FBUyxpQkFBaUIsd0JBQTZDO0FBRXZFLGVBQXNCLGdCQUFn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QUNwRSxZQUFNLGNBQWMsUUFBUSxPQUFPLENBQUMsU0FBUyxDQUFDLEtBQUssV0FBVyxRQUFRLEdBQUcsRUFBRSxDQUFDO0FBQzVFLFlBQU0sZUFBZTtBQUFBLFFBQ25CLEtBQUssY0FBYyxhQUFhLE1BQU0sRUFBRTtBQUFBLFFBQ3hDO0FBQUEsUUFDQSxLQUFLLGNBQWMsUUFBUSxNQUFNLEVBQUU7QUFBQSxRQUNuQztBQUFBLFFBQ0EsS0FBSyxjQUFjLFdBQVcsTUFBTSxFQUFFO0FBQUEsUUFDdEMsa0JBQWtCLE1BQU07QUFBQSxRQUN4QixHQUFHO0FBQUEsTUFDTDtBQUNBLFVBQUksWUFBWSxDQUFDLFVBQVUsR0FBRyxZQUFZLENBQUM7QUFDM0MsWUFBTSxTQUFTLEtBQUssTUFBTSxJQUFJLFlBQVksQ0FBQyxVQUFVLEdBQUcsWUFBWSxHQUFHLEVBQUUsT0FBTyxPQUFPLENBQUMsQ0FBQztBQUd6RixvQkFBYyx3QkFBd0IsS0FBSyxVQUFVLE1BQU0sQ0FBQztBQUM1RCxhQUFPLEdBQUcsT0FBTyxLQUFLLENBQUMsR0FBRyxxQ0FBcUM7QUFDL0QsWUFBTSxRQUFRLE9BQU8sS0FBSyxDQUFDLEVBQUU7QUFDN0IsaUJBQVcsQ0FBQyxRQUFRLE9BQU8sS0FBSyxPQUFPLFFBQVEsT0FBTyxRQUFRLEdBQUc7QUFDL0QsWUFBSSxDQUFDLE1BQU0sTUFBTSxLQUFLLE1BQU0sTUFBTSxFQUFFLFVBQVUsS0FBSyxNQUFNLE1BQU0sRUFBRSxVQUFVO0FBQ3pFLGdCQUFNLElBQUk7QUFBQSxZQUNSLEdBQUcsTUFBTSxhQUFhLE9BQU8sTUFBTSxNQUFNLEdBQUcsV0FBVyxTQUFTLENBQUMsY0FBYyxPQUFPLE9BQU8sQ0FBQztBQUFBLFVBQ2hHO0FBQUEsTUFDSjtBQUFBLElBQ0YsVUFBRTtBQUNBLGFBQU8sV0FBVyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ3BEO0FBQUEsRUFDRixXQUFXLFNBQVMsY0FBYztBQUNoQyxjQUFVLEtBQUssUUFBUSxHQUFHLEdBQUcsQ0FBQywyQkFBMkIsQ0FBQztBQUMxRCxTQUFLLEtBQUssUUFBUSxHQUFHLENBQUM7QUFDdEIsY0FBVSxLQUFLLFFBQVEsR0FBRyxHQUFHLENBQUMsNkJBQTZCLDhCQUE4QixDQUFDO0FBQzFGLFNBQUssS0FBSyxRQUFRLEdBQUcsQ0FBQztBQUFBLEVBQ3hCLE9BQU87QUFDTCxVQUFNLElBQUksTUFBTSx5RkFBeUY7QUFBQSxFQUMzRztBQUNGOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvbmF0aXZlLWMtY2hlY2tzLm1qcyJ9
