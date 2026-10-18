import { required } from "../src/invariants.ts";
import { approveReview } from "../src/review.ts";
import { installSelectedCollections } from "../src/collection-install.ts";
import { approveLocalPolicy, reviewLocalPolicy } from "../src/local-policy.ts";
import { acknowledgePolicyCompatibility, policyCompatibility } from "../src/policy-compatibility.ts";
import { provider } from "./fixtures/adoption.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

const distribution = resolve(import.meta.dirname, "..");

test("standalone staged gates retain review receipts and verified local collection links", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-standalone-gate-")));
  const invoke = (command: string, ...args: string[]) =>
    spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: undefined,
        GITHUB_ACTIONS: undefined,
        GITLAB_CI: undefined,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.autocrlf",
        GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_KEY_1: "core.symlinks",
        GIT_CONFIG_VALUE_1: "true",
      },
    });
  const run = (command: string, ...args: string[]) => {
    const result = invoke(command, ...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const workbench = (...args: string[]) => run(process.execPath, join(root, "bin/workbench.mjs"), ...args);
  try {
    for (const path of ["bin", "bundle", ".githooks", ".gitattributes", "skills", "languages", "Makefile"])
      cpSync(join(distribution, path), join(root, path), { recursive: true });
    writeFileSync(join(root, ".node-version"), `${process.versions.node}\n`);
    mkdirSync(join(root, "scripts"));
    // Startup recognizes the verified running SDK without acquiring another installation.
    cpSync(join(distribution, "scripts/native-assets.json"), join(root, "scripts/native-assets.json"));
    mkdirSync(join(root, "scripts/keys"));
    cpSync(join(distribution, "scripts/keys/node.asc"), join(root, "scripts/keys/node.asc"));
    // Git permits an empty template without info/exclude; setup must create it when needed.
    run("git", "init", "-q", "--template=");
    workbench("setup");
    copyFileSync(resolve(import.meta.dirname, "fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
    const config = join(root, "workbench/config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace("[checks]", "[checks]\nallow_empty = true"));
    workbench("sync");
    run("git", "add", "workbench/CHARTER.md");
    for (const missing of ["workbench/config.toml", "workbench/projects.toml"]) {
      const before = readFileSync(join(root, ".git/index"));
      const incomplete = invoke("git", "hook", "run", "pre-commit");
      assert.notEqual(incomplete.status, 0);
      assert.ok(incomplete.stderr.includes(`${missing} is missing from the staged tree`), incomplete.stderr);
      assert.match(incomplete.stderr, /Unstaged and untracked files are excluded/);
      assert.deepEqual(readFileSync(join(root, ".git/index")), before);
      run("git", "add", missing);
    }
    writeFileSync(join(root, ".gitignore"), "/gate-runs\n");
    writeFileSync(
      config,
      readFileSync(config, "utf8") +
        '\n[[check]]\nname="Fixture suite"\nrole="test"\ncommand=["node","-e","require(\\"node:fs\\").appendFileSync(\\"gate-runs\\",\\"passed\\\\n\\")"]\n',
    );
    const source = provider(
      root,
      "company",
      "1",
      ["See the [purpose](../CHARTER.md#purpose) and [details](ADR-00/details.md#details)."],
      "public",
      { "details.md": "# Details\n\nCollection supporting material.\n" },
      "# Purpose\n\nCollection context.\n",
    );
    installSelectedCollections(root, [{ source: source.directory, sha256: source.pin.sha256 }], { scope: "local" });
    const localCollections = join(root, "workbench/.local-collections");
    approveLocalPolicy(localCollections, "company", reviewLocalPolicy(localCollections, "company").digest, true);
    acknowledgePolicyCompatibility(root, policyCompatibility(root).digest, true);
    run("git", "add", ".");
    workbench("pre-commit");
    assert.match(workbench("pre-commit"), /Reused successful gate: 1\/1/);
    assert.equal(readFileSync(join(root, "gate-runs"), "utf8"), "passed\n");
    const digest = required(
      /Review digest: ([a-f0-9]{64})/.exec(workbench("review")),
      'Expected fixture value: /Review digest: ([a-f0-9]{64})/.exec(workbench("review"))',
    )[1];
    const unapproved = invoke("git", "hook", "run", "pre-commit");
    assert.notEqual(unapproved.status, 0);
    assert.match(unapproved.stderr, /human review/);
    approveReview(root, required(digest, "Expected fixture value"), true);
    const checked = invoke("git", "hook", "run", "pre-commit");
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout + checked.stderr, /Reused successful gate: 1\/1/);
    // Review the index while structural validation uses its snapshot, independent of unstaged edits.
    writeFileSync(config, "invalid TOML [\n");
    const repeated = invoke("git", "hook", "run", "pre-commit");
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.match(repeated.stdout + repeated.stderr, /Reused successful gate: 1\/1/);
    assert.equal(readFileSync(join(root, "gate-runs"), "utf8"), "passed\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
