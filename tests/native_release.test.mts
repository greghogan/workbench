import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const repository = resolve(import.meta.dirname, "..");
let temporary: string;
afterEach(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32").each(["", "gcc-current"])(
  "CI archives artifacts from the resolved external distribution directory (toolchain: %s)",
  (toolchain) => {
    temporary = mkdtempSync(join(tmpdir(), "workbench-ci-release-"));
    const project = join(temporary, "project");
    const distribution = join(temporary, "distribution");
    const output = join(temporary, "external artifacts");
    const reports = join(temporary, "reports");
    for (const directory of [join(project, "app/dist"), join(distribution, "bin")])
      mkdirSync(directory, { recursive: true });
    writeFileSync(join(project, "app/dist/old.txt"), "previous local artifact");
    writeFileSync(
      join(distribution, "bin/workbench.mjs"),
      `
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    const selected = args.includes('--toolchain') ? args[args.indexOf('--toolchain') + 1] : '';
    const output = selected === process.env.CHECK_TOOLCHAIN ? process.env.ARTIFACT_FIXTURE : join(process.env.ARTIFACT_FIXTURE, 'other-profile');
    if (args[0] === 'paths') console.log(JSON.stringify({ variables: { WORKBENCH_DIST_DIR: output } }));
    else if (args.includes('release')) {
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'application.txt'), 'verified external artifact');
    } else if (!args.includes('release-verify') || readFileSync(join(output, 'application.txt'), 'utf8') !== 'verified external artifact') process.exit(7);
  `,
    );
    const result = spawnSync(process.execPath, [join(repository, "scripts/ci-run.mjs"), "release"], {
      cwd: project,
      env: {
        ...process.env,
        CHECK_ROOTS: JSON.stringify(["app"]),
        CHECK_TOOLCHAIN: toolchain,
        WORKBENCH_DISTRIBUTION_ROOT: distribution,
        ARTIFACT_FIXTURE: output,
        RUNNER_TEMP: reports,
        GITHUB_OUTPUT: undefined,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const archive = join(reports, "release-artifacts/0.tar.gz");
    const extracted = spawnSync("tar", ["-xOf", archive, "./application.txt"], { encoding: "utf8" });
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(extracted.stdout).toBe("verified external artifact");
    expect(readFileSync(join(project, "app/dist/old.txt"), "utf8")).toBe("previous local artifact");
  },
);

// Exercise the adapter's release boundary without downloading dependencies or requiring a host SDK.
test
  .skipIf(process.platform === "win32")
  .each(
    ["success", "tests-fail", "standalone-fails"].flatMap((outcome) =>
      [false, true].map((external) => [outcome, external]),
    ),
  )("native release verifies before replacing a prior artifact: %s (external: %s)", (outcome, external) => {
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
  writeFileSync(join(project, "LICENSE"), "project license");
  const previous = "previous verified release";
  writeFileSync(join(project, "dist/count"), previous);
  const output = external ? join(builds, "dist") : join(project, "dist");
  if (external) {
    mkdirSync(output);
    writeFileSync(join(output, "count"), previous);
  }
  writeFileSync(join(distribution, "bin/workbench.mjs"), "// Dependency preparation is outside this boundary.\n");
  cpSync(join(repository, "scripts/cpu-budget.mjs"), join(distribution, "scripts/cpu-budget.mjs"));
  for (const name of ["check-detail-data.mjs", "values.mjs"])
    cpSync(join(repository, "scripts", name), join(distribution, "scripts", name));
  for (const name of ["check.mjs", "release-verify.mjs"])
    cpSync(join(repository, "examples/languages/c/scripts", name), join(project, "scripts", name));
  const executable = (name: string, source: string) => {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  };
  executable(
    "cmake",
    `import { writeFileSync } from "node:fs";
       import { join } from "node:path";
       if (process.argv[2] === "--build") {
         writeFileSync(join(process.argv[3], "count"), ${JSON.stringify(
           `#!${process.execPath}\nconsole.log(process.argv[2] === '--json' ? JSON.stringify({count: process.argv[4] === '' ? 0 : 3}) : ${String(outcome === "standalone-fails" ? 4 : 3)});\n`,
         )}, { mode: 0o755 });
       }`,
  );
  executable(
    "ctest",
    `import { writeFileSync } from "node:fs";
       writeFileSync(process.argv[process.argv.indexOf("--output-junit") + 1], '<testsuite><testcase name="behavior" time="0.01"></testcase></testsuite>');
       process.exitCode = ${String(outcome === "tests-fail" ? 1 : 0)};`,
  );
  mkdirSync(join(builds, "release"));
  const result = spawnSync(process.execPath, [join(project, "scripts/check.mjs"), "release", distribution], {
    cwd: project,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${String(process.env.PATH)}`,
      WORKBENCH_BUILD_DIR: builds,
      WORKBENCH_DIST_DIR: output,
    },
    encoding: "utf8",
  });
  if (outcome === "success") {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("outside the source checkout");
    expect(readFileSync(join(output, "LICENSE"), "utf8")).toBe("project license");
    expect(readFileSync(join(output, "count"), "utf8")).toBe(readFileSync(join(builds, "release/count"), "utf8"));
  } else {
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(outcome === "tests-fail" ? "ctest failed" : "Standalone release result");
    expect(readFileSync(join(output, "count"), "utf8")).toBe(previous);
  }
  if (external) expect(readFileSync(join(project, "dist/count"), "utf8")).toBe(previous);
});
