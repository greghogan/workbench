import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quote } from "../src/toolchains.ts";
import { readLanguageRoots } from "../src/core.ts";
import { afterEach, describe, expect, test } from "vitest";

const repository = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];
const roots = readLanguageRoots(repository).map((entry) => entry.path);
const artifacts = [
  "coverage/tests.json",
  "examples/languages/c/default.profraw",
  "examples/languages/cpp/default.profraw",
  "examples/languages/c/build/count",
  "examples/languages/cpp/coverage/report.json",
  "examples/languages/go/coverage/profile.out",
  "build/output.js",
  "examples/languages/typescript/build/output.js",
  "examples/languages/javascript/build/output.js",
  "examples/languages/java/target/classes/Count.class",
  "examples/languages/java/dist/count.jar",
  "examples/languages/rust/target/debug/binary",
  "examples/languages/rust/dist/release",
  "examples/languages/python/.pytest_cache/state",
  "examples/languages/python/src/package/__pycache__/module.pyc",
  "examples/languages/python/tests/__pycache__/test.pyc",
  "examples/languages/python/src/package.egg-info/PKG-INFO",
  "examples/frameworks/react/build/app.js",
  "examples/frameworks/react/dist/site/index.html",
  "examples/frameworks/react/coverage/tests.json",
];
const dependencies = [
  "node_modules/package/index.js",
  "examples/languages/typescript/node_modules/package/index.js",
  "examples/languages/javascript/node_modules/package/index.js",
  "examples/languages/python/.venv/bin/python",
  "examples/frameworks/react/node_modules/package/index.js",
];
const preserved = [
  "bundle/main.cjs",
  "pnpm-lock.yaml",
  "examples/languages/typescript/src/arithmetic.ts",
  "examples/languages/javascript/src/arithmetic.js",
  "examples/languages/java/pom.xml",
  "examples/languages/java/.mvn/checksums/checksums.sha256",
  "examples/languages/rust/src/main.rs",
  "examples/languages/python/src/package/module.py",
  "examples/languages/python/tests/test.py",
  "examples/frameworks/react/src/Counter.tsx",
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-clean-"));
  temporaryDirectories.push(temporary);
  const project = join(temporary, "project");
  mkdirSync(join(project, "workbench"), { recursive: true });
  for (const file of ["config.toml", "automation.toml", "projects.toml"])
    copyFileSync(join(repository, "workbench", file), join(project, "workbench", file));
  for (const root of roots) {
    mkdirSync(join(project, root), { recursive: true });
    copyFileSync(join(repository, root, "Makefile"), join(project, root, "Makefile"));
  }
  for (const path of [...artifacts, ...dependencies, ...preserved]) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), "fixture\n");
  }
  const external = join(temporary, "external");
  mkdirSync(external);
  writeFileSync(join(external, "keep"), "fixture\n");
  symlinkSync(external, join(project, "examples/languages/python/src/external"));
  return { project, external };
}

function make(directory: string, target: string, external: string) {
  execFileSync(
    "make",
    [
      "--no-print-directory",
      "-C",
      directory,
      target,
      `WORKBENCH=${quote(process.execPath)} ${quote(join(repository, "bundle/main.cjs"))}`,
    ],
    {
      env: {
        ...process.env,
        CARGO_TARGET_DIR: external,
        WORKBENCH_PROJECT_ROOT: directory,
        WORKBENCH_DISTRIBUTION_ROOT: repository,
      },
      stdio: "pipe",
    },
  );
}

// GNU Make is an optional POSIX convenience, separate from the portable Workbench CLI.
describe.skipIf(process.platform === "win32")("project-local cleanup", () => {
  test.each(["clean", "distclean"])("%s cleans all examples without deleting maintained files", (target) => {
    const { project, external } = fixture();
    make(project, target, external);
    for (const path of artifacts) expect(existsSync(join(project, path)), path).toBe(false);
    for (const path of dependencies) expect(existsSync(join(project, path)), path).toBe(target === "clean");
    for (const path of preserved) expect(existsSync(join(project, path)), path).toBe(true);
    expect(existsSync(join(external, "keep"))).toBe(true);
  });

  test("cleanup unlinks an artifact symlink without following it", () => {
    const { project, external } = fixture();
    rmSync(join(project, "build"), { recursive: true });
    symlinkSync(external, join(project, "build"));
    make(project, "clean", external);
    expect(existsSync(join(project, "build"))).toBe(false);
    expect(existsSync(join(external, "keep"))).toBe(true);
  });
});
