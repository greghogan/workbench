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
    const forwarded = {};
    for (const path of [root, stubs, selected]) mkdirSync(path);
    const script = (directory: string, name: string, body: string) => {
      const path = join(directory, name);
      writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
      chmodSync(path, 0o755);
    };
    const invoke = (...args: string[]) =>
      spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), ...args], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${stubs}:${String(process.env.PATH)}`,
          WORKBENCH_PROJECT_ROOT: root,
          WORKBENCH_DISTRIBUTION_ROOT: distribution,
          TEST_SELECTED_TOOLS: selected,
          ...forwarded,
        },
      });
    const succeeds = (...args: string[]) => {
      const result = invoke(...args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result;
    };
    const fails = (...args: string[]) => {
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
      copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
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
      succeeds("pre-commit");
      assert.equal(readFileSync(join(web, "result"), "utf8"), `v24.20.0\n${web}\n${root}\n${literal}\n`);
      assert.equal(existsSync(join(web, "unwanted")), false);

      // Mixed environments at one root must execute each selected check exactly once.
      rmSync(join(web, ".node-version"));
      writeFileSync(
        config,
        readFileSync(config, "utf8") +
          '\n[[check]]\nname="native once"\nrole="test"\npath="web"\nenvironment="native"\ncommand=["sh","-c","echo native >> native-executions"]\n' +
          '\n[[check]]\nname="nix once"\nrole="test"\npath="web"\nenvironment="nix"\ncommand=["sh","-c","echo nix >> nix-executions"]\n',
      );
      succeeds("pre-commit");
      assert.equal(readFileSync(join(web, "native-executions"), "utf8"), "native\n");
      assert.equal(readFileSync(join(web, "nix-executions"), "utf8"), "nix\n");
      writeFileSync(join(web, ".node-version"), "24.18.0\n");

      script(web, "check", "exit 42");
      fails("pre-commit");
      rmSync(join(web, "result"));
      script(web, "check", "touch result");
      script(stubs, "nix", "exit 43");
      fails("pre-commit");
      assert.equal(existsSync(join(web, "result")), false);

      writeFileSync(
        config,
        readFileSync(config, "utf8")
          .replace('environment = "nix"', 'environment = "nix-docker"')
          .replace(/nixos\/nix@sha256:[0-9a-f]{64}/, "nixos/nix:latest"),
      );
      assert.match(fails("pre-commit").stderr, /image pinned/);

      // Guix's optional profile argument must be attached to the option, including paths with spaces.
      const environments = join(temporary, "prepared profiles");
      const runtime = join(environments, "runtimes/1");
      mkdirSync(environments);
      mkdirSync(join(runtime, "bin"), { recursive: true });
      writeFileSync(join(environments, "roots.json"), JSON.stringify([".", "web"]));
      script(
        join(runtime, "bin"),
        "guix",
        'test "$1" = shell\nshift\ntest "$1" = "--profile=$TEST_EXPECTED_PROFILE"\nshift\ntest "$1" = --\nshift\nexport PATH="$TEST_SELECTED_TOOLS:$PATH"\nexec "$@"',
      );
      Object.assign(forwarded, {
        WORKBENCH_DEVCONTAINER: "1",
        WORKBENCH_ENVIRONMENTS: environments,
        WORKBENCH_GUIX_TIME_MACHINE_PROFILE: runtime,
        TEST_EXPECTED_PROFILE: join(environments, "1"),
      });
      writeFileSync(
        config,
        `${initial}\n[[check]]\nname="prepared Guix"\nrole="test"\npath="web"\nenvironment="guix"\ncommand=["sh","-c",${JSON.stringify('node --version > prepared-result; printf "%s" "$LD_LIBRARY_PATH" >> prepared-result')}]\n`,
      );
      succeeds("pre-commit");
      assert.ok(
        readFileSync(join(web, "prepared-result"), "utf8").startsWith(
          `v24.20.0\n${join(environments, "1/lib")}:${join(environments, "1/lib64")}`,
        ),
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
