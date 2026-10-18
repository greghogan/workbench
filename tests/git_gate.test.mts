import { required } from "../src/invariants.ts";
import { quote } from "../src/toolchains.ts";
import { approveReview } from "../src/review.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "vitest";

const distribution = resolve(import.meta.dirname, "..");

test("consumer hooks use the installed command and validate retained collection originals", () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-git-gate-"));
  const dependency = join(temporary, "module");
  const root = join(temporary, "consumer");
  mkdirSync(dependency);
  mkdirSync(root);
  const environment = {
    ...process.env,
    PATH: [join(distribution, "bin"), process.env.PATH ?? ""].join(delimiter),
    GIT_CONFIG_GLOBAL: "/dev/null",
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
  try {
    git(root, "init", "-q");
    workbench("setup");
    copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    const config = join(root, "workbench/config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace("[checks]", "[checks]\nallow_empty = true"));
    workbench("sync");
    git(root, "add", ".");
    const review = workbench("review");
    const digest = required(
      /Review digest: ([a-f0-9]{64})/.exec(review),
      "Expected fixture value: /Review digest: ([a-f0-9]{64})/.exec(review)",
    )[1];
    assert.match(rejected(), /human review/);
    approveReview(root, required(digest, "Expected fixture value"), true);
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

    workbench("record", "add", "task", "Retained task");
    const providerRecord = "exports/company/1/workbench/decisions/ADR-00.md";
    mkdirSync(join(root, "exports/company/1/workbench/decisions"), { recursive: true });
    writeFileSync(join(root, providerRecord), "# Exported provider decision\n");
    git(root, "add", ".");
    const baselineDigest = required(
      /Review digest: ([a-f0-9]{64})/.exec(workbench("review")),
      'Expected fixture value: /Review digest: ([a-f0-9]{64})/.exec(workbench("review"))',
    )[1];
    approveReview(root, required(baselineDigest, "Expected fixture value"), true);
    git(root, "commit", "-qm", "feat: establish consumer");
    git(root, "rm", providerRecord);
    assert.match(workbench("review"), /No protected staged changes/);
    const removedExport = gate();
    assert.equal(removedExport.status, 0, removedExport.stdout + removedExport.stderr);
    git(root, "rm", "workbench/tasks/TSK-00.md");
    assert.match(rejected(), /retain committed records/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("push hooks check distinct outgoing trees, independent of HEAD, index, and dirty files", () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "workbench-push-gate-")));
  const root = join(temporary, "consumer"),
    remote = join(temporary, "remote.git"),
    bin = join(temporary, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  const events = join(temporary, "events.jsonl");
  writeFileSync(
    join(bin, "workbench"),
    `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(join(distribution, "bin/workbench.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: bin + delimiter + (process.env.PATH ?? ""),
    WORKBENCH_DATA_HOME: join(temporary, "data"),
    WORKBENCH_CONFIG_HOME: join(temporary, "config"),
    WORKBENCH_STATE_HOME: join(temporary, "state"),
    WORKBENCH_PROJECT_ROOT: undefined,
    WORKBENCH_LOCAL_CONFIG_ROOT: undefined,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Workbench test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Workbench test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const invoke = (command: string, ...args: string[]) => spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
  const run = (command: string, ...args: string[]) => {
    const result = invoke(command, ...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  const git = (...args: string[]) => run("git", ...args);
  const workbench = (...args: string[]) => run(process.execPath, join(distribution, "bin/workbench.mjs"), ...args);
  try {
    git("init", "-q");
    git("init", "--bare", "-q", remote);
    workbench("setup", "--id", "fixture");
    assert.equal(
      readFileSync(join(root, ".githooks/pre-push"), "utf8"),
      readFileSync(join(distribution, ".githooks/pre-push"), "utf8"),
    );
    copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    const config = join(root, "workbench/config.toml");
    writeFileSync(
      config,
      readFileSync(config, "utf8") +
        '\n[[check]]\nname="Online fixture"\nrole="audit"\nonline=true\ncommand=["node","audit.cjs"]\n',
    );
    writeFileSync(
      join(root, "audit.cjs"),
      `const fs=require('node:fs');const value=fs.readFileSync('value','utf8');fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(value)+'\\n');if(value==='bad')process.exit(1);`,
    );
    writeFileSync(join(root, "value"), "good");
    workbench("sync");
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "feat: establish fixture");
    const good = git("rev-parse", "HEAD");
    git("tag", "-am", "Fixture release", "release", good);
    writeFileSync(join(root, "value"), "bad");
    git("add", "value");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "test: failing outgoing tip");
    const bad = git("rev-parse", "HEAD");
    writeFileSync(join(root, "value"), "unstaged");
    writeFileSync(config, "invalid TOML [\n");
    const index = readFileSync(join(root, ".git/index"));
    git("push", remote, `${good}:refs/heads/good`, `${good}:refs/heads/duplicate`, "refs/tags/release");
    assert.equal(readFileSync(events, "utf8"), '"good"\n');
    const failed = invoke("git", "push", remote, `${bad}:refs/heads/bad`);
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.match(failed.stdout + failed.stderr, /Check gate failed/);
    assert.equal(readFileSync(events, "utf8"), '"good"\n"bad"\n');
    assert.equal(git("ls-remote", remote, "refs/heads/bad"), "");
    git("push", remote, ":refs/heads/good");
    assert.equal(readFileSync(events, "utf8"), '"good"\n"bad"\n');
    const blob = git("rev-parse", `${good}:value`);
    git("tag", "blob", blob);
    assert.match(git("push", remote, "refs/tags/blob"), /does not name a commit/);
    assert.equal(readFileSync(events, "utf8"), '"good"\n"bad"\n');
    assert.deepEqual(readFileSync(join(root, ".git/index")), index);
    assert.equal(readFileSync(join(root, "value"), "utf8"), "unstaged");
    assert.equal(readFileSync(config, "utf8"), "invalid TOML [\n");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
