import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, devNull } from "node:os";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { test } from "vitest";

const distribution = resolve(import.meta.dirname, "..");

function fixture(action, collision = false) {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-update-test-"));
  const module = join(temporary, "module");
  const root = join(temporary, "consumer");
  mkdirSync(module);
  mkdirSync(root);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
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
  const invoke = (cwd, command, ...args) => spawnSync(command, args, { cwd, env, encoding: "utf8" });
  const run = (cwd, command, ...args) => {
    const result = invoke(cwd, command, ...args);
    assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout.trim();
  };
  const git = (cwd, ...args) => run(cwd, "git", "-c", "core.hooksPath=/dev/null", ...args);
  const commit = (cwd) => {
    git(cwd, "add", "--all");
    git(cwd, "commit", "-qm", "Fixture state");
    return git(cwd, "rev-parse", "HEAD");
  };
  const dependency = join(root, ".workbench");
  const cli = (...args) => run(root, process.execPath, join(dependency, "bin/workbench.mjs"), ...args);
  const fail = (...args) => {
    const result = invoke(root, process.execPath, join(dependency, "bin/workbench.mjs"), ...args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  };
  const change = (path, transform) => writeFileSync(path, transform(readFileSync(path, "utf8")));
  try {
    for (const path of [
      "bundle",
      "bin",
      ".githooks",
      "workbench",
      "skills",
      "examples/languages/index.toml",
      "Makefile",
    ])
      cpSync(join(distribution, path), join(module, path), { recursive: true });
    // The fixture distribution has policy and executables, not the repository's language examples.
    writeFileSync(join(module, "workbench/projects.toml"), '[[project]]\nid = "workbench"\npath = "."\n');
    writeFileSync(
      join(module, "workbench/config.toml"),
      'schema_version = 1\n[markdown]\nwrap_width = 120\n[compatibility]\nrequired = false\n[citations]\nlibrary_dir = "library/citations"\n',
    );
    writeFileSync(join(module, ".gitignore"), ".update-collision\n");
    git(module, "init", "-q");
    const old = commit(module);
    git(root, "init", "-q");
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, ".workbench");
    cli("setup", "--id", "consumer");
    copyFileSync(join(distribution, "workbench/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    cli("project", "add", "api", "api");
    copyFileSync(join(distribution, "workbench/CHARTER.md"), join(root, "api/workbench/CHARTER.md"));
    cli("task", "add", "Current task");
    cli("task", "add", "Retained task", "--project", "api");
    change(join(root, "api/workbench/tasks/TSK-00.md"), (text) => text.replace("status: Planned", "status: Done"));
    cli("decision", "add", "Local decision");
    cli("environment", "add", "Hardware");
    change(join(root, "workbench/environments/ENV-00.md"), (text) =>
      text
        .replace("## Hardware configuration", "## Hardware configuration\n\nTest hardware.")
        .replace("## Limits", "## Limits\n\nNo limits."),
    );
    const protocol = join(temporary, "protocol.md");
    writeFileSync(
      protocol,
      "---\nenvironment: consumer:ENV-0\n---\n\n" +
        [
          "Hypothesis",
          "Candidate and baseline",
          "Independent variable",
          "Controls and correctness",
          "Workload",
          "Evaluation rule",
        ]
          .map((heading) => `## ${heading}\n\nProtocol content.\n\n`)
          .join(""),
    );
    cli("experiment", "add", "Retained experiment", "--protocol", protocol);
    change(join(root, "workbench/experiments/EXP-00.md"), (text) =>
      text
        .replace("status: Running", "status: Accepted")
        .replace("## Execution provenance", "## Execution provenance\n\nRecorded host.")
        .replace("## Evidence", "## Evidence\n\n```text\nExact  evidence\n```")
        .replace("## Decision", "## Decision\n\nAccepted with evidence."),
    );
    const config = join(root, "workbench/config.toml");
    change(
      config,
      (text) => text.replace("[checks]", "[checks]\nallow_empty = true") + '\n[update]\nrevision = "upgrade"\n',
    );
    for (const [scope, id] of [
      [root, "consumer"],
      [join(root, "api"), "api"],
    ]) {
      const citation = {
        references: [
          {
            id: `${id}-CIT-0`,
            type: "article",
            title: "Retained citation",
            author: [{ family: "Example" }],
            issued: { "date-parts": [[2026]] },
            URL: "https://example.invalid/pending",
          },
        ],
        workbench: {
          sources: [
            { kind: "pending", "landing-url": "https://example.invalid/pending", status: "pending" },
            {
              kind: "acquired",
              "landing-url": "https://example.invalid/acquired",
              status: "acquired",
              sha256: "a".repeat(64),
            },
            { kind: "unavailable", "landing-url": "https://example.invalid/unavailable", status: "unavailable" },
          ],
        },
      };
      mkdirSync(join(scope, "workbench/citations"), { recursive: true });
      writeFileSync(join(scope, "workbench/citations/CIT-00.yaml"), stringifyYaml(citation));
    }
    cli("format", "--all", "--write");
    cli("sync");
    cli("validate");
    writeFileSync(join(root, "channels.scm"), ";; Human-owned pin\n");
    // A consumer may have a similarly named catalog; the launched distribution must still win.
    mkdirSync(join(root, "examples/languages"), { recursive: true });
    writeFileSync(
      join(root, "examples/languages/index.toml"),
      "Consumer-owned catalog, not Workbench configuration.\n",
    );
    const original = commit(root);
    change(join(module, "workbench/decisions/ADR-00.md"), (text) =>
      text.replace(/^agent_instruction:.*$/m, "agent_instruction: Follow the updated inherited guidance."),
    );
    run(module, process.execPath, join(module, "bin/workbench.mjs"), "format", "--all", "--write");
    run(module, process.execPath, join(module, "bin/workbench.mjs"), "sync");
    if (collision) {
      writeFileSync(join(module, ".update-collision"), "Target revision content\n");
      git(module, "add", "--force", ".update-collision");
    }
    const target = commit(module);
    git(module, "tag", "upgrade");
    action({ root, dependency, old, original, target, cli, fail, git, commit, config, change });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("update validates all scopes with the target executable and leaves a reviewable unstaged diff", () =>
  fixture(({ root, dependency, old, original, target, cli, fail, git, commit, config }) => {
    const unchanged = new Map(
      [
        config,
        "workbench/tasks/TSK-00.md",
        "api/workbench/tasks/TSK-00.md",
        "workbench/experiments/EXP-00.md",
        "workbench/citations/CIT-00.yaml",
      ].map((path) => {
        const absolute = resolve(root, path);
        return [absolute, readFileSync(absolute)];
      }),
    );
    const local = join(root, "workbench/local.toml");
    const preference = '# Local preference\n[checks]\nenvironment="guix"\n';
    writeFileSync(local, preference);
    const index = git(root, "ls-files", "--stage");
    const charter = readFileSync(join(root, "workbench/CHARTER.md"));
    cli("validate");
    const output = cli("update");
    assert.match(output, /Agent context changed/);
    assert.equal(git(dependency, "rev-parse", "HEAD"), target);
    assert.equal(git(root, "rev-parse", "HEAD"), original);
    assert.equal(git(root, "ls-files", "--stage"), index);
    for (const [path, original] of unchanged) assert.deepEqual(readFileSync(path), original);
    assert.equal(readFileSync(local, "utf8"), preference);
    assert.deepEqual(readFileSync(join(root, "workbench/CHARTER.md")), charter);
    assert.equal(readFileSync(join(root, "channels.scm"), "utf8"), ";; Human-owned pin\n");
    assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /Follow the updated inherited guidance/);
    assert.doesNotMatch(cli("task"), /Retained task/);
    assert.match(cli("task", "--all"), /Retained task/);
    cli("validate");
    assert.match(cli("language"), /TypeScript/);
    assert.match(fail("update"), /clean, committed checkout/);
    assert.notEqual(old, target);
    commit(root);
    assert.match(cli("update", "upgrade"), /0 project file\(s\) changed/);
    assert.equal(git(root, "status", "--porcelain"), "");
  }));

test("update failures leave records, pin, and index unchanged", () =>
  fixture(({ root, dependency, old, cli, fail, git, commit, config, change }) => {
    const savedConfig = readFileSync(config, "utf8");
    const index = git(root, "ls-files", "--stage");
    git(root, "update-index", "--assume-unchanged", "workbench/config.toml");
    assert.match(fail("update"), /assume-unchanged or skip-worktree/);
    git(root, "update-index", "--no-assume-unchanged", "workbench/config.toml");
    writeFileSync(join(root, "untracked.txt"), "Unfinished work\n");
    assert.match(fail("update"), /clean, committed checkout/);
    rmSync(join(root, "untracked.txt"));
    writeFileSync(join(dependency, "untracked.txt"), "Unfinished dependency work\n");
    assert.match(fail("update"), /clean, committed checkout/);
    rmSync(join(dependency, "untracked.txt"));
    assert.match(fail("update", "missing-revision"), /git fetch/);
    assert.equal(readFileSync(config, "utf8"), savedConfig);
    assert.equal(git(root, "ls-files", "--stage"), index);
    const task = join(root, "api/workbench/tasks/TSK-00.md");
    change(task, (text) => text.replace("status: Done", "status: Unknown"));
    commit(root);
    const before = readFileSync(task, "utf8");
    assert.match(fail("update"), /preparation or validation failed/);
    assert.equal(readFileSync(task, "utf8"), before);
    assert.equal(readFileSync(config, "utf8"), savedConfig);
    assert.equal(git(dependency, "rev-parse", "HEAD"), old);
    assert.equal(git(root, "status", "--porcelain"), "");
    change(config, (text) => text.replace("schema_version = 1", "schema_version = 999"));
    commit(root);
    assert.match(fail("update"), /workspace schema 999/);
    assert.equal(git(dependency, "rev-parse", "HEAD"), old);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.match(fail("update-prepare"), /internal operation/);
    assert.doesNotMatch(cli("help", "--all"), /COMMAND: workbench update-prepare/);
  }));

test("a dependency checkout collision rolls back prepared changes and preserves ignored work", () =>
  fixture(({ root, dependency, old, fail, git, config }) => {
    const before = readFileSync(config, "utf8");
    const index = git(root, "ls-files", "--stage");
    const path = join(dependency, ".update-collision");
    writeFileSync(path, "Local ignored content\n");
    assert.match(fail("update"), /overwritten by checkout/);
    assert.equal(readFileSync(config, "utf8"), before);
    assert.equal(readFileSync(path, "utf8"), "Local ignored content\n");
    assert.equal(git(dependency, "rev-parse", "HEAD"), old);
    assert.equal(git(root, "ls-files", "--stage"), index);
    assert.equal(git(root, "status", "--porcelain"), "");
  }, true));
