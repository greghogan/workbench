import { gitNullConfiguration } from "../../src/core/runtime/windows-host.ts";
import { setConfiguration } from "../../src/core/configuration/config-command.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach } from "vitest";

const distribution = resolve(import.meta.dirname, "../../..");

export function consumerHookFixtures() {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  return () => {
    const temporary = mkdtempSync(join(tmpdir(), "workbench-git-gate-"));
    directories.push(temporary);
    const root = join(temporary, "consumer");
    mkdirSync(root);
    const environment = {
      ...process.env,
      PATH: [join(distribution, "bin"), process.env.PATH ?? ""].join(delimiter),
      GIT_CONFIG_GLOBAL: gitNullConfiguration,
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "core.symlinks",
      GIT_CONFIG_VALUE_1: "true",
      // Keep local submodule clones independent of detached fixture maintenance.
      GIT_CONFIG_KEY_2: "gc.auto",
      GIT_CONFIG_VALUE_2: "0",
      GIT_CONFIG_KEY_3: "maintenance.auto",
      GIT_CONFIG_VALUE_3: "false",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Workbench test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Workbench test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    const invoke = (cwd: string, command: string, ...args: string[]) =>
      spawnSync(command, args, { cwd, encoding: "utf8", env: environment });
    const run = (cwd: string, command: string, ...args: string[]) => {
      const result = invoke(cwd, command, ...args);
      assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
      return result.stdout.trim();
    };
    const git = (cwd: string, ...args: string[]) => run(cwd, "git", ...args);
    const workbench = (...args: string[]) =>
      run(root, process.execPath, join(distribution, "bin/workbench.mjs"), ...args);
    const gate = () => invoke(root, "git", "hook", "run", "pre-commit");
    const rejected = () => {
      const result = gate();
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      return result.stderr;
    };
    git(root, "init", "-q");
    workbench("init", "--hooks", "--no-workbench-collection");
    copyFileSync(
      resolve(import.meta.dirname, "../../resources/verification/CHARTER.md"),
      join(root, "workbench/CHARTER.md"),
    );
    const config = join(root, "workbench/config.toml");
    setConfiguration(root, "checks.allow_empty", "true", "project");
    workbench("sync");
    git(root, "add", ".");
    return { root, config, git, workbench, gate, rejected };
  };
}
