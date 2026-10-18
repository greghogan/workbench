import { required } from "../src/invariants.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, resolve } from "node:path";
import { test } from "vitest";
import { guardToolchains, resolveCheckCommand } from "../src/toolchains.ts";
import { toolProbes } from "../src/tool-probes.ts";
import type { SpawnSyncReturns } from "child_process";

test.skipIf(spawnSync("python3", ["--version"]).status !== 0)(
  "Python identity probes leave unowned build storage untouched",
  () => {
    fixture(({ root }) => {
      const cache = join(root, "unowned-build"),
        probe = toolProbes({ name: "python", version: "3.15.0", source: "fixture" })[0];
      const result = spawnSync("python3", required(probe, "Expected fixture value: probe").args, {
        env: {
          ...process.env,
          PYTHONPATH: "",
          PYTHONPYCACHEPREFIX: cache,
          PYTHONDONTWRITEBYTECODE: undefined,
          PYTHONNOUSERSITE: "1",
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^CPython /);
      assert.equal(existsSync(cache), false);
    });
  },
);

test("an empty tool selector fails before scheduling or installing the full toolchain", () => {
  fixture(({ root }) => {
    mkdirSync(join(root, "workbench"));
    writeFileSync(
      join(root, "workbench/config.toml"),
      "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
    );
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="app"\npath="."\n');
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../bin/workbench.mjs"), "tools", "install", "--path", ".", "--tool", ""],
      { cwd: root, env: { ...process.env, WORKBENCH_PROJECT_ROOT: root }, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--tool requires a nonempty declared tool name/);
  });
});

interface ToolFixture {
  root: string;
  stub: (name: string, body: string) => void;
  run: (command: string[], managed?: boolean, env?: NodeJS.ProcessEnv, quiet?: boolean) => SpawnSyncReturns<string>;
}
function fixture(action: (fixture: ToolFixture) => void) {
  const root = mkdtempSync(join(tmpdir(), "workbench-tools-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  const run = (command: string[], managed = false, env = {}, quiet = false) => {
    const args = guardToolchains(root, command, managed, {}, quiet);
    return spawnSync(required(args[0], "Guarded command"), args.slice(1), {
      cwd: root,
      env: { ...process.env, PATH: `${bin}${delimiter}${String(process.env.PATH)}`, ...env },
      encoding: "utf8",
    });
  };
  try {
    action({ root, stub, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("host mismatches stop the command, while explicit environment toolchains retain their own versions", () => {
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
    const quiet = run(command, false, {}, true);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stdout, "");
  });
});

test("Python checks preserve the inspected interpreter and disable automatic substitutions", () => {
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
    const offline = run(["sh", "-c", 'printf "%s\\n" "$UV_OFFLINE"'], false, {
      WORKBENCH_OFFLINE: "1",
    });
    assert.equal(offline.status, 0, offline.stderr);
    assert.match(offline.stdout, /true\n$/);
    stub("python3", 'echo "PyPy 3.11.14"');
    assert.notEqual(run(["true"]).status, 0);
  });
});

test("native metadata is exact and root-local, and command arguments remain literal", () => {
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
        join("bin", "workbench.mjs"),
        "package-manager-exec",
        "--",
        "install",
        "--frozen-lockfile",
      ]);
    }
    writeFileSync(packageFile, JSON.stringify({ packageManager: "pnpm@latest" }));
    assert.throws(() => resolveCheckCommand(root, ["{packageManager}"], root), /exact version/);
  });
});

test("standalone tools use one exact host pin and reject ambiguous declarations", () => {
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
  });
});

test("native LLVM checks stop before compiling with inherited managed headers", () => {
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
  });
});

test("an unavailable LLVM executable reports the required pin and repair before running the command", () => {
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
  });
});
