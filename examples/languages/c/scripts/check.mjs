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
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.cwd();
if (!process.argv[3]) throw new Error("Supply the pinned Workbench directory through the configured command");
const distribution = resolve(process.argv[3]);
const { cpuBudget } = await import(pathToFileURL(join(distribution, "scripts/cpu-budget.mjs")).href);

const role = process.argv[2];
const builds = process.env.WORKBENCH_BUILD_DIR;
if (!builds) throw new Error("use Workbench checks or a configured Workbench shell for native builds");
const debug = join(builds, "debug");
const policy = JSON.parse(readFileSync("workbench/quality.json", "utf8"));
const suffix = process.platform === "win32" ? ".exe" : "";
const selectedCompiler = process.env.WORKBENCH_COMPILER ?? "clang";
const parallelism = String(cpuBudget());
process.env.CTEST_PARALLEL_LEVEL = parallelism;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.status}`);
  return result.stdout;
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
const sources = ["src", "include", "tests"].flatMap(files).filter((file) => /\.(?:c|cpp|h|hpp)$/.test(file));
function configure(directory, options = [], compiler = selectedCompiler) {
  run(process.execPath, [
    join(distribution, "bin/workbench.mjs"),
    "vcpkg-prepare",
    root,
    directory,
    "--compiler",
    compiler,
  ]);
  process.env.VCPKG_DISABLE_METRICS = "1";
  process.env.VCPKG_FORCE_SYSTEM_BINARIES = "1";
  delete process.env.VCPKG_FORCE_DOWNLOADED_BINARIES;
  process.env.VCPKG_MAX_CONCURRENCY = parallelism;
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
    `-DCMAKE_TOOLCHAIN_FILE=${join(directory, "workbench-vcpkg.cmake")}`,
    ...(process.env.WORKBENCH_LANGUAGE_STANDARD
      ? [`-DWORKBENCH_LANGUAGE_STANDARD=${process.env.WORKBENCH_LANGUAGE_STANDARD}`]
      : []),
    `-DWORKBENCH_COMPILER_FAMILY=${compiler}`,
    `-DWORKBENCH_COMPILER_MINIMUM=${compiler === selectedCompiler ? (process.env.WORKBENCH_COMPILER_MINIMUM ?? "") : ""}`,
    ...options,
  ]);
}
function test(directory, profiles) {
  mkdirSync("coverage", { recursive: true });
  const results = join(root, "coverage", `tests-${directory.slice(builds.length + 1).replaceAll(sep, "-")}.xml`);
  run("cmake", ["--build", directory, "--parallel", parallelism]);
  run("ctest", ["--test-dir", directory, "--output-on-failure", "--no-tests=error", "--output-junit", results], {
    env: { ...process.env, ...(profiles ? { LLVM_PROFILE_FILE: join(profiles, "%p-%m.profraw") } : {}) },
  });
  const report = readFileSync(results, "utf8");
  for (const match of report.matchAll(/<testcase\b([^>]+)>/g)) {
    const name = /\bname="([^"]+)"/.exec(match[1])?.[1];
    const elapsed = Number(/\btime="([^"]+)"/.exec(match[1])?.[1]);
    if (role !== "coverage" && elapsed > policy.slow_test_seconds)
      console.error(`SLOW test ${name}: ${elapsed}s (soft cap ${policy.slow_test_seconds}s; advisory only)`);
  }
}

function verifyRelease(directory) {
  test(directory);
  run(process.execPath, [fileURLToPath(new URL("./release-verify.mjs", import.meta.url)), directory]);
}

function rejectLto(name, options, diagnostic) {
  // Reuse the verified off-mode dependency installation, without reinstalling dependencies.
  const result = spawnSync(
    "cmake",
    [
      "-S",
      ".",
      "-B",
      join(builds, `lto-reject-${name}`),
      "-G",
      "Ninja",
      `-DCMAKE_TOOLCHAIN_FILE=${join(builds, "lto-off", "workbench-vcpkg.cmake")}`,
      "-DVCPKG_MANIFEST_INSTALL=OFF",
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
    mkdirSync("dist", { recursive: true });
    copyFileSync(join(directory, `count${suffix}`), join("dist", `count${suffix}`));
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
    const profiles = files(temporary).filter((file) => file.endsWith(".profraw"));
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
    const report = JSON.parse(run("llvm-cov", ["export", ...coverageArgs], { stdio: "pipe" }));
    writeFileSync("coverage/report.json", JSON.stringify(report));
    const total = report.data[0].totals;
    for (const [metric, minimum] of Object.entries(policy.coverage)) {
      if (!total[metric] || total[metric].count === 0 || total[metric].percent < minimum)
        throw new Error(`${metric} coverage ${total[metric]?.percent ?? "missing"}% is below ${minimum}%`);
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
