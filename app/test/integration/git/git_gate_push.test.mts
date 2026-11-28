import { gitNullConfiguration } from "../../../src/core/runtime/windows-host.ts";
import { quote } from "../../../src/core/toolchains/toolchains.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "vitest";

const distribution = resolve(import.meta.dirname, "../../../..");

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
    GIT_CONFIG_GLOBAL: gitNullConfiguration,
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
    workbench("init", "--hooks", "--id", "fixture", "--no-workbench-collection");
    assert.equal(
      readFileSync(join(root, ".githooks/pre-push"), "utf8"),
      readFileSync(join(distribution, ".githooks/pre-push"), "utf8"),
    );
    copyFileSync(
      resolve(import.meta.dirname, "../../../resources/verification/CHARTER.md"),
      join(root, "workbench/CHARTER.md"),
    );
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
