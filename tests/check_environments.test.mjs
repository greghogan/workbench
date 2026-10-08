import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

const distribution = resolve(import.meta.dirname, "..");

// This boundary fixture uses POSIX executable stubs; real containers run in Linux CI.
test.skipIf(process.platform === "win32")(
  "environment probes and commands run together, preserve arguments, and propagate failures",
  () => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "workbench-check-environment-")));
    const root = join(temporary, "project");
    const stubs = join(temporary, "bin");
    const selected = join(temporary, "selected");
    for (const path of [root, stubs, selected]) mkdirSync(path);
    const script = (directory, name, body) => {
      const path = join(directory, name);
      writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
      chmodSync(path, 0o755);
    };
    const invoke = (...args) =>
      spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), ...args], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${stubs}:${process.env.PATH}`,
          WORKBENCH_PROJECT_ROOT: root,
          WORKBENCH_DISTRIBUTION_ROOT: distribution,
          TEST_SELECTED_TOOLS: selected,
        },
      });
    const succeeds = (...args) => {
      const result = invoke(...args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result;
    };
    const fails = (...args) => {
      const result = invoke(...args);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      return result;
    };
    try {
      // Execute the requested command with a different tool PATH; this does not imitate Nix.
      // Real Guix and Nix container checks run in CI.
      script(
        stubs,
        "nix",
        'while [ "$1" != --command ]; do shift; done\nshift\nexport PATH="$TEST_SELECTED_TOOLS:$PATH"\nrm -f dependency\nexec "$@"',
      );
      script(stubs, "node", "exit 91");
      script(selected, "node", "echo v24.20.0");
      succeeds("setup-project", root);
      copyFileSync(join(distribution, "workbench/CHARTER.md"), join(root, "workbench/CHARTER.md"));
      const web = join(root, "web");
      mkdirSync(web);
      writeFileSync(join(web, ".node-version"), "24.18.0\n");
      for (const file of ["flake.nix", "flake.lock"]) writeFileSync(join(web, file), "{}\n");
      script(
        web,
        "check",
        'test "$(cat dependency)" = installed\nnode --version > result\npwd >> result\nprintf "%s\\n" "$WORKBENCH_PROJECT_ROOT" "$@" >> result',
      );
      const config = join(root, "workbench/config.toml");
      const initial = readFileSync(config, "utf8");
      const literal = "$(touch unwanted); ' quoted";
      writeFileSync(
        config,
        `${initial}\n[[check]]\nname = "web setup"\nrole = "setup"\npath = "web"\nenvironment = "nix"\ncommand = ["sh", "-c", "printf installed > dependency"]\n` +
          `\n[[check]]\nname = "web"\nrole = "test"\npath = "web"\nenvironment = "nix"\ncommand = ["./check", ${JSON.stringify(literal)}]\n`,
      );
      succeeds("sync");
      succeeds("checks", "run");
      assert.equal(readFileSync(join(web, "result"), "utf8"), `v24.20.0\n${web}\n${root}\n${literal}\n`);
      assert.equal(existsSync(join(web, "unwanted")), false);

      script(web, "check", "exit 42");
      fails("checks", "run");
      rmSync(join(web, "result"));
      script(web, "check", "touch result");
      script(stubs, "nix", "exit 43");
      fails("checks", "run");
      assert.equal(existsSync(join(web, "result")), false);

      writeFileSync(
        config,
        readFileSync(config, "utf8")
          .replace('environment = "nix"', 'environment = "nix-docker"')
          .replace(/nixos\/nix@sha256:[0-9a-f]{64}/, "nixos/nix:latest"),
      );
      assert.match(fails("checks", "run").stderr, /image pinned/);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
