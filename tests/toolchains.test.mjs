import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, resolve } from "node:path";
import { test } from "vitest";
import { guardToolchains, resolveCheckCommand } from "../src/toolchains.ts";

test("an empty tool selector fails before scheduling or installing the full toolchain", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "../bin/workbench.mjs"), "tools", "install", "--path", ".", "--tool", ""],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--tool requires a nonempty declared tool name/);
});

function fixture(action) {
  const root = mkdtempSync(join(tmpdir(), "workbench-tools-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  const run = (command, managed = false, env = {}) => {
    const args = guardToolchains(root, command, managed);
    return spawnSync(args[0], args.slice(1), {
      cwd: root,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ...env },
      encoding: "utf8",
    });
  };
  try {
    action({ root, stub, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("host mismatches stop the command, while explicit environment toolchains retain their own versions", () =>
  fixture(({ root, stub, run }) => {
    writeFileSync(join(root, ".node-version"), "24.18.0\n");
    stub("node", "echo v24.20.0");
    const command = ["sh", "-c", "printf reached > result"];
    const mismatch = run(command);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /expected v24.18.0/);
    assert.throws(() => readFileSync(join(root, "result")), { code: "ENOENT" });
    const environment = run(command, true);
    assert.equal(environment.status, 0, environment.stderr);
    assert.match(environment.stdout, /pinned environment.*Node.js[\s\S]*v24.20.0/);
    assert.equal(readFileSync(join(root, "result"), "utf8"), "reached");
    stub("node", "echo v24.18.0");
    assert.equal(run(command).status, 0);
  }));

test("Python checks preserve the inspected interpreter and disable automatic substitutions", () =>
  fixture(({ root, stub, run }) => {
    writeFileSync(join(root, ".python-version"), "3.11.14\n");
    stub(
      "python3",
      'case "$*" in *sys.executable*) echo /selected/python;; *platform*) echo "CPython 3.11.14";; *) echo "Python 3.11.14";; esac',
    );
    const result = run(["sh", "-c", 'printf "%s\\n" "$UV_PYTHON" "$UV_PYTHON_DOWNLOADS"'], false, {
      UV_PYTHON: "/unexpected/python",
      UV_PYTHON_DOWNLOADS: "automatic",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\/selected\/python\nnever\n$/);
    stub("python3", 'echo "PyPy 3.11.14"');
    assert.notEqual(run(["true"]).status, 0);
  }));

test("native metadata is exact and root-local, and command arguments remain literal", () =>
  fixture(({ root, stub, run }) => {
    const pin = join(root, ".node-version");
    writeFileSync(pin, "24\n");
    assert.throws(() => run(["true"]), /exact major.minor.patch/);
    writeFileSync(pin, "24.18.0\n");
    stub("node", "echo v24.18.0");
    const literal = "$(touch unwanted); ' quoted";
    const result = run(["printf", "%s", literal]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.endsWith(literal));
    assert.throws(() => readFileSync(join(root, "unwanted")), { code: "ENOENT" });
    const packageFile = join(root, "package.json");
    for (const version of ["12.6.0", "12.7.0"]) {
      writeFileSync(packageFile, JSON.stringify({ packageManager: `pnpm@${version}` }));
      // Verify version selection and argument forwarding as one external command contract.
      assert.deepEqual(resolveCheckCommand(root, ["{packageManager}", "install", "--frozen-lockfile"], root), [
        "node",
        "bin/workbench.mjs",
        "package-manager-exec",
        "--",
        "install",
        "--frozen-lockfile",
      ]);
    }
    writeFileSync(packageFile, JSON.stringify({ packageManager: "pnpm@latest" }));
    assert.throws(() => resolveCheckCommand(root, ["{packageManager}"], root), /exact version/);
  }));

test("standalone tools use one exact host pin and reject ambiguous declarations", () =>
  fixture(({ root, stub, run }) => {
    const pin = join(root, ".tool-versions");
    writeFileSync(pin, "uv 1.2.3\n");
    stub("uv", 'echo "uv 1.2.4"');
    assert.notEqual(run(["true"]).status, 0);
    stub("uv", 'echo "uv 1.2.3 (build)"');
    assert.equal(run(["true"]).status, 0);
    stub("uv", 'printf "uv 1.2.3\\r\\n"');
    assert.equal(run(["true"]).status, 0);
    stub("uv", 'printf "uv 1.2.4\\r\\n"');
    assert.notEqual(run(["true"]).status, 0);
    writeFileSync(pin, "cargo-llvm-cov 1.2.3\n");
    stub("cargo-llvm-cov", '[ "$1" = llvm-cov ] || exit 2; echo "cargo-llvm-cov 1.2.3"');
    assert.equal(run(["true"]).status, 0);
    writeFileSync(pin, "unknown-package 1.2.3\n");
    assert.throws(() => run(["true"]), /no explicit verification probes/);
    writeFileSync(pin, "uv 1.2.3\nuv 1.2.4\n");
    assert.throws(() => run(["true"]), /unique name/);
  }));

test("native LLVM checks stop before compiling with inherited managed headers", () =>
  fixture(({ root, stub, run }) => {
    writeFileSync(join(root, ".llvm-version"), "23.1.2\n");
    for (const tool of ["clang", "clang++", "clang-format", "clang-tidy", "llvm-cov", "llvm-profdata"])
      stub(tool, 'echo "LLVM version 23.1.2"');
    const command = ["sh", "-c", "printf compiled > result"];
    for (const path of [
      "/gnu/store/fixture/include",
      "/home/user/.guix-profile/include",
      "/nix/store/fixture/include",
    ]) {
      const mixed = run(command, false, { CPATH: path });
      assert.notEqual(mixed.status, 0);
      assert.match(mixed.stderr, /inherited managed header/);
      assert.throws(() => readFileSync(join(root, "result")), { code: "ENOENT" });
    }
    const clean = run(command, false, { CPATH: "", C_INCLUDE_PATH: "", CPLUS_INCLUDE_PATH: "", LIBRARY_PATH: "" });
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(readFileSync(join(root, "result"), "utf8"), "compiled");
    writeFileSync(join(root, ".tool-versions"), "ninja 1.13.2\n");
    stub("ninja", 'echo "1.13.2.git.kitware.jobserver-pipe-1"');
    assert.equal(run(["true"], true).status, 0);
    const environment = { CPATH: "", C_INCLUDE_PATH: "", CPLUS_INCLUDE_PATH: "", LIBRARY_PATH: "" };
    assert.equal(run(["true"], false, environment).status, 0);
    stub("ninja", 'echo "1.13.20.git.kitware.jobserver-pipe-1"');
    assert.notEqual(run(["true"], false, environment).status, 0);
  }));

test("an unavailable LLVM executable reports the required pin and repair before running the command", () =>
  fixture(({ root, stub, run }) => {
    writeFileSync(join(root, ".llvm-version"), "23.1.2\n");
    // Models an executable that is absent or cannot load its runtime libraries.
    stub("clang", 'printf "unavailable LLVM executable\\n" >&2; exit 127');
    const result = run(["sh", "-c", "printf reached > result"], false, {
      CPATH: "",
      C_INCLUDE_PATH: "",
      CPLUS_INCLUDE_PATH: "",
      LIBRARY_PATH: "",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot execute clang for \.llvm-version 23\.1\.2/);
    assert.match(result.stderr, /workbench tools install/);
    assert.throws(() => readFileSync(join(root, "result")), { code: "ENOENT" });
  }));
