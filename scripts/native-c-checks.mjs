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
    configure(join(builds, "asan"), ["-DWORKBENCH_SANITIZERS=ON"]);
    test(join(builds, "asan"));
    configure(join(builds, "portable"), ["-DWORKBENCH_SANITIZERS=ON", "-DWORKBENCH_PORTABLE_ONLY=ON"]);
    test(join(builds, "portable"));
  } else {
    throw new Error("expected build, release, format, format-write, lint, test, coverage, sanitizers, or lto");
  }
}
export {
  runNativeChecks
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5hdGl2ZS1jLWNoZWNrcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyB0eXBlIFNwYXduU3luY09wdGlvbnMsIHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbHN0YXRTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICBta2RpclN5bmMsXG4gIG1rZHRlbXBTeW5jLFxuICBybVN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG4gIGNvcHlGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5cbmltcG9ydCB7IGNvbXBpbGVyQ2F0YWxvZywgaXNDb21waWxlckZhbWlseSwgdHlwZSBDb21waWxlckZhbWlseSB9IGZyb20gXCIuL2NvbXBpbGVyLWNhdGFsb2cubWpzXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5OYXRpdmVDaGVja3MobGFuZ3VhZ2U6IFwiY1wiIHwgXCJjcHBcIiwgZGlzdHJpYnV0aW9uOiBzdHJpbmcsIHJvbGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByb290ID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgeyBjcHVCdWRnZXQgfSA9IChhd2FpdCBpbXBvcnQoXG4gICAgcGF0aFRvRmlsZVVSTChqb2luKGRpc3RyaWJ1dGlvbiwgXCJzY3JpcHRzL2NwdS1idWRnZXQubWpzXCIpKS5ocmVmXG4gICkpIGFzIHR5cGVvZiBpbXBvcnQoXCIuL2NwdS1idWRnZXQubWpzXCIpO1xuXG4gIGNvbnN0IHsgZW1pdENoZWNrRGV0YWlsIH0gPSAoYXdhaXQgaW1wb3J0KFxuICAgIHBhdGhUb0ZpbGVVUkwoam9pbihkaXN0cmlidXRpb24sIFwic2NyaXB0cy9jaGVjay1kZXRhaWwtZGF0YS5tanNcIikpLmhyZWZcbiAgKSkgYXMgdHlwZW9mIGltcG9ydChcIi4vY2hlY2stZGV0YWlsLWRhdGEubWpzXCIpO1xuICBjb25zdCBjb25maWd1cmVkQnVpbGRzID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0JVSUxEX0RJUjtcbiAgaWYgKCFjb25maWd1cmVkQnVpbGRzKSB0aHJvdyBuZXcgRXJyb3IoXCJ1c2UgV29ya2JlbmNoIGNoZWNrcyBvciBhIGNvbmZpZ3VyZWQgV29ya2JlbmNoIHNoZWxsIGZvciBuYXRpdmUgYnVpbGRzXCIpO1xuICBjb25zdCBidWlsZHMgPSBjb25maWd1cmVkQnVpbGRzO1xuICBjb25zdCBkZWJ1ZyA9IGpvaW4oYnVpbGRzLCBcImRlYnVnXCIpO1xuICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhcIndvcmtiZW5jaC9xdWFsaXR5Lmpzb25cIiwgXCJ1dGY4XCIpKSBhcyB7XG4gICAgc2xvd190ZXN0X3NlY29uZHM6IG51bWJlcjtcbiAgICBjb3ZlcmFnZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbiAgfTtcbiAgY29uc3Qgc3VmZml4ID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCIuZXhlXCIgOiBcIlwiO1xuICBjb25zdCByZXF1ZXN0ZWRDb21waWxlciA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9DT01QSUxFUiA/PyBcImNsYW5nXCI7XG4gIGlmICghaXNDb21waWxlckZhbWlseShyZXF1ZXN0ZWRDb21waWxlcikpIHRocm93IG5ldyBFcnJvcihcIlNlbGVjdCBhIGRlY2xhcmVkIG5hdGl2ZSBjb21waWxlclwiKTtcbiAgY29uc3Qgc2VsZWN0ZWRDb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSByZXF1ZXN0ZWRDb21waWxlcjtcbiAgY29uc3QgbWFuYWdlZCA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0NPTVBJTEVSID09PSBcIjFcIjtcbiAgY29uc3QgcGFyYWxsZWxpc20gPSBTdHJpbmcoY3B1QnVkZ2V0KCkpO1xuICBwcm9jZXNzLmVudi5DVEVTVF9QQVJBTExFTF9MRVZFTCA9IHBhcmFsbGVsaXNtO1xuICBmdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSA9IFtdLCBvcHRpb25zOiBPbWl0PFNwYXduU3luY09wdGlvbnMsIFwiZW5jb2RpbmdcIj4gPSB7fSkge1xuICAgIGNvbnN0IHJlc3VsdDogaW1wb3J0KFwibm9kZTpjaGlsZF9wcm9jZXNzXCIpLlNwYXduU3luY1JldHVybnM8c3RyaW5nIHwgbnVsbD4gPSBzcGF3blN5bmMoY29tbWFuZCwgYXJncywge1xuICAgICAgZW5jb2Rpbmc6IFwidXRmOFwiLFxuICAgICAgc3RkaW86IFwiaW5oZXJpdFwiLFxuICAgICAgLi4ub3B0aW9ucyxcbiAgICB9KTtcbiAgICBpZiAocmVzdWx0LmVycm9yIHx8IHJlc3VsdC5zdGF0dXMgIT09IDApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhyZXN1bHQuZXJyb3IgPz8gcmVzdWx0LnN0YXR1cyl9YCk7XG4gICAgcmV0dXJuIHJlc3VsdC5zdGRvdXQgPz8gXCJcIjtcbiAgfVxuICBmdW5jdGlvbiBjb2xsZWN0Q01ha2VGYWlsdXJlTG9ncyhkaXJlY3Rvcnk6IHN0cmluZykge1xuICAgIGNvbnN0IGJ1aWxkdHJlZXMgPSBqb2luKGRpcmVjdG9yeSwgXCJidFwiKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgb3V0cHV0ID0gam9pbihyb290LCBcImNvdmVyYWdlXCIsIFwiY21ha2VcIiwgcmVsYXRpdmUoYnVpbGRzLCBkaXJlY3RvcnkpLnJlcGxhY2VBbGwoc2VwLCBcIi1cIikpO1xuICAgICAgY29uc3QgcG9ydExvZ3MgPSBleGlzdHNTeW5jKGJ1aWxkdHJlZXMpXG4gICAgICAgID8gZmlsZXMoYnVpbGR0cmVlcykuZmlsdGVyKChwYXRoKSA9PiBwYXRoLmVuZHNXaXRoKFwiLmxvZ1wiKSAmJiBsc3RhdFN5bmMocGF0aCkuaXNGaWxlKCkpXG4gICAgICAgIDogW107XG4gICAgICBmb3IgKGNvbnN0IHBhdGggb2YgcG9ydExvZ3MpIHtcbiAgICAgICAgY29uc3QgZGVzdGluYXRpb24gPSBqb2luKG91dHB1dCwgXCJ2Y3BrZ19idWlsZHRyZWVzXCIsIHJlbGF0aXZlKGJ1aWxkdHJlZXMsIHBhdGgpKTtcbiAgICAgICAgbWtkaXJTeW5jKGpvaW4oZGVzdGluYXRpb24sIFwiLi5cIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICBjb3B5RmlsZVN5bmMocGF0aCwgZGVzdGluYXRpb24pO1xuICAgICAgICBpZiAoLy0ob3V0fGVycilcXC5sb2ckLy50ZXN0KHBhdGgpKVxuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYCR7cGF0aH1cXG4ke3JlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikuc2xpY2UoLTgxOTIpLnNwbGl0KC9cXHI/XFxuLykuc2xpY2UoLTQwKS5qb2luKFwiXFxuXCIpfWApO1xuICAgICAgfVxuICAgICAgLy8gQ29tcGlsZXIgZGV0ZWN0aW9uIGNhbiBzdWNjZWVkIGJlZm9yZSBhIGRlcGVuZGVuY3kgZmFpbHMuIFByZXNlcnZlIHRoZSBtYW5pZmVzdCdzIGFjdHVhbCBlcnJvcixcbiAgICAgIC8vIGFuZCBwcmludCBpdCBsYXN0IHNvIGJvdW5kZWQgdGVybWluYWwgZXhjZXJwdHMgcmV0YWluIHRoZSBjYXVzZSByYXRoZXIgdGhhbiBjb21waWxlciB3YXJuaW5ncy5cbiAgICAgIGNvbnN0IG1hbmlmZXN0ID0gam9pbihkaXJlY3RvcnksIFwidmNwa2ctbWFuaWZlc3QtaW5zdGFsbC5sb2dcIik7XG4gICAgICBpZiAoZXhpc3RzU3luYyhtYW5pZmVzdCkgJiYgbHN0YXRTeW5jKG1hbmlmZXN0KS5pc0ZpbGUoKSkge1xuICAgICAgICBta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgY29weUZpbGVTeW5jKG1hbmlmZXN0LCBqb2luKG91dHB1dCwgXCJ2Y3BrZy1tYW5pZmVzdC1pbnN0YWxsLmxvZ1wiKSk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICAgICAgYCR7bWFuaWZlc3R9XFxuJHtyZWFkRmlsZVN5bmMobWFuaWZlc3QsIFwidXRmOFwiKS5zbGljZSgtODE5Mikuc3BsaXQoL1xccj9cXG4vKS5zbGljZSgtNDApLmpvaW4oXCJcXG5cIil9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChwb3J0TG9ncy5sZW5ndGggfHwgZXhpc3RzU3luYyhtYW5pZmVzdCkpIGNvbnNvbGUuZXJyb3IoYENNYWtlIGZhaWx1cmUgbG9nczogJHtvdXRwdXR9YCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYENvdWxkIG5vdCByZXRhaW4gQ01ha2UgZmFpbHVyZSBsb2dzOiAke1N0cmluZyhlcnJvcil9YCk7XG4gICAgfVxuICB9XG4gIGZ1bmN0aW9uIGZpbGVzKGRpcmVjdG9yeTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgIHJldHVybiByZWFkZGlyU3luYyhkaXJlY3RvcnksIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KS5mbGF0TWFwKChlbnRyeSkgPT5cbiAgICAgIGVudHJ5LmlzRGlyZWN0b3J5KCkgPyBmaWxlcyhqb2luKGRpcmVjdG9yeSwgZW50cnkubmFtZSkpIDogW2pvaW4oZGlyZWN0b3J5LCBlbnRyeS5uYW1lKV0sXG4gICAgKTtcbiAgfVxuICBjb25zdCBzb3VyY2VzID0gW1wic3JjXCIsIFwiaW5jbHVkZVwiLCBcInRlc3RzXCJdLmZsYXRNYXAoZmlsZXMpLmZpbHRlcigoZmlsZSkgPT4gL1xcLig/OmN8Y3BwfGh8aHBwKSQvLnRlc3QoZmlsZSkpO1xuICBmdW5jdGlvbiBjb21waWxlckFyZ3VtZW50cyhjb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSBzZWxlY3RlZENvbXBpbGVyKSB7XG4gICAgY29uc3QgZXhlY3V0YWJsZSA9XG4gICAgICBjb21waWxlciA9PT0gc2VsZWN0ZWRDb21waWxlciA/IHByb2Nlc3MuZW52W2xhbmd1YWdlID09PSBcImNcIiA/IFwiV09SS0JFTkNIX0NDXCIgOiBcIldPUktCRU5DSF9DWFhcIl0gOiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIFtcbiAgICAgIGAtRENNQUtFXyR7bGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJDXCIgOiBcIkNYWFwifV9DT01QSUxFUj0ke2V4ZWN1dGFibGUgPz8gY29tcGlsZXJDYXRhbG9nW2NvbXBpbGVyXS5leGVjdXRhYmxlc1tsYW5ndWFnZV19YCxcbiAgICBdO1xuICB9XG4gIGZ1bmN0aW9uIGNvbmZpZ3VyZShkaXJlY3Rvcnk6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10gPSBbXSwgY29tcGlsZXI6IENvbXBpbGVyRmFtaWx5ID0gc2VsZWN0ZWRDb21waWxlcikge1xuICAgIGlmICghbWFuYWdlZCkge1xuICAgICAgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICAgICAgam9pbihkaXN0cmlidXRpb24sIFwiYmluL3dvcmtiZW5jaC5tanNcIiksXG4gICAgICAgIFwidmNwa2ctcHJlcGFyZVwiLFxuICAgICAgICByb290LFxuICAgICAgICBkaXJlY3RvcnksXG4gICAgICAgIFwiLS1jb21waWxlclwiLFxuICAgICAgICBjb21waWxlcixcbiAgICAgICAgLi4uKG9wdGlvbnMuaW5jbHVkZXMoXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCIpID8gW1wiLS1zYW5pdGl6ZXJzXCJdIDogW10pLFxuICAgICAgXSk7XG4gICAgICBwcm9jZXNzLmVudi5WQ1BLR19ESVNBQkxFX01FVFJJQ1MgPSBcIjFcIjtcbiAgICAgIHByb2Nlc3MuZW52LlZDUEtHX0ZPUkNFX1NZU1RFTV9CSU5BUklFUyA9IFwiMVwiO1xuICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LlZDUEtHX0ZPUkNFX0RPV05MT0FERURfQklOQVJJRVM7XG4gICAgICBwcm9jZXNzLmVudi5WQ1BLR19NQVhfQ09OQ1VSUkVOQ1kgPSBwYXJhbGxlbGlzbTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIHJ1bihcImNtYWtlXCIsIFtcbiAgICAgICAgXCItU1wiLFxuICAgICAgICBcIi5cIixcbiAgICAgICAgXCItQlwiLFxuICAgICAgICBkaXJlY3RvcnksXG4gICAgICAgIFwiLUdcIixcbiAgICAgICAgXCJOaW5qYVwiLFxuICAgICAgICBcIi1EQ01BS0VfQlVJTERfVFlQRT1EZWJ1Z1wiLFxuICAgICAgICBcIi1EV09SS0JFTkNIX0xUTz1vZmZcIixcbiAgICAgICAgXCItRFdPUktCRU5DSF9DT1ZFUkFHRT1PRkZcIixcbiAgICAgICAgXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9GRlwiLFxuICAgICAgICBcIi1EV09SS0JFTkNIX1BPUlRBQkxFX09OTFk9T0ZGXCIsXG4gICAgICAgIC4uLihtYW5hZ2VkXG4gICAgICAgICAgPyBjb21waWxlckFyZ3VtZW50cyhjb21waWxlcilcbiAgICAgICAgICA6IFtgLURDTUFLRV9UT09MQ0hBSU5fRklMRT0ke2pvaW4oZGlyZWN0b3J5LCBcIndvcmtiZW5jaC12Y3BrZy5jbWFrZVwiKX1gXSksXG4gICAgICAgIC4uLigocHJvY2Vzcy5lbnZbbGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJXT1JLQkVOQ0hfQ19TVEFOREFSRFwiIDogXCJXT1JLQkVOQ0hfQ1hYX1NUQU5EQVJEXCJdID8/XG4gICAgICAgIHByb2Nlc3MuZW52LldPUktCRU5DSF9MQU5HVUFHRV9TVEFOREFSRClcbiAgICAgICAgICA/IFtcbiAgICAgICAgICAgICAgYC1EV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEPSR7cHJvY2Vzcy5lbnZbbGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJXT1JLQkVOQ0hfQ19TVEFOREFSRFwiIDogXCJXT1JLQkVOQ0hfQ1hYX1NUQU5EQVJEXCJdID8/IHByb2Nlc3MuZW52LldPUktCRU5DSF9MQU5HVUFHRV9TVEFOREFSRCA/PyBcIlwifWAsXG4gICAgICAgICAgICBdXG4gICAgICAgICAgOiBbXSksXG4gICAgICAgIGAtRFdPUktCRU5DSF9DT01QSUxFUl9GQU1JTFk9JHtjb21waWxlcn1gLFxuICAgICAgICBgLURXT1JLQkVOQ0hfQ09NUElMRVJfTUlOSU1VTT0ke2NvbXBpbGVyID09PSBzZWxlY3RlZENvbXBpbGVyID8gKHByb2Nlc3MuZW52LldPUktCRU5DSF9DT01QSUxFUl9NSU5JTVVNID8/IFwiXCIpIDogXCJcIn1gLFxuICAgICAgICAuLi4ocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiICYmIG9wdGlvbnMuaW5jbHVkZXMoXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCIpXG4gICAgICAgICAgPyBbXCItRENNQUtFX0JVSUxEX1RZUEU9UmVsV2l0aERlYkluZm9cIl1cbiAgICAgICAgICA6IFtdKSxcbiAgICAgICAgLi4ub3B0aW9ucyxcbiAgICAgIF0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb2xsZWN0Q01ha2VGYWlsdXJlTG9ncyhkaXJlY3RvcnkpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG4gIGZ1bmN0aW9uIHRlc3QoZGlyZWN0b3J5OiBzdHJpbmcsIHByb2ZpbGVzPzogc3RyaW5nKSB7XG4gICAgbWtkaXJTeW5jKFwiY292ZXJhZ2VcIiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3QgcmVzdWx0cyA9IGpvaW4ocm9vdCwgXCJjb3ZlcmFnZVwiLCBgdGVzdHMtJHtkaXJlY3Rvcnkuc2xpY2UoYnVpbGRzLmxlbmd0aCArIDEpLnJlcGxhY2VBbGwoc2VwLCBcIi1cIil9LnhtbGApO1xuICAgIHJ1bihcImNtYWtlXCIsIFtcIi0tYnVpbGRcIiwgZGlyZWN0b3J5LCBcIi0tcGFyYWxsZWxcIiwgcGFyYWxsZWxpc21dKTtcbiAgICBydW4oXCJjdGVzdFwiLCBbXCItLXRlc3QtZGlyXCIsIGRpcmVjdG9yeSwgXCItLW91dHB1dC1vbi1mYWlsdXJlXCIsIFwiLS1uby10ZXN0cz1lcnJvclwiLCBcIi0tb3V0cHV0LWp1bml0XCIsIHJlc3VsdHNdLCB7XG4gICAgICBlbnY6IHsgLi4ucHJvY2Vzcy5lbnYsIC4uLihwcm9maWxlcyA/IHsgTExWTV9QUk9GSUxFX0ZJTEU6IGpvaW4ocHJvZmlsZXMsIFwiJXAtJW0ucHJvZnJhd1wiKSB9IDoge30pIH0sXG4gICAgfSk7XG4gICAgY29uc3QgcmVwb3J0ID0gcmVhZEZpbGVTeW5jKHJlc3VsdHMsIFwidXRmOFwiKTtcbiAgICBmb3IgKGNvbnN0IG1hdGNoIG9mIHJlcG9ydC5tYXRjaEFsbCgvPHRlc3RjYXNlXFxiKFtePl0rKT4vZykpIHtcbiAgICAgIGFzc2VydC5vayhtYXRjaFsxXSwgXCJNaXNzaW5nIHRlc3RjYXNlIGF0dHJpYnV0ZXNcIik7XG4gICAgICBjb25zdCBuYW1lID0gL1xcYm5hbWU9XCIoW15cIl0rKVwiLy5leGVjKG1hdGNoWzFdKT8uWzFdO1xuICAgICAgY29uc3QgZWxhcHNlZCA9IE51bWJlcigvXFxidGltZT1cIihbXlwiXSspXCIvLmV4ZWMobWF0Y2hbMV0pPy5bMV0pO1xuICAgICAgaWYgKHJvbGUgIT09IFwiY292ZXJhZ2VcIiAmJiBlbGFwc2VkID4gcG9saWN5LnNsb3dfdGVzdF9zZWNvbmRzKSB7XG4gICAgICAgIGVtaXRDaGVja0RldGFpbCh7XG4gICAgICAgICAgdmVyc2lvbjogMSxcbiAgICAgICAgICBraW5kOiBcInNsb3dcIixcbiAgICAgICAgICBzY29wZTogXCJ0ZXN0XCIsXG4gICAgICAgICAgbmFtZTogU3RyaW5nKG5hbWUpLFxuICAgICAgICAgIGVsYXBzZWRTZWNvbmRzOiBlbGFwc2VkLFxuICAgICAgICAgIHRocmVzaG9sZFNlY29uZHM6IHBvbGljeS5zbG93X3Rlc3Rfc2Vjb25kcyxcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICAgICAgYFNMT1cgdGVzdCAke1N0cmluZyhuYW1lKX06ICR7U3RyaW5nKGVsYXBzZWQpfXMgKHNvZnQgY2FwICR7U3RyaW5nKHBvbGljeS5zbG93X3Rlc3Rfc2Vjb25kcyl9czsgYWR2aXNvcnkgb25seSlgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHZlcmlmeVJlbGVhc2UoZGlyZWN0b3J5OiBzdHJpbmcpIHtcbiAgICB0ZXN0KGRpcmVjdG9yeSk7XG4gICAgcnVuKHByb2Nlc3MuZXhlY1BhdGgsIFtqb2luKHJvb3QsIFwic2NyaXB0cy9yZWxlYXNlLXZlcmlmeS5tanNcIiksIGRpcmVjdG9yeV0pO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVqZWN0THRvKG5hbWU6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10sIGRpYWdub3N0aWM6IFJlZ0V4cCkge1xuICAgIC8vIFJldXNlIHRoZSB2ZXJpZmllZCBvZmYtbW9kZSBkZXBlbmRlbmN5IGluc3RhbGxhdGlvbiwgd2l0aG91dCByZWluc3RhbGxpbmcgZGVwZW5kZW5jaWVzLlxuICAgIGNvbnN0IHJlc3VsdDogaW1wb3J0KFwibm9kZTpjaGlsZF9wcm9jZXNzXCIpLlNwYXduU3luY1JldHVybnM8c3RyaW5nIHwgbnVsbD4gPSBzcGF3blN5bmMoXG4gICAgICBcImNtYWtlXCIsXG4gICAgICBbXG4gICAgICAgIFwiLVNcIixcbiAgICAgICAgXCIuXCIsXG4gICAgICAgIFwiLUJcIixcbiAgICAgICAgam9pbihidWlsZHMsIGBsdG8tcmVqZWN0LSR7bmFtZX1gKSxcbiAgICAgICAgXCItR1wiLFxuICAgICAgICBcIk5pbmphXCIsXG4gICAgICAgIC4uLihtYW5hZ2VkXG4gICAgICAgICAgPyBjb21waWxlckFyZ3VtZW50cygpXG4gICAgICAgICAgOiBbXG4gICAgICAgICAgICAgIGAtRENNQUtFX1RPT0xDSEFJTl9GSUxFPSR7am9pbihidWlsZHMsIFwibHRvLW9mZlwiLCBcIndvcmtiZW5jaC12Y3BrZy5jbWFrZVwiKX1gLFxuICAgICAgICAgICAgICBcIi1EVkNQS0dfTUFOSUZFU1RfSU5TVEFMTD1PRkZcIixcbiAgICAgICAgICAgIF0pLFxuICAgICAgICBcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxlYXNlXCIsXG4gICAgICAgIFwiLURXT1JLQkVOQ0hfTFRPPWZ1bGxcIixcbiAgICAgICAgLi4ub3B0aW9ucyxcbiAgICAgIF0sXG4gICAgICB7IGVuY29kaW5nOiBcInV0ZjhcIiB9LFxuICAgICk7XG4gICAgY29uc3Qgb3V0cHV0ID0gYCR7cmVzdWx0LnN0ZG91dCA/PyBcIlwifSR7cmVzdWx0LnN0ZGVyciA/PyBcIlwifWA7XG4gICAgaWYgKHJlc3VsdC5lcnJvciB8fCByZXN1bHQuc3RhdHVzID09PSBudWxsIHx8IHJlc3VsdC5zdGF0dXMgPT09IDAgfHwgIWRpYWdub3N0aWMudGVzdChvdXRwdXQpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBFeHBlY3RlZCBMVE8gcmVqZWN0aW9uIGZvciAke25hbWV9OiAke3Jlc3VsdC5lcnJvciA/PyBvdXRwdXR9YCk7XG4gICAgY29uc29sZS5sb2coYFZlcmlmaWVkIExUTyByZWplY3Rpb246ICR7bmFtZX1gKTtcbiAgfVxuXG4gIGlmIChyb2xlID09PSBcImZvcm1hdFwiIHx8IHJvbGUgPT09IFwiZm9ybWF0LXdyaXRlXCIpIHtcbiAgICBydW4oXCJjbGFuZy1mb3JtYXRcIiwgWy4uLihyb2xlID09PSBcImZvcm1hdFwiID8gW1wiLS1kcnktcnVuXCIsIFwiLS1XZXJyb3JcIl0gOiBbXCItaVwiXSksIC4uLnNvdXJjZXNdKTtcbiAgfSBlbHNlIGlmIChyb2xlID09PSBcImxpbnRcIikge1xuICAgIHJ1bihcImNsYW5nLXRpZHlcIiwgW1wiLS12ZXJpZnktY29uZmlnXCJdKTtcbiAgICBjb25zdCBhbmFseXNpcyA9IHNlbGVjdGVkQ29tcGlsZXIgPT09IFwiY2xhbmdcIiA/IGRlYnVnIDogam9pbihidWlsZHMsIFwiYW5hbHlzaXMtY2xhbmdcIik7XG4gICAgY29uZmlndXJlKGFuYWx5c2lzLCBbXSwgXCJjbGFuZ1wiKTtcbiAgICBydW4oXCJjbWFrZVwiLCBbXCItLWJ1aWxkXCIsIGFuYWx5c2lzLCBcIi0tcGFyYWxsZWxcIiwgcGFyYWxsZWxpc21dKTtcbiAgICBmb3IgKGNvbnN0IHNvdXJjZSBvZiBzb3VyY2VzLmZpbHRlcigoZmlsZSkgPT4gL1xcLig/OmN8Y3BwKSQvLnRlc3QoZmlsZSkpKVxuICAgICAgcnVuKFwiY2xhbmctdGlkeVwiLCBbXCItcFwiLCBhbmFseXNpcywgc291cmNlXSk7XG4gIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJidWlsZFwiIHx8IHJvbGUgPT09IFwicmVsZWFzZVwiKSB7XG4gICAgY29uc3QgZGlyZWN0b3J5ID0gcm9sZSA9PT0gXCJyZWxlYXNlXCIgPyBqb2luKGJ1aWxkcywgXCJyZWxlYXNlXCIpIDogZGVidWc7XG4gICAgY29uZmlndXJlKFxuICAgICAgZGlyZWN0b3J5LFxuICAgICAgcm9sZSA9PT0gXCJyZWxlYXNlXCIgPyBbXCItRENNQUtFX0JVSUxEX1RZUEU9UmVsZWFzZVwiLCBgLURXT1JLQkVOQ0hfTFRPPSR7cHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xUTyA/PyBcIm9mZlwifWBdIDogW10sXG4gICAgKTtcbiAgICBpZiAocm9sZSA9PT0gXCJyZWxlYXNlXCIpIHtcbiAgICAgIHZlcmlmeVJlbGVhc2UoZGlyZWN0b3J5KTtcbiAgICAgIGNvbnN0IG91dHB1dCA9IHJlc29sdmUocHJvY2Vzcy5lbnYuV09SS0JFTkNIX1JFTEVBU0VfT1VUUFVUID8/IHByb2Nlc3MuZW52LldPUktCRU5DSF9ESVNUX0RJUiA/PyBcImRpc3RcIik7XG4gICAgICBta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGNvcHlGaWxlU3luYyhqb2luKGRpcmVjdG9yeSwgYGNvdW50JHtzdWZmaXh9YCksIGpvaW4ob3V0cHV0LCBgY291bnQke3N1ZmZpeH1gKSk7XG4gICAgICBjb3B5RmlsZVN5bmMoXCJMSUNFTlNFXCIsIGpvaW4ob3V0cHV0LCBcIkxJQ0VOU0VcIikpO1xuICAgIH0gZWxzZSBydW4oXCJjbWFrZVwiLCBbXCItLWJ1aWxkXCIsIGRpcmVjdG9yeSwgXCItLXBhcmFsbGVsXCIsIHBhcmFsbGVsaXNtXSk7XG4gIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJsdG9cIikge1xuICAgIGZvciAoY29uc3QgbW9kZSBvZiBzZWxlY3RlZENvbXBpbGVyID09PSBcImNsYW5nXCIgPyBbXCJvZmZcIiwgXCJ0aGluXCIsIFwiZnVsbFwiXSA6IFtcIm9mZlwiLCBcImZ1bGxcIl0pIHtcbiAgICAgIGNvbnN0IGRpcmVjdG9yeSA9IGpvaW4oYnVpbGRzLCBgbHRvLSR7bW9kZX1gKTtcbiAgICAgIGNvbmZpZ3VyZShkaXJlY3RvcnksIFtcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxlYXNlXCIsIGAtRFdPUktCRU5DSF9MVE89JHttb2RlfWBdKTtcbiAgICAgIHZlcmlmeVJlbGVhc2UoZGlyZWN0b3J5KTtcbiAgICB9XG4gICAgcmVqZWN0THRvKFwiaW52YWxpZFwiLCBbXCItRFdPUktCRU5DSF9MVE89dW5rbm93blwiXSwgL211c3Qgc2VsZWN0IG9mZiwgdGhpbiwgb3IgZnVsbC8pO1xuICAgIHJlamVjdEx0byhcImRlYnVnXCIsIFtcIi1EQ01BS0VfQlVJTERfVFlQRT1EZWJ1Z1wiXSwgL3NlcGFyYXRlIG9wdGltaXplZCBzaW5nbGUtY29uZmlndXJhdGlvbiBidWlsZC8pO1xuICAgIHJlamVjdEx0byhcImNvdmVyYWdlXCIsIFtcIi1EV09SS0JFTkNIX0NPVkVSQUdFPU9OXCJdLCAvc2VwYXJhdGUgTFRPIGJ1aWxkIGZyb20gY292ZXJhZ2UgYW5kIHNhbml0aXplcnMvKTtcbiAgICByZWplY3RMdG8oXCJzYW5pdGl6ZXJzXCIsIFtcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIl0sIC9zZXBhcmF0ZSBMVE8gYnVpbGQgZnJvbSBjb3ZlcmFnZSBhbmQgc2FuaXRpemVycy8pO1xuICAgIGlmIChzZWxlY3RlZENvbXBpbGVyICE9PSBcImNsYW5nXCIpXG4gICAgICByZWplY3RMdG8oXCJ0aGluXCIsIFtcIi1EV09SS0JFTkNIX0xUTz10aGluXCJdLCAvZG9lcyBub3Qgc3VwcG9ydCB0aGUgcmVxdWVzdGVkIExUTyBtb2RlLyk7XG4gICAgZWxzZSByZWplY3RMdG8oXCJ0b29sLXZlcnNpb25cIiwgW2AtRGx0b19saW5rZXI9JHtwcm9jZXNzLmV4ZWNQYXRofWBdLCAvbXVzdCBtYXRjaCBDbGFuZy8pO1xuICB9IGVsc2UgaWYgKHJvbGUgPT09IFwidGVzdFwiKSB7XG4gICAgY29uZmlndXJlKGRlYnVnKTtcbiAgICB0ZXN0KGRlYnVnKTtcbiAgfSBlbHNlIGlmIChyb2xlID09PSBcImNvdmVyYWdlXCIpIHtcbiAgICBpZiAoZXhpc3RzU3luYyhcImNvdmVyYWdlXCIpICYmIGxzdGF0U3luYyhcImNvdmVyYWdlXCIpLmlzU3ltYm9saWNMaW5rKCkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJjb3ZlcmFnZSBtdXN0IGJlIGEgcmVhbCBkaXJlY3RvcnlcIik7XG4gICAgbWtkaXJTeW5jKFwiY292ZXJhZ2VcIiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIHJlYWRkaXJTeW5jKFwiY292ZXJhZ2VcIikpXG4gICAgICBpZiAobmFtZSAhPT0gXCJjb3ZlcmFnZS1zdW1tYXJ5Lmpzb25cIikgcm1TeW5jKGpvaW4oXCJjb3ZlcmFnZVwiLCBuYW1lKSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIGlmIChzZWxlY3RlZENvbXBpbGVyICE9PSBcImNsYW5nXCIpIHtcbiAgICAgIGNvbmZpZ3VyZShkZWJ1Zyk7XG4gICAgICB0ZXN0KGRlYnVnKTtcbiAgICB9XG4gICAgY29uc3QgaW5zdHJ1bWVudGVkID0gam9pbihidWlsZHMsIFwiY292ZXJhZ2VcIik7XG4gICAgY29uZmlndXJlKGluc3RydW1lbnRlZCwgW1wiLURXT1JLQkVOQ0hfQ09WRVJBR0U9T05cIl0sIFwiY2xhbmdcIik7XG4gICAgY29uc3QgdGVtcG9yYXJ5ID0gbWtkdGVtcFN5bmMoam9pbihpbnN0cnVtZW50ZWQsIFwicHJvZmlsZXMtXCIpKTtcbiAgICB0cnkge1xuICAgICAgdGVzdChpbnN0cnVtZW50ZWQsIHRlbXBvcmFyeSk7XG4gICAgICBjb25zdCBwcm9maWxlcyA9IGZpbGVzKHRlbXBvcmFyeSkuZmlsdGVyKChmaWxlOiBzdHJpbmcpID0+IGZpbGUuZW5kc1dpdGgoXCIucHJvZnJhd1wiKSk7XG4gICAgICBpZiAoIXByb2ZpbGVzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiY292ZXJhZ2UgcHJvZHVjZWQgbm8gZXhlY3V0aW9uIHByb2ZpbGVzXCIpO1xuICAgICAgY29uc3QgbWVyZ2VkID0gam9pbih0ZW1wb3JhcnksIFwibWVyZ2VkLnByb2ZkYXRhXCIpO1xuICAgICAgcnVuKFwibGx2bS1wcm9mZGF0YVwiLCBbXCJtZXJnZVwiLCBcIi1zcGFyc2VcIiwgLi4ucHJvZmlsZXMsIFwiLW9cIiwgbWVyZ2VkXSk7XG4gICAgICBjb25zdCBzb3VyY2VGaWxlcyA9IHNvdXJjZXMuZmlsdGVyKChmaWxlKSA9PiAhZmlsZS5zdGFydHNXaXRoKGB0ZXN0cyR7c2VwfWApKTtcbiAgICAgIGNvbnN0IGNvdmVyYWdlQXJncyA9IFtcbiAgICAgICAgam9pbihpbnN0cnVtZW50ZWQsIGBjb3VudF90ZXN0JHtzdWZmaXh9YCksXG4gICAgICAgIFwiLW9iamVjdFwiLFxuICAgICAgICBqb2luKGluc3RydW1lbnRlZCwgYGNvdW50JHtzdWZmaXh9YCksXG4gICAgICAgIFwiLW9iamVjdFwiLFxuICAgICAgICBqb2luKGluc3RydW1lbnRlZCwgYGNwdV90ZXN0JHtzdWZmaXh9YCksXG4gICAgICAgIGAtaW5zdHItcHJvZmlsZT0ke21lcmdlZH1gLFxuICAgICAgICAuLi5zb3VyY2VGaWxlcyxcbiAgICAgIF07XG4gICAgICBydW4oXCJsbHZtLWNvdlwiLCBbXCJyZXBvcnRcIiwgLi4uY292ZXJhZ2VBcmdzXSk7XG4gICAgICBjb25zdCByZXBvcnQgPSBKU09OLnBhcnNlKHJ1bihcImxsdm0tY292XCIsIFtcImV4cG9ydFwiLCAuLi5jb3ZlcmFnZUFyZ3NdLCB7IHN0ZGlvOiBcInBpcGVcIiB9KSkgYXMge1xuICAgICAgICBkYXRhOiB7IHRvdGFsczogUmVjb3JkPHN0cmluZywgeyBjb3VudDogbnVtYmVyOyBwZXJjZW50OiBudW1iZXIgfT4gfVtdO1xuICAgICAgfTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoXCJjb3ZlcmFnZS9yZXBvcnQuanNvblwiLCBKU09OLnN0cmluZ2lmeShyZXBvcnQpKTtcbiAgICAgIGFzc2VydC5vayhyZXBvcnQuZGF0YVswXSwgXCJMTFZNIGNvdmVyYWdlIGRpZCBub3QgcmVwb3J0IHRvdGFsc1wiKTtcbiAgICAgIGNvbnN0IHRvdGFsID0gcmVwb3J0LmRhdGFbMF0udG90YWxzO1xuICAgICAgZm9yIChjb25zdCBbbWV0cmljLCBtaW5pbXVtXSBvZiBPYmplY3QuZW50cmllcyhwb2xpY3kuY292ZXJhZ2UpKSB7XG4gICAgICAgIGlmICghdG90YWxbbWV0cmljXSB8fCB0b3RhbFttZXRyaWNdLmNvdW50ID09PSAwIHx8IHRvdGFsW21ldHJpY10ucGVyY2VudCA8IG1pbmltdW0pXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYCR7bWV0cmljfSBjb3ZlcmFnZSAke1N0cmluZyh0b3RhbFttZXRyaWNdPy5wZXJjZW50ID8/IFwibWlzc2luZ1wiKX0lIGlzIGJlbG93ICR7U3RyaW5nKG1pbmltdW0pfSVgLFxuICAgICAgICAgICk7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wb3JhcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJzYW5pdGl6ZXJzXCIpIHtcbiAgICBjb25maWd1cmUoam9pbihidWlsZHMsIFwiYXNhblwiKSwgW1wiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiXSk7XG4gICAgdGVzdChqb2luKGJ1aWxkcywgXCJhc2FuXCIpKTtcbiAgICBjb25maWd1cmUoam9pbihidWlsZHMsIFwicG9ydGFibGVcIiksIFtcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIiwgXCItRFdPUktCRU5DSF9QT1JUQUJMRV9PTkxZPU9OXCJdKTtcbiAgICB0ZXN0KGpvaW4oYnVpbGRzLCBcInBvcnRhYmxlXCIpKTtcbiAgfSBlbHNlIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJleHBlY3RlZCBidWlsZCwgcmVsZWFzZSwgZm9ybWF0LCBmb3JtYXQtd3JpdGUsIGxpbnQsIHRlc3QsIGNvdmVyYWdlLCBzYW5pdGl6ZXJzLCBvciBsdG9cIik7XG4gIH1cbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sWUFBWTtBQUNuQixTQUFnQyxpQkFBaUI7QUFFakQ7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxNQUFNLFVBQVUsU0FBUyxXQUFXO0FBQzdDLFNBQVMscUJBQXFCO0FBRTlCLFNBQVMsaUJBQWlCLHdCQUE2QztBQUV2RSxlQUFzQixnQkFBZ0IsVUFBdUIsY0FBc0IsTUFBNkI7QUFDOUcsUUFBTSxPQUFPLFFBQVEsSUFBSTtBQUN6QixRQUFNLEVBQUUsVUFBVSxJQUFLLE1BQU0sT0FDM0IsY0FBYyxLQUFLLGNBQWMsd0JBQXdCLENBQUMsRUFBRTtBQUc5RCxRQUFNLEVBQUUsZ0JBQWdCLElBQUssTUFBTSxPQUNqQyxjQUFjLEtBQUssY0FBYywrQkFBK0IsQ0FBQyxFQUFFO0FBRXJFLFFBQU0sbUJBQW1CLFFBQVEsSUFBSTtBQUNyQyxNQUFJLENBQUMsaUJBQWtCLE9BQU0sSUFBSSxNQUFNLHdFQUF3RTtBQUMvRyxRQUFNLFNBQVM7QUFDZixRQUFNLFFBQVEsS0FBSyxRQUFRLE9BQU87QUFDbEMsUUFBTSxTQUFTLEtBQUssTUFBTSxhQUFhLDBCQUEwQixNQUFNLENBQUM7QUFJeEUs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QUFPLFFBQVEsR0FBRztBQUMvRCxZQUFJLENBQUMsTUFBTSxNQUFNLEtBQUssTUFBTSxNQUFNLEVBQUUsVUFBVSxLQUFLLE1BQU0sTUFBTSxFQUFFLFVBQVU7QUFDekUsZ0JBQU0sSUFBSTtBQUFBLFlBQ1IsR0FBRyxNQUFNLGFBQWEsT0FBTyxNQUFNLE1BQU0sR0FBRyxXQUFXLFNBQVMsQ0FBQyxjQUFjLE9BQU8sT0FBTyxDQUFDO0FBQUEsVUFDaEc7QUFBQSxNQUNKO0FBQUEsSUFDRixVQUFFO0FBQ0EsYUFBTyxXQUFXLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDcEQ7QUFBQSxFQUNGLFdBQVcsU0FBUyxjQUFjO0FBQ2hDLGNBQVUsS0FBSyxRQUFRLE1BQU0sR0FBRyxDQUFDLDJCQUEyQixDQUFDO0FBQzdELFNBQUssS0FBSyxRQUFRLE1BQU0sQ0FBQztBQUN6QixjQUFVLEtBQUssUUFBUSxVQUFVLEdBQUcsQ0FBQyw2QkFBNkIsOEJBQThCLENBQUM7QUFDakcsU0FBSyxLQUFLLFFBQVEsVUFBVSxDQUFDO0FBQUEsRUFDL0IsT0FBTztBQUNMLFVBQU0sSUFBSSxNQUFNLHlGQUF5RjtBQUFBLEVBQzNHO0FBQ0Y7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9uYXRpdmUtYy1jaGVja3MubWpzIn0=
