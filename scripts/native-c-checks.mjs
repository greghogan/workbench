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
    const buildtrees = join(directory, "vcpkg_buildtrees");
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
    configure(join(builds, "sanitizers"), ["-DWORKBENCH_SANITIZERS=ON"]);
    test(join(builds, "sanitizers"));
    configure(join(builds, "portable"), ["-DWORKBENCH_SANITIZERS=ON", "-DWORKBENCH_PORTABLE_ONLY=ON"]);
    test(join(builds, "portable"));
  } else {
    throw new Error("expected build, release, format, format-write, lint, test, coverage, sanitizers, or lto");
  }
}
export {
  runNativeChecks
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5hdGl2ZS1jLWNoZWNrcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyB0eXBlIFNwYXduU3luY09wdGlvbnMsIHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbHN0YXRTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICBta2RpclN5bmMsXG4gIG1rZHRlbXBTeW5jLFxuICBybVN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG4gIGNvcHlGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5cbmltcG9ydCB7IGNvbXBpbGVyQ2F0YWxvZywgaXNDb21waWxlckZhbWlseSwgdHlwZSBDb21waWxlckZhbWlseSB9IGZyb20gXCIuL2NvbXBpbGVyLWNhdGFsb2cubWpzXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5OYXRpdmVDaGVja3MobGFuZ3VhZ2U6IFwiY1wiIHwgXCJjcHBcIiwgZGlzdHJpYnV0aW9uOiBzdHJpbmcsIHJvbGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByb290ID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgeyBjcHVCdWRnZXQgfSA9IChhd2FpdCBpbXBvcnQoXG4gICAgcGF0aFRvRmlsZVVSTChqb2luKGRpc3RyaWJ1dGlvbiwgXCJzY3JpcHRzL2NwdS1idWRnZXQubWpzXCIpKS5ocmVmXG4gICkpIGFzIHR5cGVvZiBpbXBvcnQoXCIuL2NwdS1idWRnZXQubWpzXCIpO1xuXG4gIGNvbnN0IHsgZW1pdENoZWNrRGV0YWlsIH0gPSAoYXdhaXQgaW1wb3J0KFxuICAgIHBhdGhUb0ZpbGVVUkwoam9pbihkaXN0cmlidXRpb24sIFwic2NyaXB0cy9jaGVjay1kZXRhaWwtZGF0YS5tanNcIikpLmhyZWZcbiAgKSkgYXMgdHlwZW9mIGltcG9ydChcIi4vY2hlY2stZGV0YWlsLWRhdGEubWpzXCIpO1xuICBjb25zdCBjb25maWd1cmVkQnVpbGRzID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0JVSUxEX0RJUjtcbiAgaWYgKCFjb25maWd1cmVkQnVpbGRzKSB0aHJvdyBuZXcgRXJyb3IoXCJ1c2UgV29ya2JlbmNoIGNoZWNrcyBvciBhIGNvbmZpZ3VyZWQgV29ya2JlbmNoIHNoZWxsIGZvciBuYXRpdmUgYnVpbGRzXCIpO1xuICBjb25zdCBidWlsZHMgPSBjb25maWd1cmVkQnVpbGRzO1xuICBjb25zdCBkZWJ1ZyA9IGpvaW4oYnVpbGRzLCBcImRlYnVnXCIpO1xuICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhcIndvcmtiZW5jaC9xdWFsaXR5Lmpzb25cIiwgXCJ1dGY4XCIpKSBhcyB7XG4gICAgc2xvd190ZXN0X3NlY29uZHM6IG51bWJlcjtcbiAgICBjb3ZlcmFnZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbiAgfTtcbiAgY29uc3Qgc3VmZml4ID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCIuZXhlXCIgOiBcIlwiO1xuICBjb25zdCByZXF1ZXN0ZWRDb21waWxlciA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9DT01QSUxFUiA/PyBcImNsYW5nXCI7XG4gIGlmICghaXNDb21waWxlckZhbWlseShyZXF1ZXN0ZWRDb21waWxlcikpIHRocm93IG5ldyBFcnJvcihcIlNlbGVjdCBhIGRlY2xhcmVkIG5hdGl2ZSBjb21waWxlclwiKTtcbiAgY29uc3Qgc2VsZWN0ZWRDb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSByZXF1ZXN0ZWRDb21waWxlcjtcbiAgY29uc3QgbWFuYWdlZCA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0NPTVBJTEVSID09PSBcIjFcIjtcbiAgY29uc3QgcGFyYWxsZWxpc20gPSBTdHJpbmcoY3B1QnVkZ2V0KCkpO1xuICBwcm9jZXNzLmVudi5DVEVTVF9QQVJBTExFTF9MRVZFTCA9IHBhcmFsbGVsaXNtO1xuICBmdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSA9IFtdLCBvcHRpb25zOiBPbWl0PFNwYXduU3luY09wdGlvbnMsIFwiZW5jb2RpbmdcIj4gPSB7fSkge1xuICAgIGNvbnN0IHJlc3VsdDogaW1wb3J0KFwibm9kZTpjaGlsZF9wcm9jZXNzXCIpLlNwYXduU3luY1JldHVybnM8c3RyaW5nIHwgbnVsbD4gPSBzcGF3blN5bmMoY29tbWFuZCwgYXJncywge1xuICAgICAgZW5jb2Rpbmc6IFwidXRmOFwiLFxuICAgICAgc3RkaW86IFwiaW5oZXJpdFwiLFxuICAgICAgLi4ub3B0aW9ucyxcbiAgICB9KTtcbiAgICBpZiAocmVzdWx0LmVycm9yIHx8IHJlc3VsdC5zdGF0dXMgIT09IDApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhyZXN1bHQuZXJyb3IgPz8gcmVzdWx0LnN0YXR1cyl9YCk7XG4gICAgcmV0dXJuIHJlc3VsdC5zdGRvdXQgPz8gXCJcIjtcbiAgfVxuICBmdW5jdGlvbiBjb2xsZWN0Q01ha2VGYWlsdXJlTG9ncyhkaXJlY3Rvcnk6IHN0cmluZykge1xuICAgIGNvbnN0IGJ1aWxkdHJlZXMgPSBqb2luKGRpcmVjdG9yeSwgXCJ2Y3BrZ19idWlsZHRyZWVzXCIpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBvdXRwdXQgPSBqb2luKHJvb3QsIFwiY292ZXJhZ2VcIiwgXCJjbWFrZVwiLCByZWxhdGl2ZShidWlsZHMsIGRpcmVjdG9yeSkucmVwbGFjZUFsbChzZXAsIFwiLVwiKSk7XG4gICAgICBjb25zdCBwb3J0TG9ncyA9IGV4aXN0c1N5bmMoYnVpbGR0cmVlcylcbiAgICAgICAgPyBmaWxlcyhidWlsZHRyZWVzKS5maWx0ZXIoKHBhdGgpID0+IHBhdGguZW5kc1dpdGgoXCIubG9nXCIpICYmIGxzdGF0U3luYyhwYXRoKS5pc0ZpbGUoKSlcbiAgICAgICAgOiBbXTtcbiAgICAgIGZvciAoY29uc3QgcGF0aCBvZiBwb3J0TG9ncykge1xuICAgICAgICBjb25zdCBkZXN0aW5hdGlvbiA9IGpvaW4ob3V0cHV0LCBcInZjcGtnX2J1aWxkdHJlZXNcIiwgcmVsYXRpdmUoYnVpbGR0cmVlcywgcGF0aCkpO1xuICAgICAgICBta2RpclN5bmMoam9pbihkZXN0aW5hdGlvbiwgXCIuLlwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgIGNvcHlGaWxlU3luYyhwYXRoLCBkZXN0aW5hdGlvbik7XG4gICAgICAgIGlmICgvLShvdXR8ZXJyKVxcLmxvZyQvLnRlc3QocGF0aCkpXG4gICAgICAgICAgY29uc29sZS5lcnJvcihgJHtwYXRofVxcbiR7cmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKS5zbGljZSgtODE5Mikuc3BsaXQoL1xccj9cXG4vKS5zbGljZSgtNDApLmpvaW4oXCJcXG5cIil9YCk7XG4gICAgICB9XG4gICAgICAvLyBDb21waWxlciBkZXRlY3Rpb24gY2FuIHN1Y2NlZWQgYmVmb3JlIGEgZGVwZW5kZW5jeSBmYWlscy4gUHJlc2VydmUgdGhlIG1hbmlmZXN0J3MgYWN0dWFsIGVycm9yLFxuICAgICAgLy8gYW5kIHByaW50IGl0IGxhc3Qgc28gYm91bmRlZCB0ZXJtaW5hbCBleGNlcnB0cyByZXRhaW4gdGhlIGNhdXNlIHJhdGhlciB0aGFuIGNvbXBpbGVyIHdhcm5pbmdzLlxuICAgICAgY29uc3QgbWFuaWZlc3QgPSBqb2luKGRpcmVjdG9yeSwgXCJ2Y3BrZy1tYW5pZmVzdC1pbnN0YWxsLmxvZ1wiKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKG1hbmlmZXN0KSAmJiBsc3RhdFN5bmMobWFuaWZlc3QpLmlzRmlsZSgpKSB7XG4gICAgICAgIG1rZGlyU3luYyhvdXRwdXQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICBjb3B5RmlsZVN5bmMobWFuaWZlc3QsIGpvaW4ob3V0cHV0LCBcInZjcGtnLW1hbmlmZXN0LWluc3RhbGwubG9nXCIpKTtcbiAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICBgJHttYW5pZmVzdH1cXG4ke3JlYWRGaWxlU3luYyhtYW5pZmVzdCwgXCJ1dGY4XCIpLnNsaWNlKC04MTkyKS5zcGxpdCgvXFxyP1xcbi8pLnNsaWNlKC00MCkuam9pbihcIlxcblwiKX1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHBvcnRMb2dzLmxlbmd0aCB8fCBleGlzdHNTeW5jKG1hbmlmZXN0KSkgY29uc29sZS5lcnJvcihgQ01ha2UgZmFpbHVyZSBsb2dzOiAke291dHB1dH1gKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc29sZS5lcnJvcihgQ291bGQgbm90IHJldGFpbiBDTWFrZSBmYWlsdXJlIGxvZ3M6ICR7U3RyaW5nKGVycm9yKX1gKTtcbiAgICB9XG4gIH1cbiAgZnVuY3Rpb24gZmlsZXMoZGlyZWN0b3J5OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcmVjdG9yeSwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pLmZsYXRNYXAoKGVudHJ5KSA9PlxuICAgICAgZW50cnkuaXNEaXJlY3RvcnkoKSA/IGZpbGVzKGpvaW4oZGlyZWN0b3J5LCBlbnRyeS5uYW1lKSkgOiBbam9pbihkaXJlY3RvcnksIGVudHJ5Lm5hbWUpXSxcbiAgICApO1xuICB9XG4gIGNvbnN0IHNvdXJjZXMgPSBbXCJzcmNcIiwgXCJpbmNsdWRlXCIsIFwidGVzdHNcIl0uZmxhdE1hcChmaWxlcykuZmlsdGVyKChmaWxlKSA9PiAvXFwuKD86Y3xjcHB8aHxocHApJC8udGVzdChmaWxlKSk7XG4gIGZ1bmN0aW9uIGNvbXBpbGVyQXJndW1lbnRzKGNvbXBpbGVyOiBDb21waWxlckZhbWlseSA9IHNlbGVjdGVkQ29tcGlsZXIpIHtcbiAgICBjb25zdCBleGVjdXRhYmxlID1cbiAgICAgIGNvbXBpbGVyID09PSBzZWxlY3RlZENvbXBpbGVyID8gcHJvY2Vzcy5lbnZbbGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJXT1JLQkVOQ0hfQ0NcIiA6IFwiV09SS0JFTkNIX0NYWFwiXSA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gW1xuICAgICAgYC1EQ01BS0VfJHtsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIkNcIiA6IFwiQ1hYXCJ9X0NPTVBJTEVSPSR7ZXhlY3V0YWJsZSA/PyBjb21waWxlckNhdGFsb2dbY29tcGlsZXJdLmV4ZWN1dGFibGVzW2xhbmd1YWdlXX1gLFxuICAgIF07XG4gIH1cbiAgZnVuY3Rpb24gY29uZmlndXJlKGRpcmVjdG9yeTogc3RyaW5nLCBvcHRpb25zOiBzdHJpbmdbXSA9IFtdLCBjb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSBzZWxlY3RlZENvbXBpbGVyKSB7XG4gICAgaWYgKCFtYW5hZ2VkKSB7XG4gICAgICBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW1xuICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgXCJ2Y3BrZy1wcmVwYXJlXCIsXG4gICAgICAgIHJvb3QsXG4gICAgICAgIGRpcmVjdG9yeSxcbiAgICAgICAgXCItLWNvbXBpbGVyXCIsXG4gICAgICAgIGNvbXBpbGVyLFxuICAgICAgICAuLi4ob3B0aW9ucy5pbmNsdWRlcyhcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIikgPyBbXCItLXNhbml0aXplcnNcIl0gOiBbXSksXG4gICAgICBdKTtcbiAgICAgIHByb2Nlc3MuZW52LlZDUEtHX0RJU0FCTEVfTUVUUklDUyA9IFwiMVwiO1xuICAgICAgcHJvY2Vzcy5lbnYuVkNQS0dfRk9SQ0VfU1lTVEVNX0JJTkFSSUVTID0gXCIxXCI7XG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuVkNQS0dfRk9SQ0VfRE9XTkxPQURFRF9CSU5BUklFUztcbiAgICAgIHByb2Nlc3MuZW52LlZDUEtHX01BWF9DT05DVVJSRU5DWSA9IHBhcmFsbGVsaXNtO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgcnVuKFwiY21ha2VcIiwgW1xuICAgICAgICBcIi1TXCIsXG4gICAgICAgIFwiLlwiLFxuICAgICAgICBcIi1CXCIsXG4gICAgICAgIGRpcmVjdG9yeSxcbiAgICAgICAgXCItR1wiLFxuICAgICAgICBcIk5pbmphXCIsXG4gICAgICAgIFwiLURDTUFLRV9CVUlMRF9UWVBFPURlYnVnXCIsXG4gICAgICAgIFwiLURXT1JLQkVOQ0hfTFRPPW9mZlwiLFxuICAgICAgICBcIi1EV09SS0JFTkNIX0NPVkVSQUdFPU9GRlwiLFxuICAgICAgICBcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T0ZGXCIsXG4gICAgICAgIFwiLURXT1JLQkVOQ0hfUE9SVEFCTEVfT05MWT1PRkZcIixcbiAgICAgICAgLi4uKG1hbmFnZWRcbiAgICAgICAgICA/IGNvbXBpbGVyQXJndW1lbnRzKGNvbXBpbGVyKVxuICAgICAgICAgIDogW2AtRENNQUtFX1RPT0xDSEFJTl9GSUxFPSR7am9pbihkaXJlY3RvcnksIFwid29ya2JlbmNoLXZjcGtnLmNtYWtlXCIpfWBdKSxcbiAgICAgICAgLi4uKChwcm9jZXNzLmVudltsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIldPUktCRU5DSF9DX1NUQU5EQVJEXCIgOiBcIldPUktCRU5DSF9DWFhfU1RBTkRBUkRcIl0gPz9cbiAgICAgICAgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEKVxuICAgICAgICAgID8gW1xuICAgICAgICAgICAgICBgLURXT1JLQkVOQ0hfTEFOR1VBR0VfU1RBTkRBUkQ9JHtwcm9jZXNzLmVudltsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIldPUktCRU5DSF9DX1NUQU5EQVJEXCIgOiBcIldPUktCRU5DSF9DWFhfU1RBTkRBUkRcIl0gPz8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEID8/IFwiXCJ9YCxcbiAgICAgICAgICAgIF1cbiAgICAgICAgICA6IFtdKSxcbiAgICAgICAgYC1EV09SS0JFTkNIX0NPTVBJTEVSX0ZBTUlMWT0ke2NvbXBpbGVyfWAsXG4gICAgICAgIGAtRFdPUktCRU5DSF9DT01QSUxFUl9NSU5JTVVNPSR7Y29tcGlsZXIgPT09IHNlbGVjdGVkQ29tcGlsZXIgPyAocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NPTVBJTEVSX01JTklNVU0gPz8gXCJcIikgOiBcIlwifWAsXG4gICAgICAgIC4uLihwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgJiYgb3B0aW9ucy5pbmNsdWRlcyhcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIilcbiAgICAgICAgICA/IFtcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxXaXRoRGViSW5mb1wiXVxuICAgICAgICAgIDogW10pLFxuICAgICAgICAuLi5vcHRpb25zLFxuICAgICAgXSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbGxlY3RDTWFrZUZhaWx1cmVMb2dzKGRpcmVjdG9yeSk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbiAgZnVuY3Rpb24gdGVzdChkaXJlY3Rvcnk6IHN0cmluZywgcHJvZmlsZXM/OiBzdHJpbmcpIHtcbiAgICBta2RpclN5bmMoXCJjb3ZlcmFnZVwiLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCByZXN1bHRzID0gam9pbihyb290LCBcImNvdmVyYWdlXCIsIGB0ZXN0cy0ke2RpcmVjdG9yeS5zbGljZShidWlsZHMubGVuZ3RoICsgMSkucmVwbGFjZUFsbChzZXAsIFwiLVwiKX0ueG1sYCk7XG4gICAgcnVuKFwiY21ha2VcIiwgW1wiLS1idWlsZFwiLCBkaXJlY3RvcnksIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICAgIHJ1bihcImN0ZXN0XCIsIFtcIi0tdGVzdC1kaXJcIiwgZGlyZWN0b3J5LCBcIi0tb3V0cHV0LW9uLWZhaWx1cmVcIiwgXCItLW5vLXRlc3RzPWVycm9yXCIsIFwiLS1vdXRwdXQtanVuaXRcIiwgcmVzdWx0c10sIHtcbiAgICAgIGVudjogeyAuLi5wcm9jZXNzLmVudiwgLi4uKHByb2ZpbGVzID8geyBMTFZNX1BST0ZJTEVfRklMRTogam9pbihwcm9maWxlcywgXCIlcC0lbS5wcm9mcmF3XCIpIH0gOiB7fSkgfSxcbiAgICB9KTtcbiAgICBjb25zdCByZXBvcnQgPSByZWFkRmlsZVN5bmMocmVzdWx0cywgXCJ1dGY4XCIpO1xuICAgIGZvciAoY29uc3QgbWF0Y2ggb2YgcmVwb3J0Lm1hdGNoQWxsKC88dGVzdGNhc2VcXGIoW14+XSspPi9nKSkge1xuICAgICAgYXNzZXJ0Lm9rKG1hdGNoWzFdLCBcIk1pc3NpbmcgdGVzdGNhc2UgYXR0cmlidXRlc1wiKTtcbiAgICAgIGNvbnN0IG5hbWUgPSAvXFxibmFtZT1cIihbXlwiXSspXCIvLmV4ZWMobWF0Y2hbMV0pPy5bMV07XG4gICAgICBjb25zdCBlbGFwc2VkID0gTnVtYmVyKC9cXGJ0aW1lPVwiKFteXCJdKylcIi8uZXhlYyhtYXRjaFsxXSk/LlsxXSk7XG4gICAgICBpZiAocm9sZSAhPT0gXCJjb3ZlcmFnZVwiICYmIGVsYXBzZWQgPiBwb2xpY3kuc2xvd190ZXN0X3NlY29uZHMpIHtcbiAgICAgICAgZW1pdENoZWNrRGV0YWlsKHtcbiAgICAgICAgICB2ZXJzaW9uOiAxLFxuICAgICAgICAgIGtpbmQ6IFwic2xvd1wiLFxuICAgICAgICAgIHNjb3BlOiBcInRlc3RcIixcbiAgICAgICAgICBuYW1lOiBTdHJpbmcobmFtZSksXG4gICAgICAgICAgZWxhcHNlZFNlY29uZHM6IGVsYXBzZWQsXG4gICAgICAgICAgdGhyZXNob2xkU2Vjb25kczogcG9saWN5LnNsb3dfdGVzdF9zZWNvbmRzLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICBgU0xPVyB0ZXN0ICR7U3RyaW5nKG5hbWUpfTogJHtTdHJpbmcoZWxhcHNlZCl9cyAoc29mdCBjYXAgJHtTdHJpbmcocG9saWN5LnNsb3dfdGVzdF9zZWNvbmRzKX1zOyBhZHZpc29yeSBvbmx5KWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gdmVyaWZ5UmVsZWFzZShkaXJlY3Rvcnk6IHN0cmluZykge1xuICAgIHRlc3QoZGlyZWN0b3J5KTtcbiAgICBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4ocm9vdCwgXCJzY3JpcHRzL3JlbGVhc2UtdmVyaWZ5Lm1qc1wiKSwgZGlyZWN0b3J5XSk7XG4gIH1cblxuICBmdW5jdGlvbiByZWplY3RMdG8obmFtZTogc3RyaW5nLCBvcHRpb25zOiBzdHJpbmdbXSwgZGlhZ25vc3RpYzogUmVnRXhwKSB7XG4gICAgLy8gUmV1c2UgdGhlIHZlcmlmaWVkIG9mZi1tb2RlIGRlcGVuZGVuY3kgaW5zdGFsbGF0aW9uLCB3aXRob3V0IHJlaW5zdGFsbGluZyBkZXBlbmRlbmNpZXMuXG4gICAgY29uc3QgcmVzdWx0OiBpbXBvcnQoXCJub2RlOmNoaWxkX3Byb2Nlc3NcIikuU3Bhd25TeW5jUmV0dXJuczxzdHJpbmcgfCBudWxsPiA9IHNwYXduU3luYyhcbiAgICAgIFwiY21ha2VcIixcbiAgICAgIFtcbiAgICAgICAgXCItU1wiLFxuICAgICAgICBcIi5cIixcbiAgICAgICAgXCItQlwiLFxuICAgICAgICBqb2luKGJ1aWxkcywgYGx0by1yZWplY3QtJHtuYW1lfWApLFxuICAgICAgICBcIi1HXCIsXG4gICAgICAgIFwiTmluamFcIixcbiAgICAgICAgLi4uKG1hbmFnZWRcbiAgICAgICAgICA/IGNvbXBpbGVyQXJndW1lbnRzKClcbiAgICAgICAgICA6IFtcbiAgICAgICAgICAgICAgYC1EQ01BS0VfVE9PTENIQUlOX0ZJTEU9JHtqb2luKGJ1aWxkcywgXCJsdG8tb2ZmXCIsIFwid29ya2JlbmNoLXZjcGtnLmNtYWtlXCIpfWAsXG4gICAgICAgICAgICAgIFwiLURWQ1BLR19NQU5JRkVTVF9JTlNUQUxMPU9GRlwiLFxuICAgICAgICAgICAgXSksXG4gICAgICAgIFwiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIixcbiAgICAgICAgXCItRFdPUktCRU5DSF9MVE89ZnVsbFwiLFxuICAgICAgICAuLi5vcHRpb25zLFxuICAgICAgXSxcbiAgICAgIHsgZW5jb2Rpbmc6IFwidXRmOFwiIH0sXG4gICAgKTtcbiAgICBjb25zdCBvdXRwdXQgPSBgJHtyZXN1bHQuc3Rkb3V0ID8/IFwiXCJ9JHtyZXN1bHQuc3RkZXJyID8/IFwiXCJ9YDtcbiAgICBpZiAocmVzdWx0LmVycm9yIHx8IHJlc3VsdC5zdGF0dXMgPT09IG51bGwgfHwgcmVzdWx0LnN0YXR1cyA9PT0gMCB8fCAhZGlhZ25vc3RpYy50ZXN0KG91dHB1dCkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEV4cGVjdGVkIExUTyByZWplY3Rpb24gZm9yICR7bmFtZX06ICR7cmVzdWx0LmVycm9yID8/IG91dHB1dH1gKTtcbiAgICBjb25zb2xlLmxvZyhgVmVyaWZpZWQgTFRPIHJlamVjdGlvbjogJHtuYW1lfWApO1xuICB9XG5cbiAgaWYgKHJvbGUgPT09IFwiZm9ybWF0XCIgfHwgcm9sZSA9PT0gXCJmb3JtYXQtd3JpdGVcIikge1xuICAgIHJ1bihcImNsYW5nLWZvcm1hdFwiLCBbLi4uKHJvbGUgPT09IFwiZm9ybWF0XCIgPyBbXCItLWRyeS1ydW5cIiwgXCItLVdlcnJvclwiXSA6IFtcIi1pXCJdKSwgLi4uc291cmNlc10pO1xuICB9IGVsc2UgaWYgKHJvbGUgPT09IFwibGludFwiKSB7XG4gICAgcnVuKFwiY2xhbmctdGlkeVwiLCBbXCItLXZlcmlmeS1jb25maWdcIl0pO1xuICAgIGNvbnN0IGFuYWx5c2lzID0gc2VsZWN0ZWRDb21waWxlciA9PT0gXCJjbGFuZ1wiID8gZGVidWcgOiBqb2luKGJ1aWxkcywgXCJhbmFseXNpcy1jbGFuZ1wiKTtcbiAgICBjb25maWd1cmUoYW5hbHlzaXMsIFtdLCBcImNsYW5nXCIpO1xuICAgIHJ1bihcImNtYWtlXCIsIFtcIi0tYnVpbGRcIiwgYW5hbHlzaXMsIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICAgIGZvciAoY29uc3Qgc291cmNlIG9mIHNvdXJjZXMuZmlsdGVyKChmaWxlKSA9PiAvXFwuKD86Y3xjcHApJC8udGVzdChmaWxlKSkpXG4gICAgICBydW4oXCJjbGFuZy10aWR5XCIsIFtcIi1wXCIsIGFuYWx5c2lzLCBzb3VyY2VdKTtcbiAgfSBlbHNlIGlmIChyb2xlID09PSBcImJ1aWxkXCIgfHwgcm9sZSA9PT0gXCJyZWxlYXNlXCIpIHtcbiAgICBjb25zdCBkaXJlY3RvcnkgPSByb2xlID09PSBcInJlbGVhc2VcIiA/IGpvaW4oYnVpbGRzLCBcInJlbGVhc2VcIikgOiBkZWJ1ZztcbiAgICBjb25maWd1cmUoXG4gICAgICBkaXJlY3RvcnksXG4gICAgICByb2xlID09PSBcInJlbGVhc2VcIiA/IFtcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxlYXNlXCIsIGAtRFdPUktCRU5DSF9MVE89JHtwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTFRPID8/IFwib2ZmXCJ9YF0gOiBbXSxcbiAgICApO1xuICAgIGlmIChyb2xlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgdmVyaWZ5UmVsZWFzZShkaXJlY3RvcnkpO1xuICAgICAgY29uc3Qgb3V0cHV0ID0gcmVzb2x2ZShwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUkVMRUFTRV9PVVRQVVQgPz8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0RJU1RfRElSID8/IFwiZGlzdFwiKTtcbiAgICAgIG1rZGlyU3luYyhvdXRwdXQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29weUZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBgY291bnQke3N1ZmZpeH1gKSwgam9pbihvdXRwdXQsIGBjb3VudCR7c3VmZml4fWApKTtcbiAgICAgIGNvcHlGaWxlU3luYyhcIkxJQ0VOU0VcIiwgam9pbihvdXRwdXQsIFwiTElDRU5TRVwiKSk7XG4gICAgfSBlbHNlIHJ1bihcImNtYWtlXCIsIFtcIi0tYnVpbGRcIiwgZGlyZWN0b3J5LCBcIi0tcGFyYWxsZWxcIiwgcGFyYWxsZWxpc21dKTtcbiAgfSBlbHNlIGlmIChyb2xlID09PSBcImx0b1wiKSB7XG4gICAgZm9yIChjb25zdCBtb2RlIG9mIHNlbGVjdGVkQ29tcGlsZXIgPT09IFwiY2xhbmdcIiA/IFtcIm9mZlwiLCBcInRoaW5cIiwgXCJmdWxsXCJdIDogW1wib2ZmXCIsIFwiZnVsbFwiXSkge1xuICAgICAgY29uc3QgZGlyZWN0b3J5ID0gam9pbihidWlsZHMsIGBsdG8tJHttb2RlfWApO1xuICAgICAgY29uZmlndXJlKGRpcmVjdG9yeSwgW1wiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIiwgYC1EV09SS0JFTkNIX0xUTz0ke21vZGV9YF0pO1xuICAgICAgdmVyaWZ5UmVsZWFzZShkaXJlY3RvcnkpO1xuICAgIH1cbiAgICByZWplY3RMdG8oXCJpbnZhbGlkXCIsIFtcIi1EV09SS0JFTkNIX0xUTz11bmtub3duXCJdLCAvbXVzdCBzZWxlY3Qgb2ZmLCB0aGluLCBvciBmdWxsLyk7XG4gICAgcmVqZWN0THRvKFwiZGVidWdcIiwgW1wiLURDTUFLRV9CVUlMRF9UWVBFPURlYnVnXCJdLCAvc2VwYXJhdGUgb3B0aW1pemVkIHNpbmdsZS1jb25maWd1cmF0aW9uIGJ1aWxkLyk7XG4gICAgcmVqZWN0THRvKFwiY292ZXJhZ2VcIiwgW1wiLURXT1JLQkVOQ0hfQ09WRVJBR0U9T05cIl0sIC9zZXBhcmF0ZSBMVE8gYnVpbGQgZnJvbSBjb3ZlcmFnZSBhbmQgc2FuaXRpemVycy8pO1xuICAgIHJlamVjdEx0byhcInNhbml0aXplcnNcIiwgW1wiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiXSwgL3NlcGFyYXRlIExUTyBidWlsZCBmcm9tIGNvdmVyYWdlIGFuZCBzYW5pdGl6ZXJzLyk7XG4gICAgaWYgKHNlbGVjdGVkQ29tcGlsZXIgIT09IFwiY2xhbmdcIilcbiAgICAgIHJlamVjdEx0byhcInRoaW5cIiwgW1wiLURXT1JLQkVOQ0hfTFRPPXRoaW5cIl0sIC9kb2VzIG5vdCBzdXBwb3J0IHRoZSByZXF1ZXN0ZWQgTFRPIG1vZGUvKTtcbiAgICBlbHNlIHJlamVjdEx0byhcInRvb2wtdmVyc2lvblwiLCBbYC1EbHRvX2xpbmtlcj0ke3Byb2Nlc3MuZXhlY1BhdGh9YF0sIC9tdXN0IG1hdGNoIENsYW5nLyk7XG4gIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJ0ZXN0XCIpIHtcbiAgICBjb25maWd1cmUoZGVidWcpO1xuICAgIHRlc3QoZGVidWcpO1xuICB9IGVsc2UgaWYgKHJvbGUgPT09IFwiY292ZXJhZ2VcIikge1xuICAgIGlmIChleGlzdHNTeW5jKFwiY292ZXJhZ2VcIikgJiYgbHN0YXRTeW5jKFwiY292ZXJhZ2VcIikuaXNTeW1ib2xpY0xpbmsoKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIG11c3QgYmUgYSByZWFsIGRpcmVjdG9yeVwiKTtcbiAgICBta2RpclN5bmMoXCJjb3ZlcmFnZVwiLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgcmVhZGRpclN5bmMoXCJjb3ZlcmFnZVwiKSlcbiAgICAgIGlmIChuYW1lICE9PSBcImNvdmVyYWdlLXN1bW1hcnkuanNvblwiKSBybVN5bmMoam9pbihcImNvdmVyYWdlXCIsIG5hbWUpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgaWYgKHNlbGVjdGVkQ29tcGlsZXIgIT09IFwiY2xhbmdcIikge1xuICAgICAgY29uZmlndXJlKGRlYnVnKTtcbiAgICAgIHRlc3QoZGVidWcpO1xuICAgIH1cbiAgICBjb25zdCBpbnN0cnVtZW50ZWQgPSBqb2luKGJ1aWxkcywgXCJjb3ZlcmFnZVwiKTtcbiAgICBjb25maWd1cmUoaW5zdHJ1bWVudGVkLCBbXCItRFdPUktCRU5DSF9DT1ZFUkFHRT1PTlwiXSwgXCJjbGFuZ1wiKTtcbiAgICBjb25zdCB0ZW1wb3JhcnkgPSBta2R0ZW1wU3luYyhqb2luKGluc3RydW1lbnRlZCwgXCJwcm9maWxlcy1cIikpO1xuICAgIHRyeSB7XG4gICAgICB0ZXN0KGluc3RydW1lbnRlZCwgdGVtcG9yYXJ5KTtcbiAgICAgIGNvbnN0IHByb2ZpbGVzID0gZmlsZXModGVtcG9yYXJ5KS5maWx0ZXIoKGZpbGU6IHN0cmluZykgPT4gZmlsZS5lbmRzV2l0aChcIi5wcm9mcmF3XCIpKTtcbiAgICAgIGlmICghcHJvZmlsZXMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJjb3ZlcmFnZSBwcm9kdWNlZCBubyBleGVjdXRpb24gcHJvZmlsZXNcIik7XG4gICAgICBjb25zdCBtZXJnZWQgPSBqb2luKHRlbXBvcmFyeSwgXCJtZXJnZWQucHJvZmRhdGFcIik7XG4gICAgICBydW4oXCJsbHZtLXByb2ZkYXRhXCIsIFtcIm1lcmdlXCIsIFwiLXNwYXJzZVwiLCAuLi5wcm9maWxlcywgXCItb1wiLCBtZXJnZWRdKTtcbiAgICAgIGNvbnN0IHNvdXJjZUZpbGVzID0gc291cmNlcy5maWx0ZXIoKGZpbGUpID0+ICFmaWxlLnN0YXJ0c1dpdGgoYHRlc3RzJHtzZXB9YCkpO1xuICAgICAgY29uc3QgY292ZXJhZ2VBcmdzID0gW1xuICAgICAgICBqb2luKGluc3RydW1lbnRlZCwgYGNvdW50X3Rlc3Qke3N1ZmZpeH1gKSxcbiAgICAgICAgXCItb2JqZWN0XCIsXG4gICAgICAgIGpvaW4oaW5zdHJ1bWVudGVkLCBgY291bnQke3N1ZmZpeH1gKSxcbiAgICAgICAgXCItb2JqZWN0XCIsXG4gICAgICAgIGpvaW4oaW5zdHJ1bWVudGVkLCBgY3B1X3Rlc3Qke3N1ZmZpeH1gKSxcbiAgICAgICAgYC1pbnN0ci1wcm9maWxlPSR7bWVyZ2VkfWAsXG4gICAgICAgIC4uLnNvdXJjZUZpbGVzLFxuICAgICAgXTtcbiAgICAgIHJ1bihcImxsdm0tY292XCIsIFtcInJlcG9ydFwiLCAuLi5jb3ZlcmFnZUFyZ3NdKTtcbiAgICAgIGNvbnN0IHJlcG9ydCA9IEpTT04ucGFyc2UocnVuKFwibGx2bS1jb3ZcIiwgW1wiZXhwb3J0XCIsIC4uLmNvdmVyYWdlQXJnc10sIHsgc3RkaW86IFwicGlwZVwiIH0pKSBhcyB7XG4gICAgICAgIGRhdGE6IHsgdG90YWxzOiBSZWNvcmQ8c3RyaW5nLCB7IGNvdW50OiBudW1iZXI7IHBlcmNlbnQ6IG51bWJlciB9PiB9W107XG4gICAgICB9O1xuICAgICAgd3JpdGVGaWxlU3luYyhcImNvdmVyYWdlL3JlcG9ydC5qc29uXCIsIEpTT04uc3RyaW5naWZ5KHJlcG9ydCkpO1xuICAgICAgYXNzZXJ0Lm9rKHJlcG9ydC5kYXRhWzBdLCBcIkxMVk0gY292ZXJhZ2UgZGlkIG5vdCByZXBvcnQgdG90YWxzXCIpO1xuICAgICAgY29uc3QgdG90YWwgPSByZXBvcnQuZGF0YVswXS50b3RhbHM7XG4gICAgICBmb3IgKGNvbnN0IFttZXRyaWMsIG1pbmltdW1dIG9mIE9iamVjdC5lbnRyaWVzKHBvbGljeS5jb3ZlcmFnZSkpIHtcbiAgICAgICAgaWYgKCF0b3RhbFttZXRyaWNdIHx8IHRvdGFsW21ldHJpY10uY291bnQgPT09IDAgfHwgdG90YWxbbWV0cmljXS5wZXJjZW50IDwgbWluaW11bSlcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgJHttZXRyaWN9IGNvdmVyYWdlICR7U3RyaW5nKHRvdGFsW21ldHJpY10/LnBlcmNlbnQgPz8gXCJtaXNzaW5nXCIpfSUgaXMgYmVsb3cgJHtTdHJpbmcobWluaW11bSl9JWAsXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBvcmFyeSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSBlbHNlIGlmIChyb2xlID09PSBcInNhbml0aXplcnNcIikge1xuICAgIGNvbmZpZ3VyZShqb2luKGJ1aWxkcywgXCJzYW5pdGl6ZXJzXCIpLCBbXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCJdKTtcbiAgICB0ZXN0KGpvaW4oYnVpbGRzLCBcInNhbml0aXplcnNcIikpO1xuICAgIGNvbmZpZ3VyZShqb2luKGJ1aWxkcywgXCJwb3J0YWJsZVwiKSwgW1wiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiLCBcIi1EV09SS0JFTkNIX1BPUlRBQkxFX09OTFk9T05cIl0pO1xuICAgIHRlc3Qoam9pbihidWlsZHMsIFwicG9ydGFibGVcIikpO1xuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBFcnJvcihcImV4cGVjdGVkIGJ1aWxkLCByZWxlYXNlLCBmb3JtYXQsIGZvcm1hdC13cml0ZSwgbGludCwgdGVzdCwgY292ZXJhZ2UsIHNhbml0aXplcnMsIG9yIGx0b1wiKTtcbiAgfVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxZQUFZO0FBQ25CLFNBQWdDLGlCQUFpQjtBQUVqRDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLE1BQU0sVUFBVSxTQUFTLFdBQVc7QUFDN0MsU0FBUyxxQkFBcUI7QUFFOUIsU0FBUyxpQkFBaUIsd0JBQTZDO0FBRXZFLGVBQXNCLGdCQUFnQixVQUF1QixjQUFzQixNQUE2QjtBQUM5RyxRQUFNLE9BQU8sUUFBUSxJQUFJO0FBQ3pCLFFBQU0sRUFBRSxVQUFVLElBQUssTUFBTSxPQUMzQixjQUFjLEtBQUssY0FBYyx3QkFBd0IsQ0FBQyxFQUFFO0FBRzlELFFBQU0sRUFBRSxnQkFBZ0IsSUFBSyxNQUFNLE9BQ2pDLGNBQWMsS0FBSyxjQUFjLCtCQUErQixDQUFDLEVBQUU7QUFFckUsUUFBTSxtQkFBbUIsUUFBUSxJQUFJO0FBQ3JDLE1BQUksQ0FBQyxpQkFBa0IsT0FBTSxJQUFJLE1BQU0sd0VBQXdFO0FBQy9HLFFBQU0sU0FBUztBQUNmLFFBQU0sUUFBUSxLQUFLLFFBQVEsT0FBTztBQUNsQyxRQUFNLFNBQVMsS0FBSyxNQUFNLGFB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
