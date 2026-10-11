import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

const distribution = resolve(import.meta.dirname, "..");

test("standalone staged gates use the owning checkout's review receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-standalone-gate-"));
  const invoke = (command, ...args) =>
    spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.autocrlf",
        GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_KEY_1: "core.symlinks",
        GIT_CONFIG_VALUE_1: "true",
      },
    });
  const run = (command, ...args) => {
    const result = invoke(command, ...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const workbench = (...args) => run(process.execPath, join(root, "bin/workbench.mjs"), ...args);
  try {
    for (const path of [
      "bin",
      "bundle",
      ".githooks",
      ".gitattributes",
      "skills",
      "languages",
      "collections",
      "Makefile",
    ])
      cpSync(join(distribution, path), join(root, path), { recursive: true });
    // Git permits an empty template without info/exclude; setup must create it when needed.
    run("git", "init", "-q", "--template=");
    workbench("setup");
    copyFileSync(join(distribution, "workbench/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    const config = join(root, "workbench/config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace("[checks]", "[checks]\nallow_empty = true"));
    workbench("sync");
    run("git", "add", ".");
    const digest = /Review digest: ([a-f0-9]{64})/.exec(workbench("review"))[1];
    const unapproved = invoke("git", "hook", "run", "pre-commit");
    assert.notEqual(unapproved.status, 0);
    assert.match(unapproved.stderr, /human review/);
    workbench("review", "approve", "--digest", digest, "--human-written-charters");
    run("git", "hook", "run", "pre-commit");
    // Review the index while structural validation uses its snapshot, independent of unstaged edits.
    writeFileSync(config, "invalid TOML [\n");
    run("git", "hook", "run", "pre-commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public setup gates staged files and rejects a dirty or mismatched Workbench pin", () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-git-gate-"));
  const dependency = join(temporary, "module");
  const root = join(temporary, "consumer");
  mkdirSync(dependency);
  mkdirSync(root);
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.autocrlf",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.symlinks",
    GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Workbench test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Workbench test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const invoke = (cwd, command, ...args) => spawnSync(command, args, { cwd, encoding: "utf8", env: environment });
  const run = (cwd, command, ...args) => {
    const result = invoke(cwd, command, ...args);
    assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout.trim();
  };
  const git = (cwd, ...args) => run(cwd, "git", ...args);
  const workbench = (...args) => run(root, process.execPath, join(root, ".workbench/bin/workbench.mjs"), ...args);
  const gate = () => invoke(root, "git", "hook", "run", "pre-commit");
  const rejected = () => {
    const result = gate();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return result.stderr;
  };
  try {
    for (const path of ["bundle", "bin", ".githooks", "workbench", "skills", "languages", "collections", "Makefile"]) {
      cpSync(join(distribution, path), join(dependency, path), { recursive: true });
    }
    git(dependency, "init", "-q");
    git(dependency, "add", ".");
    git(dependency, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Initial dependency");
    git(root, "init", "-q");
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, ".workbench");
    workbench("setup");
    copyFileSync(join(distribution, "workbench/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    const config = join(root, "workbench/config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace("[checks]", "[checks]\nallow_empty = true"));
    workbench("sync");
    git(root, "add", ".");
    const review = workbench("review");
    const digest = /Review digest: ([a-f0-9]{64})/.exec(review)[1];
    assert.match(rejected(), /human review/);
    workbench("review", "approve", "--digest", digest, "--human-written-charters");
    const initial = gate();
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);

    // The staged gate reads execution preferences from the working checkout without copying them into the snapshot.
    const local = join(root, "workbench/local.toml");
    writeFileSync(local, '[checks]\nenvironment="invalid"\n');
    assert.equal(git(root, "check-ignore", "workbench/local.toml"), "workbench/local.toml");
    assert.match(rejected(), /local.toml: checks.environment/);
    rmSync(local);

    // Unstaged structural damage must not contaminate the staged tree.
    writeFileSync(config, "invalid TOML [\n");
    const isolated = gate();
    assert.equal(isolated.status, 0, isolated.stdout + isolated.stderr);
    git(root, "checkout", "--", "workbench/config.toml");

    const checkout = join(root, ".workbench");
    writeFileSync(join(checkout, "untracked.txt"), "dirty dependency\n");
    assert.match(rejected(), /dependency checkout has uncommitted files/);
    git(checkout, "add", "untracked.txt");
    git(checkout, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "New dependency revision");
    assert.match(rejected(), /does not match the staged dependency revision/);
    git(root, "add", ".workbench");
    assert.equal(gate().status, 0);

    workbench("task", "add", "Retained task");
    git(root, "add", ".");
    git(root, "commit", "-qm", "feat: establish consumer");
    git(root, "rm", "workbench/tasks/TSK-00.md");
    assert.match(rejected(), /retain committed records/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
