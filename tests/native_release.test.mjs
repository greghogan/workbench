import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const repository = resolve(import.meta.dirname, "..");
let temporary;
afterEach(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

// Exercise the adapter's release boundary without downloading dependencies or requiring a host SDK.
test.skipIf(process.platform === "win32").each(["success", "tests-fail", "standalone-fails"])(
  "native release verifies before replacing a prior artifact: %s",
  (outcome) => {
    temporary = mkdtempSync(join(tmpdir(), "workbench-native-release-"));
    const project = join(temporary, "project");
    const distribution = join(temporary, "distribution");
    const bin = join(temporary, "bin");
    const builds = join(temporary, "builds");
    for (const path of [project, bin, builds, join(distribution, "scripts"), join(distribution, "bin")])
      mkdirSync(path, { recursive: true });
    for (const path of ["src", "include", "tests", "workbench", "dist", "scripts"]) mkdirSync(join(project, path));
    writeFileSync(join(project, "workbench/quality.json"), '{"slow_test_seconds":120}');
    writeFileSync(join(project, "CMakeLists.txt"), "# Native project fixture\n");
    const previous = "previous verified release";
    writeFileSync(join(project, "dist/count"), previous);
    writeFileSync(join(distribution, "bin/workbench.mjs"), "// Dependency preparation is outside this boundary.\n");
    cpSync(join(repository, "scripts/cpu-budget.mjs"), join(distribution, "scripts/cpu-budget.mjs"));
    for (const name of ["check.mjs", "release-verify.mjs"])
      cpSync(join(repository, "examples/languages/c/scripts", name), join(project, "scripts", name));
    const executable = (name, source) =>
      writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
    executable(
      "cmake",
      `import { writeFileSync } from "node:fs";
       import { join } from "node:path";
       if (process.argv[2] === "--build") {
         writeFileSync(join(process.argv[3], "count"), ${JSON.stringify(
           `#!${process.execPath}\nconsole.log(process.argv[2] === '--json' ? JSON.stringify({count: process.argv[4] === '' ? 0 : 3}) : ${outcome === "standalone-fails" ? 4 : 3});\n`,
         )}, { mode: 0o755 });
       }`,
    );
    executable(
      "ctest",
      `import { writeFileSync } from "node:fs";
       writeFileSync(process.argv[process.argv.indexOf("--output-junit") + 1], '<testsuite><testcase name="behavior" time="0.01"></testcase></testsuite>');
       process.exitCode = ${outcome === "tests-fail" ? 1 : 0};`,
    );
    mkdirSync(join(builds, "release"));
    const result = spawnSync(process.execPath, [join(project, "scripts/check.mjs"), "release", distribution], {
      cwd: project,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, WORKBENCH_BUILD_DIR: builds },
      encoding: "utf8",
    });
    if (outcome === "success") {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("outside the source checkout");
      expect(readFileSync(join(project, "dist/count"), "utf8")).toBe(
        readFileSync(join(builds, "release/count"), "utf8"),
      );
    } else {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(outcome === "tests-fail" ? "ctest failed" : "Standalone release result");
      expect(readFileSync(join(project, "dist/count"), "utf8")).toBe(previous);
    }
  },
);
