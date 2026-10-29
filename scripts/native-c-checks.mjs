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
    const detection = join(directory, "vcpkg_buildtrees", "detect_compiler");
    try {
      if (!existsSync(detection)) return;
      const output = join(root, "coverage", "cmake", relative(builds, directory).replaceAll(sep, "-"));
      for (const path of files(detection).filter((path2) => path2.endsWith(".log"))) {
        const destination = join(output, relative(detection, path));
        mkdirSync(join(destination, ".."), { recursive: true });
        copyFileSync(path, destination);
        if (/-(out|err)\.log$/.test(path))
          console.error(`${path}
${readFileSync(path, "utf8").slice(-8192).split(/\r?\n/).slice(-40).join("\n")}`);
      }
      console.error(`Compiler detection logs: ${output}`);
    } catch (error) {
      console.error(`Could not retain compiler detection logs: ${String(error)}`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5hdGl2ZS1jLWNoZWNrcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyB0eXBlIFNwYXduU3luY09wdGlvbnMsIHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbHN0YXRTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICBta2RpclN5bmMsXG4gIG1rZHRlbXBTeW5jLFxuICBybVN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG4gIGNvcHlGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5cbmltcG9ydCB7IGNvbXBpbGVyQ2F0YWxvZywgaXNDb21waWxlckZhbWlseSwgdHlwZSBDb21waWxlckZhbWlseSB9IGZyb20gXCIuL2NvbXBpbGVyLWNhdGFsb2cubWpzXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5OYXRpdmVDaGVja3MobGFuZ3VhZ2U6IFwiY1wiIHwgXCJjcHBcIiwgZGlzdHJpYnV0aW9uOiBzdHJpbmcsIHJvbGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByb290ID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgeyBjcHVCdWRnZXQgfSA9IChhd2FpdCBpbXBvcnQoXG4gICAgcGF0aFRvRmlsZVVSTChqb2luKGRpc3RyaWJ1dGlvbiwgXCJzY3JpcHRzL2NwdS1idWRnZXQubWpzXCIpKS5ocmVmXG4gICkpIGFzIHR5cGVvZiBpbXBvcnQoXCIuL2NwdS1idWRnZXQubWpzXCIpO1xuXG4gIGNvbnN0IHsgZW1pdENoZWNrRGV0YWlsIH0gPSAoYXdhaXQgaW1wb3J0KFxuICAgIHBhdGhUb0ZpbGVVUkwoam9pbihkaXN0cmlidXRpb24sIFwic2NyaXB0cy9jaGVjay1kZXRhaWwtZGF0YS5tanNcIikpLmhyZWZcbiAgKSkgYXMgdHlwZW9mIGltcG9ydChcIi4vY2hlY2stZGV0YWlsLWRhdGEubWpzXCIpO1xuICBjb25zdCBjb25maWd1cmVkQnVpbGRzID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0JVSUxEX0RJUjtcbiAgaWYgKCFjb25maWd1cmVkQnVpbGRzKSB0aHJvdyBuZXcgRXJyb3IoXCJ1c2UgV29ya2JlbmNoIGNoZWNrcyBvciBhIGNvbmZpZ3VyZWQgV29ya2JlbmNoIHNoZWxsIGZvciBuYXRpdmUgYnVpbGRzXCIpO1xuICBjb25zdCBidWlsZHMgPSBjb25maWd1cmVkQnVpbGRzO1xuICBjb25zdCBkZWJ1ZyA9IGpvaW4oYnVpbGRzLCBcImRlYnVnXCIpO1xuICBjb25zdCBwb2xpY3kgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhcIndvcmtiZW5jaC9xdWFsaXR5Lmpzb25cIiwgXCJ1dGY4XCIpKSBhcyB7XG4gICAgc2xvd190ZXN0X3NlY29uZHM6IG51bWJlcjtcbiAgICBjb3ZlcmFnZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbiAgfTtcbiAgY29uc3Qgc3VmZml4ID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCIuZXhlXCIgOiBcIlwiO1xuICBjb25zdCByZXF1ZXN0ZWRDb21waWxlciA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9DT01QSUxFUiA/PyBcImNsYW5nXCI7XG4gIGlmICghaXNDb21waWxlckZhbWlseShyZXF1ZXN0ZWRDb21waWxlcikpIHRocm93IG5ldyBFcnJvcihcIlNlbGVjdCBhIGRlY2xhcmVkIG5hdGl2ZSBjb21waWxlclwiKTtcbiAgY29uc3Qgc2VsZWN0ZWRDb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSByZXF1ZXN0ZWRDb21waWxlcjtcbiAgY29uc3QgbWFuYWdlZCA9IHByb2Nlc3MuZW52LldPUktCRU5DSF9NQU5BR0VEX0NPTVBJTEVSID09PSBcIjFcIjtcbiAgY29uc3QgcGFyYWxsZWxpc20gPSBTdHJpbmcoY3B1QnVkZ2V0KCkpO1xuICBwcm9jZXNzLmVudi5DVEVTVF9QQVJBTExFTF9MRVZFTCA9IHBhcmFsbGVsaXNtO1xuICBmdW5jdGlvbiBydW4oY29tbWFuZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSA9IFtdLCBvcHRpb25zOiBPbWl0PFNwYXduU3luY09wdGlvbnMsIFwiZW5jb2RpbmdcIj4gPSB7fSkge1xuICAgIGNvbnN0IHJlc3VsdDogaW1wb3J0KFwibm9kZTpjaGlsZF9wcm9jZXNzXCIpLlNwYXduU3luY1JldHVybnM8c3RyaW5nIHwgbnVsbD4gPSBzcGF3blN5bmMoY29tbWFuZCwgYXJncywge1xuICAgICAgZW5jb2Rpbmc6IFwidXRmOFwiLFxuICAgICAgc3RkaW86IFwiaW5oZXJpdFwiLFxuICAgICAgLi4ub3B0aW9ucyxcbiAgICB9KTtcbiAgICBpZiAocmVzdWx0LmVycm9yIHx8IHJlc3VsdC5zdGF0dXMgIT09IDApXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7Y29tbWFuZH0gZmFpbGVkOiAke1N0cmluZyhyZXN1bHQuZXJyb3IgPz8gcmVzdWx0LnN0YXR1cyl9YCk7XG4gICAgcmV0dXJuIHJlc3VsdC5zdGRvdXQgPz8gXCJcIjtcbiAgfVxuICBmdW5jdGlvbiBjb2xsZWN0Q01ha2VGYWlsdXJlTG9ncyhkaXJlY3Rvcnk6IHN0cmluZykge1xuICAgIGNvbnN0IGRldGVjdGlvbiA9IGpvaW4oZGlyZWN0b3J5LCBcInZjcGtnX2J1aWxkdHJlZXNcIiwgXCJkZXRlY3RfY29tcGlsZXJcIik7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghZXhpc3RzU3luYyhkZXRlY3Rpb24pKSByZXR1cm47XG4gICAgICBjb25zdCBvdXRwdXQgPSBqb2luKHJvb3QsIFwiY292ZXJhZ2VcIiwgXCJjbWFrZVwiLCByZWxhdGl2ZShidWlsZHMsIGRpcmVjdG9yeSkucmVwbGFjZUFsbChzZXAsIFwiLVwiKSk7XG4gICAgICBmb3IgKGNvbnN0IHBhdGggb2YgZmlsZXMoZGV0ZWN0aW9uKS5maWx0ZXIoKHBhdGg6IHN0cmluZykgPT4gcGF0aC5lbmRzV2l0aChcIi5sb2dcIikpKSB7XG4gICAgICAgIGNvbnN0IGRlc3RpbmF0aW9uID0gam9pbihvdXRwdXQsIHJlbGF0aXZlKGRldGVjdGlvbiwgcGF0aCkpO1xuICAgICAgICBta2RpclN5bmMoam9pbihkZXN0aW5hdGlvbiwgXCIuLlwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgIGNvcHlGaWxlU3luYyhwYXRoLCBkZXN0aW5hdGlvbik7XG4gICAgICAgIGlmICgvLShvdXR8ZXJyKVxcLmxvZyQvLnRlc3QocGF0aCkpXG4gICAgICAgICAgY29uc29sZS5lcnJvcihgJHtwYXRofVxcbiR7cmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKS5zbGljZSgtODE5Mikuc3BsaXQoL1xccj9cXG4vKS5zbGljZSgtNDApLmpvaW4oXCJcXG5cIil9YCk7XG4gICAgICB9XG4gICAgICBjb25zb2xlLmVycm9yKGBDb21waWxlciBkZXRlY3Rpb24gbG9nczogJHtvdXRwdXR9YCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYENvdWxkIG5vdCByZXRhaW4gY29tcGlsZXIgZGV0ZWN0aW9uIGxvZ3M6ICR7U3RyaW5nKGVycm9yKX1gKTtcbiAgICB9XG4gIH1cbiAgZnVuY3Rpb24gZmlsZXMoZGlyZWN0b3J5OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcmVjdG9yeSwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pLmZsYXRNYXAoKGVudHJ5KSA9PlxuICAgICAgZW50cnkuaXNEaXJlY3RvcnkoKSA/IGZpbGVzKGpvaW4oZGlyZWN0b3J5LCBlbnRyeS5uYW1lKSkgOiBbam9pbihkaXJlY3RvcnksIGVudHJ5Lm5hbWUpXSxcbiAgICApO1xuICB9XG4gIGNvbnN0IHNvdXJjZXMgPSBbXCJzcmNcIiwgXCJpbmNsdWRlXCIsIFwidGVzdHNcIl0uZmxhdE1hcChmaWxlcykuZmlsdGVyKChmaWxlKSA9PiAvXFwuKD86Y3xjcHB8aHxocHApJC8udGVzdChmaWxlKSk7XG4gIGZ1bmN0aW9uIGNvbXBpbGVyQXJndW1lbnRzKGNvbXBpbGVyOiBDb21waWxlckZhbWlseSA9IHNlbGVjdGVkQ29tcGlsZXIpIHtcbiAgICBjb25zdCBleGVjdXRhYmxlID1cbiAgICAgIGNvbXBpbGVyID09PSBzZWxlY3RlZENvbXBpbGVyID8gcHJvY2Vzcy5lbnZbbGFuZ3VhZ2UgPT09IFwiY1wiID8gXCJXT1JLQkVOQ0hfQ0NcIiA6IFwiV09SS0JFTkNIX0NYWFwiXSA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gW1xuICAgICAgYC1EQ01BS0VfJHtsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIkNcIiA6IFwiQ1hYXCJ9X0NPTVBJTEVSPSR7ZXhlY3V0YWJsZSA/PyBjb21waWxlckNhdGFsb2dbY29tcGlsZXJdLmV4ZWN1dGFibGVzW2xhbmd1YWdlXX1gLFxuICAgIF07XG4gIH1cbiAgZnVuY3Rpb24gY29uZmlndXJlKGRpcmVjdG9yeTogc3RyaW5nLCBvcHRpb25zOiBzdHJpbmdbXSA9IFtdLCBjb21waWxlcjogQ29tcGlsZXJGYW1pbHkgPSBzZWxlY3RlZENvbXBpbGVyKSB7XG4gICAgaWYgKCFtYW5hZ2VkKSB7XG4gICAgICBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW1xuICAgICAgICBqb2luKGRpc3RyaWJ1dGlvbiwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAgICAgXCJ2Y3BrZy1wcmVwYXJlXCIsXG4gICAgICAgIHJvb3QsXG4gICAgICAgIGRpcmVjdG9yeSxcbiAgICAgICAgXCItLWNvbXBpbGVyXCIsXG4gICAgICAgIGNvbXBpbGVyLFxuICAgICAgICAuLi4ob3B0aW9ucy5pbmNsdWRlcyhcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIikgPyBbXCItLXNhbml0aXplcnNcIl0gOiBbXSksXG4gICAgICBdKTtcbiAgICAgIHByb2Nlc3MuZW52LlZDUEtHX0RJU0FCTEVfTUVUUklDUyA9IFwiMVwiO1xuICAgICAgcHJvY2Vzcy5lbnYuVkNQS0dfRk9SQ0VfU1lTVEVNX0JJTkFSSUVTID0gXCIxXCI7XG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuVkNQS0dfRk9SQ0VfRE9XTkxPQURFRF9CSU5BUklFUztcbiAgICAgIHByb2Nlc3MuZW52LlZDUEtHX01BWF9DT05DVVJSRU5DWSA9IHBhcmFsbGVsaXNtO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgcnVuKFwiY21ha2VcIiwgW1xuICAgICAgICBcIi1TXCIsXG4gICAgICAgIFwiLlwiLFxuICAgICAgICBcIi1CXCIsXG4gICAgICAgIGRpcmVjdG9yeSxcbiAgICAgICAgXCItR1wiLFxuICAgICAgICBcIk5pbmphXCIsXG4gICAgICAgIFwiLURDTUFLRV9CVUlMRF9UWVBFPURlYnVnXCIsXG4gICAgICAgIFwiLURXT1JLQkVOQ0hfTFRPPW9mZlwiLFxuICAgICAgICBcIi1EV09SS0JFTkNIX0NPVkVSQUdFPU9GRlwiLFxuICAgICAgICBcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T0ZGXCIsXG4gICAgICAgIFwiLURXT1JLQkVOQ0hfUE9SVEFCTEVfT05MWT1PRkZcIixcbiAgICAgICAgLi4uKG1hbmFnZWRcbiAgICAgICAgICA/IGNvbXBpbGVyQXJndW1lbnRzKGNvbXBpbGVyKVxuICAgICAgICAgIDogW2AtRENNQUtFX1RPT0xDSEFJTl9GSUxFPSR7am9pbihkaXJlY3RvcnksIFwid29ya2JlbmNoLXZjcGtnLmNtYWtlXCIpfWBdKSxcbiAgICAgICAgLi4uKChwcm9jZXNzLmVudltsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIldPUktCRU5DSF9DX1NUQU5EQVJEXCIgOiBcIldPUktCRU5DSF9DWFhfU1RBTkRBUkRcIl0gPz9cbiAgICAgICAgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEKVxuICAgICAgICAgID8gW1xuICAgICAgICAgICAgICBgLURXT1JLQkVOQ0hfTEFOR1VBR0VfU1RBTkRBUkQ9JHtwcm9jZXNzLmVudltsYW5ndWFnZSA9PT0gXCJjXCIgPyBcIldPUktCRU5DSF9DX1NUQU5EQVJEXCIgOiBcIldPUktCRU5DSF9DWFhfU1RBTkRBUkRcIl0gPz8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0xBTkdVQUdFX1NUQU5EQVJEID8/IFwiXCJ9YCxcbiAgICAgICAgICAgIF1cbiAgICAgICAgICA6IFtdKSxcbiAgICAgICAgYC1EV09SS0JFTkNIX0NPTVBJTEVSX0ZBTUlMWT0ke2NvbXBpbGVyfWAsXG4gICAgICAgIGAtRFdPUktCRU5DSF9DT01QSUxFUl9NSU5JTVVNPSR7Y29tcGlsZXIgPT09IHNlbGVjdGVkQ29tcGlsZXIgPyAocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NPTVBJTEVSX01JTklNVU0gPz8gXCJcIikgOiBcIlwifWAsXG4gICAgICAgIC4uLihwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgJiYgb3B0aW9ucy5pbmNsdWRlcyhcIi1EV09SS0JFTkNIX1NBTklUSVpFUlM9T05cIilcbiAgICAgICAgICA/IFtcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxXaXRoRGViSW5mb1wiXVxuICAgICAgICAgIDogW10pLFxuICAgICAgICAuLi5vcHRpb25zLFxuICAgICAgXSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbGxlY3RDTWFrZUZhaWx1cmVMb2dzKGRpcmVjdG9yeSk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbiAgZnVuY3Rpb24gdGVzdChkaXJlY3Rvcnk6IHN0cmluZywgcHJvZmlsZXM/OiBzdHJpbmcpIHtcbiAgICBta2RpclN5bmMoXCJjb3ZlcmFnZVwiLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCByZXN1bHRzID0gam9pbihyb290LCBcImNvdmVyYWdlXCIsIGB0ZXN0cy0ke2RpcmVjdG9yeS5zbGljZShidWlsZHMubGVuZ3RoICsgMSkucmVwbGFjZUFsbChzZXAsIFwiLVwiKX0ueG1sYCk7XG4gICAgcnVuKFwiY21ha2VcIiwgW1wiLS1idWlsZFwiLCBkaXJlY3RvcnksIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICAgIHJ1bihcImN0ZXN0XCIsIFtcIi0tdGVzdC1kaXJcIiwgZGlyZWN0b3J5LCBcIi0tb3V0cHV0LW9uLWZhaWx1cmVcIiwgXCItLW5vLXRlc3RzPWVycm9yXCIsIFwiLS1vdXRwdXQtanVuaXRcIiwgcmVzdWx0c10sIHtcbiAgICAgIGVudjogeyAuLi5wcm9jZXNzLmVudiwgLi4uKHByb2ZpbGVzID8geyBMTFZNX1BST0ZJTEVfRklMRTogam9pbihwcm9maWxlcywgXCIlcC0lbS5wcm9mcmF3XCIpIH0gOiB7fSkgfSxcbiAgICB9KTtcbiAgICBjb25zdCByZXBvcnQgPSByZWFkRmlsZVN5bmMocmVzdWx0cywgXCJ1dGY4XCIpO1xuICAgIGZvciAoY29uc3QgbWF0Y2ggb2YgcmVwb3J0Lm1hdGNoQWxsKC88dGVzdGNhc2VcXGIoW14+XSspPi9nKSkge1xuICAgICAgYXNzZXJ0Lm9rKG1hdGNoWzFdLCBcIk1pc3NpbmcgdGVzdGNhc2UgYXR0cmlidXRlc1wiKTtcbiAgICAgIGNvbnN0IG5hbWUgPSAvXFxibmFtZT1cIihbXlwiXSspXCIvLmV4ZWMobWF0Y2hbMV0pPy5bMV07XG4gICAgICBjb25zdCBlbGFwc2VkID0gTnVtYmVyKC9cXGJ0aW1lPVwiKFteXCJdKylcIi8uZXhlYyhtYXRjaFsxXSk/LlsxXSk7XG4gICAgICBpZiAocm9sZSAhPT0gXCJjb3ZlcmFnZVwiICYmIGVsYXBzZWQgPiBwb2xpY3kuc2xvd190ZXN0X3NlY29uZHMpIHtcbiAgICAgICAgZW1pdENoZWNrRGV0YWlsKHtcbiAgICAgICAgICB2ZXJzaW9uOiAxLFxuICAgICAgICAgIGtpbmQ6IFwic2xvd1wiLFxuICAgICAgICAgIHNjb3BlOiBcInRlc3RcIixcbiAgICAgICAgICBuYW1lOiBTdHJpbmcobmFtZSksXG4gICAgICAgICAgZWxhcHNlZFNlY29uZHM6IGVsYXBzZWQsXG4gICAgICAgICAgdGhyZXNob2xkU2Vjb25kczogcG9saWN5LnNsb3dfdGVzdF9zZWNvbmRzLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICBgU0xPVyB0ZXN0ICR7U3RyaW5nKG5hbWUpfTogJHtTdHJpbmcoZWxhcHNlZCl9cyAoc29mdCBjYXAgJHtTdHJpbmcocG9saWN5LnNsb3dfdGVzdF9zZWNvbmRzKX1zOyBhZHZpc29yeSBvbmx5KWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gdmVyaWZ5UmVsZWFzZShkaXJlY3Rvcnk6IHN0cmluZykge1xuICAgIHRlc3QoZGlyZWN0b3J5KTtcbiAgICBydW4ocHJvY2Vzcy5leGVjUGF0aCwgW2pvaW4ocm9vdCwgXCJzY3JpcHRzL3JlbGVhc2UtdmVyaWZ5Lm1qc1wiKSwgZGlyZWN0b3J5XSk7XG4gIH1cblxuICBmdW5jdGlvbiByZWplY3RMdG8obmFtZTogc3RyaW5nLCBvcHRpb25zOiBzdHJpbmdbXSwgZGlhZ25vc3RpYzogUmVnRXhwKSB7XG4gICAgLy8gUmV1c2UgdGhlIHZlcmlmaWVkIG9mZi1tb2RlIGRlcGVuZGVuY3kgaW5zdGFsbGF0aW9uLCB3aXRob3V0IHJlaW5zdGFsbGluZyBkZXBlbmRlbmNpZXMuXG4gICAgY29uc3QgcmVzdWx0OiBpbXBvcnQoXCJub2RlOmNoaWxkX3Byb2Nlc3NcIikuU3Bhd25TeW5jUmV0dXJuczxzdHJpbmcgfCBudWxsPiA9IHNwYXduU3luYyhcbiAgICAgIFwiY21ha2VcIixcbiAgICAgIFtcbiAgICAgICAgXCItU1wiLFxuICAgICAgICBcIi5cIixcbiAgICAgICAgXCItQlwiLFxuICAgICAgICBqb2luKGJ1aWxkcywgYGx0by1yZWplY3QtJHtuYW1lfWApLFxuICAgICAgICBcIi1HXCIsXG4gICAgICAgIFwiTmluamFcIixcbiAgICAgICAgLi4uKG1hbmFnZWRcbiAgICAgICAgICA/IGNvbXBpbGVyQXJndW1lbnRzKClcbiAgICAgICAgICA6IFtcbiAgICAgICAgICAgICAgYC1EQ01BS0VfVE9PTENIQUlOX0ZJTEU9JHtqb2luKGJ1aWxkcywgXCJsdG8tb2ZmXCIsIFwid29ya2JlbmNoLXZjcGtnLmNtYWtlXCIpfWAsXG4gICAgICAgICAgICAgIFwiLURWQ1BLR19NQU5JRkVTVF9JTlNUQUxMPU9GRlwiLFxuICAgICAgICAgICAgXSksXG4gICAgICAgIFwiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIixcbiAgICAgICAgXCItRFdPUktCRU5DSF9MVE89ZnVsbFwiLFxuICAgICAgICAuLi5vcHRpb25zLFxuICAgICAgXSxcbiAgICAgIHsgZW5jb2Rpbmc6IFwidXRmOFwiIH0sXG4gICAgKTtcbiAgICBjb25zdCBvdXRwdXQgPSBgJHtyZXN1bHQuc3Rkb3V0ID8/IFwiXCJ9JHtyZXN1bHQuc3RkZXJyID8/IFwiXCJ9YDtcbiAgICBpZiAocmVzdWx0LmVycm9yIHx8IHJlc3VsdC5zdGF0dXMgPT09IG51bGwgfHwgcmVzdWx0LnN0YXR1cyA9PT0gMCB8fCAhZGlhZ25vc3RpYy50ZXN0KG91dHB1dCkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEV4cGVjdGVkIExUTyByZWplY3Rpb24gZm9yICR7bmFtZX06ICR7cmVzdWx0LmVycm9yID8/IG91dHB1dH1gKTtcbiAgICBjb25zb2xlLmxvZyhgVmVyaWZpZWQgTFRPIHJlamVjdGlvbjogJHtuYW1lfWApO1xuICB9XG5cbiAgaWYgKHJvbGUgPT09IFwiZm9ybWF0XCIgfHwgcm9sZSA9PT0gXCJmb3JtYXQtd3JpdGVcIikge1xuICAgIHJ1bihcImNsYW5nLWZvcm1hdFwiLCBbLi4uKHJvbGUgPT09IFwiZm9ybWF0XCIgPyBbXCItLWRyeS1ydW5cIiwgXCItLVdlcnJvclwiXSA6IFtcIi1pXCJdKSwgLi4uc291cmNlc10pO1xuICB9IGVsc2UgaWYgKHJvbGUgPT09IFwibGludFwiKSB7XG4gICAgcnVuKFwiY2xhbmctdGlkeVwiLCBbXCItLXZlcmlmeS1jb25maWdcIl0pO1xuICAgIGNvbnN0IGFuYWx5c2lzID0gc2VsZWN0ZWRDb21waWxlciA9PT0gXCJjbGFuZ1wiID8gZGVidWcgOiBqb2luKGJ1aWxkcywgXCJhbmFseXNpcy1jbGFuZ1wiKTtcbiAgICBjb25maWd1cmUoYW5hbHlzaXMsIFtdLCBcImNsYW5nXCIpO1xuICAgIHJ1bihcImNtYWtlXCIsIFtcIi0tYnVpbGRcIiwgYW5hbHlzaXMsIFwiLS1wYXJhbGxlbFwiLCBwYXJhbGxlbGlzbV0pO1xuICAgIGZvciAoY29uc3Qgc291cmNlIG9mIHNvdXJjZXMuZmlsdGVyKChmaWxlKSA9PiAvXFwuKD86Y3xjcHApJC8udGVzdChmaWxlKSkpXG4gICAgICBydW4oXCJjbGFuZy10aWR5XCIsIFtcIi1wXCIsIGFuYWx5c2lzLCBzb3VyY2VdKTtcbiAgfSBlbHNlIGlmIChyb2xlID09PSBcImJ1aWxkXCIgfHwgcm9sZSA9PT0gXCJyZWxlYXNlXCIpIHtcbiAgICBjb25zdCBkaXJlY3RvcnkgPSByb2xlID09PSBcInJlbGVhc2VcIiA/IGpvaW4oYnVpbGRzLCBcInJlbGVhc2VcIikgOiBkZWJ1ZztcbiAgICBjb25maWd1cmUoXG4gICAgICBkaXJlY3RvcnksXG4gICAgICByb2xlID09PSBcInJlbGVhc2VcIiA/IFtcIi1EQ01BS0VfQlVJTERfVFlQRT1SZWxlYXNlXCIsIGAtRFdPUktCRU5DSF9MVE89JHtwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTFRPID8/IFwib2ZmXCJ9YF0gOiBbXSxcbiAgICApO1xuICAgIGlmIChyb2xlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgdmVyaWZ5UmVsZWFzZShkaXJlY3RvcnkpO1xuICAgICAgY29uc3Qgb3V0cHV0ID0gcmVzb2x2ZShwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUkVMRUFTRV9PVVRQVVQgPz8gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0RJU1RfRElSID8/IFwiZGlzdFwiKTtcbiAgICAgIG1rZGlyU3luYyhvdXRwdXQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29weUZpbGVTeW5jKGpvaW4oZGlyZWN0b3J5LCBgY291bnQke3N1ZmZpeH1gKSwgam9pbihvdXRwdXQsIGBjb3VudCR7c3VmZml4fWApKTtcbiAgICAgIGNvcHlGaWxlU3luYyhcIkxJQ0VOU0VcIiwgam9pbihvdXRwdXQsIFwiTElDRU5TRVwiKSk7XG4gICAgfSBlbHNlIHJ1bihcImNtYWtlXCIsIFtcIi0tYnVpbGRcIiwgZGlyZWN0b3J5LCBcIi0tcGFyYWxsZWxcIiwgcGFyYWxsZWxpc21dKTtcbiAgfSBlbHNlIGlmIChyb2xlID09PSBcImx0b1wiKSB7XG4gICAgZm9yIChjb25zdCBtb2RlIG9mIHNlbGVjdGVkQ29tcGlsZXIgPT09IFwiY2xhbmdcIiA/IFtcIm9mZlwiLCBcInRoaW5cIiwgXCJmdWxsXCJdIDogW1wib2ZmXCIsIFwiZnVsbFwiXSkge1xuICAgICAgY29uc3QgZGlyZWN0b3J5ID0gam9pbihidWlsZHMsIGBsdG8tJHttb2RlfWApO1xuICAgICAgY29uZmlndXJlKGRpcmVjdG9yeSwgW1wiLURDTUFLRV9CVUlMRF9UWVBFPVJlbGVhc2VcIiwgYC1EV09SS0JFTkNIX0xUTz0ke21vZGV9YF0pO1xuICAgICAgdmVyaWZ5UmVsZWFzZShkaXJlY3RvcnkpO1xuICAgIH1cbiAgICByZWplY3RMdG8oXCJpbnZhbGlkXCIsIFtcIi1EV09SS0JFTkNIX0xUTz11bmtub3duXCJdLCAvbXVzdCBzZWxlY3Qgb2ZmLCB0aGluLCBvciBmdWxsLyk7XG4gICAgcmVqZWN0THRvKFwiZGVidWdcIiwgW1wiLURDTUFLRV9CVUlMRF9UWVBFPURlYnVnXCJdLCAvc2VwYXJhdGUgb3B0aW1pemVkIHNpbmdsZS1jb25maWd1cmF0aW9uIGJ1aWxkLyk7XG4gICAgcmVqZWN0THRvKFwiY292ZXJhZ2VcIiwgW1wiLURXT1JLQkVOQ0hfQ09WRVJBR0U9T05cIl0sIC9zZXBhcmF0ZSBMVE8gYnVpbGQgZnJvbSBjb3ZlcmFnZSBhbmQgc2FuaXRpemVycy8pO1xuICAgIHJlamVjdEx0byhcInNhbml0aXplcnNcIiwgW1wiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiXSwgL3NlcGFyYXRlIExUTyBidWlsZCBmcm9tIGNvdmVyYWdlIGFuZCBzYW5pdGl6ZXJzLyk7XG4gICAgaWYgKHNlbGVjdGVkQ29tcGlsZXIgIT09IFwiY2xhbmdcIilcbiAgICAgIHJlamVjdEx0byhcInRoaW5cIiwgW1wiLURXT1JLQkVOQ0hfTFRPPXRoaW5cIl0sIC9kb2VzIG5vdCBzdXBwb3J0IHRoZSByZXF1ZXN0ZWQgTFRPIG1vZGUvKTtcbiAgICBlbHNlIHJlamVjdEx0byhcInRvb2wtdmVyc2lvblwiLCBbYC1EbHRvX2xpbmtlcj0ke3Byb2Nlc3MuZXhlY1BhdGh9YF0sIC9tdXN0IG1hdGNoIENsYW5nLyk7XG4gIH0gZWxzZSBpZiAocm9sZSA9PT0gXCJ0ZXN0XCIpIHtcbiAgICBjb25maWd1cmUoZGVidWcpO1xuICAgIHRlc3QoZGVidWcpO1xuICB9IGVsc2UgaWYgKHJvbGUgPT09IFwiY292ZXJhZ2VcIikge1xuICAgIGlmIChleGlzdHNTeW5jKFwiY292ZXJhZ2VcIikgJiYgbHN0YXRTeW5jKFwiY292ZXJhZ2VcIikuaXNTeW1ib2xpY0xpbmsoKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcImNvdmVyYWdlIG11c3QgYmUgYSByZWFsIGRpcmVjdG9yeVwiKTtcbiAgICBta2RpclN5bmMoXCJjb3ZlcmFnZVwiLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgcmVhZGRpclN5bmMoXCJjb3ZlcmFnZVwiKSlcbiAgICAgIGlmIChuYW1lICE9PSBcImNvdmVyYWdlLXN1bW1hcnkuanNvblwiKSBybVN5bmMoam9pbihcImNvdmVyYWdlXCIsIG5hbWUpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgaWYgKHNlbGVjdGVkQ29tcGlsZXIgIT09IFwiY2xhbmdcIikge1xuICAgICAgY29uZmlndXJlKGRlYnVnKTtcbiAgICAgIHRlc3QoZGVidWcpO1xuICAgIH1cbiAgICBjb25zdCBpbnN0cnVtZW50ZWQgPSBqb2luKGJ1aWxkcywgXCJjb3ZlcmFnZVwiKTtcbiAgICBjb25maWd1cmUoaW5zdHJ1bWVudGVkLCBbXCItRFdPUktCRU5DSF9DT1ZFUkFHRT1PTlwiXSwgXCJjbGFuZ1wiKTtcbiAgICBjb25zdCB0ZW1wb3JhcnkgPSBta2R0ZW1wU3luYyhqb2luKGluc3RydW1lbnRlZCwgXCJwcm9maWxlcy1cIikpO1xuICAgIHRyeSB7XG4gICAgICB0ZXN0KGluc3RydW1lbnRlZCwgdGVtcG9yYXJ5KTtcbiAgICAgIGNvbnN0IHByb2ZpbGVzID0gZmlsZXModGVtcG9yYXJ5KS5maWx0ZXIoKGZpbGU6IHN0cmluZykgPT4gZmlsZS5lbmRzV2l0aChcIi5wcm9mcmF3XCIpKTtcbiAgICAgIGlmICghcHJvZmlsZXMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJjb3ZlcmFnZSBwcm9kdWNlZCBubyBleGVjdXRpb24gcHJvZmlsZXNcIik7XG4gICAgICBjb25zdCBtZXJnZWQgPSBqb2luKHRlbXBvcmFyeSwgXCJtZXJnZWQucHJvZmRhdGFcIik7XG4gICAgICBydW4oXCJsbHZtLXByb2ZkYXRhXCIsIFtcIm1lcmdlXCIsIFwiLXNwYXJzZVwiLCAuLi5wcm9maWxlcywgXCItb1wiLCBtZXJnZWRdKTtcbiAgICAgIGNvbnN0IHNvdXJjZUZpbGVzID0gc291cmNlcy5maWx0ZXIoKGZpbGUpID0+ICFmaWxlLnN0YXJ0c1dpdGgoYHRlc3RzJHtzZXB9YCkpO1xuICAgICAgY29uc3QgY292ZXJhZ2VBcmdzID0gW1xuICAgICAgICBqb2luKGluc3RydW1lbnRlZCwgYGNvdW50X3Rlc3Qke3N1ZmZpeH1gKSxcbiAgICAgICAgXCItb2JqZWN0XCIsXG4gICAgICAgIGpvaW4oaW5zdHJ1bWVudGVkLCBgY291bnQke3N1ZmZpeH1gKSxcbiAgICAgICAgXCItb2JqZWN0XCIsXG4gICAgICAgIGpvaW4oaW5zdHJ1bWVudGVkLCBgY3B1X3Rlc3Qke3N1ZmZpeH1gKSxcbiAgICAgICAgYC1pbnN0ci1wcm9maWxlPSR7bWVyZ2VkfWAsXG4gICAgICAgIC4uLnNvdXJjZUZpbGVzLFxuICAgICAgXTtcbiAgICAgIHJ1bihcImxsdm0tY292XCIsIFtcInJlcG9ydFwiLCAuLi5jb3ZlcmFnZUFyZ3NdKTtcbiAgICAgIGNvbnN0IHJlcG9ydCA9IEpTT04ucGFyc2UocnVuKFwibGx2bS1jb3ZcIiwgW1wiZXhwb3J0XCIsIC4uLmNvdmVyYWdlQXJnc10sIHsgc3RkaW86IFwicGlwZVwiIH0pKSBhcyB7XG4gICAgICAgIGRhdGE6IHsgdG90YWxzOiBSZWNvcmQ8c3RyaW5nLCB7IGNvdW50OiBudW1iZXI7IHBlcmNlbnQ6IG51bWJlciB9PiB9W107XG4gICAgICB9O1xuICAgICAgd3JpdGVGaWxlU3luYyhcImNvdmVyYWdlL3JlcG9ydC5qc29uXCIsIEpTT04uc3RyaW5naWZ5KHJlcG9ydCkpO1xuICAgICAgYXNzZXJ0Lm9rKHJlcG9ydC5kYXRhWzBdLCBcIkxMVk0gY292ZXJhZ2UgZGlkIG5vdCByZXBvcnQgdG90YWxzXCIpO1xuICAgICAgY29uc3QgdG90YWwgPSByZXBvcnQuZGF0YVswXS50b3RhbHM7XG4gICAgICBmb3IgKGNvbnN0IFttZXRyaWMsIG1pbmltdW1dIG9mIE9iamVjdC5lbnRyaWVzKHBvbGljeS5jb3ZlcmFnZSkpIHtcbiAgICAgICAgaWYgKCF0b3RhbFttZXRyaWNdIHx8IHRvdGFsW21ldHJpY10uY291bnQgPT09IDAgfHwgdG90YWxbbWV0cmljXS5wZXJjZW50IDwgbWluaW11bSlcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgJHttZXRyaWN9IGNvdmVyYWdlICR7U3RyaW5nKHRvdGFsW21ldHJpY10/LnBlcmNlbnQgPz8gXCJtaXNzaW5nXCIpfSUgaXMgYmVsb3cgJHtTdHJpbmcobWluaW11bSl9JWAsXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBvcmFyeSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSBlbHNlIGlmIChyb2xlID09PSBcInNhbml0aXplcnNcIikge1xuICAgIGNvbmZpZ3VyZShqb2luKGJ1aWxkcywgXCJzYW5pdGl6ZXJzXCIpLCBbXCItRFdPUktCRU5DSF9TQU5JVElaRVJTPU9OXCJdKTtcbiAgICB0ZXN0KGpvaW4oYnVpbGRzLCBcInNhbml0aXplcnNcIikpO1xuICAgIGNvbmZpZ3VyZShqb2luKGJ1aWxkcywgXCJwb3J0YWJsZVwiKSwgW1wiLURXT1JLQkVOQ0hfU0FOSVRJWkVSUz1PTlwiLCBcIi1EV09SS0JFTkNIX1BPUlRBQkxFX09OTFk9T05cIl0pO1xuICAgIHRlc3Qoam9pbihidWlsZHMsIFwicG9ydGFibGVcIikpO1xuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBFcnJvcihcImV4cGVjdGVkIGJ1aWxkLCByZWxlYXNlLCBmb3JtYXQsIGZvcm1hdC13cml0ZSwgbGludCwgdGVzdCwgY292ZXJhZ2UsIHNhbml0aXplcnMsIG9yIGx0b1wiKTtcbiAgfVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxZQUFZO0FBQ25CLFNBQWdDLGlCQUFpQjtBQUVqRDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLE1BQU0sVUFBVSxTQUFTLFdBQVc7QUFDN0MsU0FBUyxxQkFBcUI7QUFFOUIsU0FBUyxpQkFBaUIsd0JBQTZDO0FBRXZFLGVBQXNCLGdCQUFnQixVQUF1QixjQUFzQixNQUE2QjtBQUM5RyxRQUFNLE9BQU8sUUFBUSxJQUFJO0FBQ3pCLFFBQU0sRUFBRSxVQUFVLElBQUssTUFBTSxPQUMzQixjQUFjLEtBQUssY0FBYyx3QkFBd0IsQ0FBQyxFQUFFO0FBRzlELFFBQU0sRUFBRSxnQkFBZ0IsSUFBSyxNQUFNLE9BQ2pDLGNBQWMsS0FBSyxjQUFjLCtCQUEr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LENBQUMsU0FBaUIsS0FBSyxTQUFTLFVBQVUsQ0FBQztBQUNwRixVQUFJLENBQUMsU0FBUyxPQUFRLE9BQU0sSUFBSSxNQUFNLHlDQUF5QztBQUMvRSxZQUFNLFNBQVMsS0FBSyxXQUFXLGlCQUFpQjtBQUNoRCxVQUFJLGlCQUFpQixDQUFDLFNBQVMsV0FBVyxHQUFHLFVBQVUsTUFBTSxNQUFNLENBQUM7QUFDcEUsWUFBTSxjQUFjLFFBQVEsT0FBTyxDQUFDLFNBQVMsQ0FBQyxLQUFLLFdBQVcsUUFBUSxHQUFHLEVBQUUsQ0FBQztBQUM1RSxZQUFNLGVBQWU7QUFBQSxRQUNuQixLQUFLLGNBQWMsYUFBYSxNQUFNLEVBQUU7QUFBQSxRQUN4QztBQUFBLFFBQ0EsS0FBSyxjQUFjLFFBQVEsTUFBTSxFQUFFO0FBQUEsUUFDbkM7QUFBQSxRQUNBLEtBQUssY0FBYyxXQUFXLE1BQU0sRUFBRTtBQUFBLFFBQ3RDLGtCQUFrQixNQUFNO0FBQUEsUUFDeEIsR0FBRztBQUFBLE1BQ0w7QUFDQSxVQUFJLFlBQVksQ0FBQyxVQUFVLEdBQUcsWUFBWSxDQUFDO0FBQzNDLFlBQU0sU0FBUyxLQUFLLE1BQU0sSUFBSSxZQUFZLENBQUMsVUFBVSxHQUFHLFlBQVksR0FBRyxFQUFFLE9BQU8sT0FBTyxDQUFDLENBQUM7QUFHekYsb0JBQWMsd0JBQXdCLEtBQUssVUFBVSxNQUFNLENBQUM7QUFDNUQsYUFBTyxHQUFHLE9BQU8sS0FBSyxDQUFDLEdBQUcscUNBQXFDO0FBQy9ELFlBQU0sUUFBUSxPQUFPLEtBQUssQ0FBQyxFQUFFO0FBQzdCLGlCQUFXLENBQUMsUUFBUSxPQUFPLEtBQUssT0FBTyxRQUFRLE9BQU8sUUFBUSxHQUFHO0FBQy9ELFlBQUksQ0FBQyxNQUFNLE1BQU0sS0FBSyxNQUFNLE1BQU0sRUFBRSxVQUFVLEtBQUssTUFBTSxNQUFNLEVBQUUsVUFBVTtBQUN6RSxnQkFBTSxJQUFJO0FBQUEsWUFDUixHQUFHLE1BQU0sYUFBYSxPQUFPLE1BQU0sTUFBTSxHQUFHLFdBQVcsU0FBUyxDQUFDLGNBQWMsT0FBTyxPQUFPLENBQUM7QUFBQSxVQUNoRztBQUFBLE1BQ0o7QUFBQSxJQUNGLFVBQUU7QUFDQSxhQUFPLFdBQVcsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNwRDtBQUFBLEVBQ0YsV0FBVyxTQUFTLGNBQWM7QUFDaEMsY0FBVSxLQUFLLFFBQVEsWUFBWSxHQUFHLENBQUMsMkJBQTJCLENBQUM7QUFDbkUsU0FBSyxLQUFLLFFBQVEsWUFBWSxDQUFDO0FBQy9CLGNBQVUsS0FBSyxRQUFRLFVBQVUsR0FBRyxDQUFDLDZCQUE2Qiw4QkFBOEIsQ0FBQztBQUNqRyxTQUFLLEtBQUssUUFBUSxVQUFVLENBQUM7QUFBQSxFQUMvQixPQUFPO0FBQ0wsVUFBTSxJQUFJLE1BQU0seUZBQXlGO0FBQUEsRUFDM0c7QUFDRjsiLCJuYW1lcyI6WyJwYXRoIl0sImZpbGUiOiJzY3JpcHRzL25hdGl2ZS1jLWNoZWNrcy5tanMifQ==
