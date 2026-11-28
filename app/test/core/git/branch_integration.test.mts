import { expect, test, afterEach, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { distribution, git } from "../../fixtures/adoption.mjs";
import { integrateBranch, branchIntegration } from "../../../src/core/git/branch-integration.ts";
import {
  enableArchive,
  transferArchive,
  fetchArchive,
  publishArchive,
} from "../../../src/core/records/archive-workflow.ts";
import { readArchivedFile } from "../../../src/core/records/archive-store.ts";
import { repositoryStatePath, withRepositoryOperation } from "../../../src/core/git/repository-state.ts";
import { withCacheLockSync } from "../../../src/core/storage/cache-lock.ts";

beforeEach(() => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
});
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-integration-"));
  roots.push(root);
  git(root, "init", "-qb", "main");
  git(root, "config", "user.name", "Integration fixture");
  git(root, "config", "user.email", "integration@example.invalid");
  mkdirSync(join(root, "workbench/tasks"), { recursive: true });
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  writeFileSync(join(root, "workbench/state.toml"), '[next]\nTSK="1"\n');
  writeFileSync(
    join(root, "workbench/tasks/TSK-00.md"),
    "---\nstatus: Accepted\n---\n\n# TSK-0: Delivered prerequisite\n\nAccepted work.\n",
  );
  writeFileSync(join(root, "source.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Baseline");
  return root;
}
function archiveFixture() {
  const root = fixture();
  enableArchive(root, { branch: "records", groupSize: 1 });
  git(root, "add", "workbench/config.toml");
  git(root, "commit", "-qm", "Configure archival");
  return root;
}
function commit(root: string, path: string, body: string, message: string) {
  writeFileSync(join(root, path), body);
  git(root, "add", path);
  git(root, "commit", "-qm", message);
}

test("repository admission reports a live history operation and recovers an exited owner without skipping a pending operation", () => {
  const root = fixture();
  const lock = repositoryStatePath(root, "record-operation");
  withCacheLockSync(lock, () => {
    expect(() => {
      withRepositoryOperation(root, () => undefined, "planning");
    }).toThrow(/Another Workbench history operation is running/);
    expect(existsSync(`${lock}.lock/owner.json`)).toBe(true);
  });

  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const { mkdirSync, writeFileSync } = require("node:fs");
const { hostname } = require("node:os");
const { randomUUID } = require("node:crypto");
const path = process.argv[1];
mkdirSync(path);
writeFileSync(path + "/owner.json", JSON.stringify({ host: hostname(), pid: process.pid, token: randomUUID() }));`,
      `${lock}.lock`,
    ],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(0);
  const pending = repositoryStatePath(root, "finalization-operation.json");
  const receipt = JSON.stringify({ version: 1, completed: false, checkout: root });
  writeFileSync(pending, receipt);
  expect(() => {
    withRepositoryOperation(root, () => undefined, "planning");
  }).toThrow(/finalization operation requires recovery/);
  expect(existsSync(`${lock}.lock`)).toBe(false);
  expect(readFileSync(pending, "utf8")).toBe(receipt);
});

test.each(["rebase", "merge"] as const)(
  "%s preserves logical records when the target archived a formerly live record",
  (kind) => {
    const root = archiveFixture();
    git(root, "checkout", "-qb", "feature");
    commit(root, "feature.txt", "feature\n", "Feature work");
    const original = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "main");
    transferArchive(root);
    const target = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "feature");
    const result = integrateBranch(root, kind, { target: "main" });
    expect(result.completed).toBe(true);
    expect(git(root, "rev-parse", result.recovery)).toBe(original);
    expect(git(root, "merge-base", target, "HEAD")).toBe(target);
    expect(readArchivedFile(root, "workbench/tasks/TSK-00.md")?.toString()).toContain("Accepted work");
    expect(readFileSync(join(root, "feature.txt"), "utf8")).toBe("feature\n");
    expect(git(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  },
);

test.each(["rebase", "merge"] as const)(
  "%s resolves staged conflicts through explicit continuation and can abort safely",
  (kind) => {
    const root = archiveFixture();
    git(root, "checkout", "-qb", "feature");
    commit(root, "source.txt", "feature\n", "Feature change");
    const original = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "main");
    commit(root, "source.txt", "upstream\n", "Upstream change");
    transferArchive(root);
    git(root, "checkout", "feature");
    expect(() => integrateBranch(root, kind, { target: "main" })).toThrow(/stopped/);
    expect(() => {
      enableArchive(root);
    }).toThrow(/integration operation requires recovery/);
    writeFileSync(join(root, "source.txt"), "combined\n");
    git(root, "add", "source.txt");
    expect(integrateBranch(root, kind, { action: "continue" }).completed).toBe(true);
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("combined\n");
    expect(git(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    git(root, "checkout", "-qb", "abort-case", original);
    expect(() => integrateBranch(root, kind, { target: "main" })).toThrow(/stopped/);
    expect(integrateBranch(root, kind, { action: "abort" }).completed).toBe(true);
    expect(git(root, "rev-parse", "HEAD")).toBe(original);
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("feature\n");
  },
);

test("a resolved textual conflict cannot hide a conflicting live copy of an archived record", () => {
  const root = archiveFixture(),
    path = "workbench/tasks/TSK-00.md";
  git(root, "checkout", "-qb", "feature");
  commit(root, path, readFileSync(join(root, path), "utf8") + "\nEdited accepted account.\n", "Edit retained account");
  const original = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "main");
  transferArchive(root);
  git(root, "checkout", "feature");
  expect(() => integrateBranch(root, "rebase", { target: "main" })).toThrow(/stopped/);
  git(root, "add", path);
  expect(() => integrateBranch(root, "rebase", { action: "continue" })).toThrow(/Live and archived contents differ/);
  expect(branchIntegration(root)?.completed).toBe(false);
  expect(integrateBranch(root, "rebase", { action: "abort" }).completed).toBe(true);
  expect(git(root, "rev-parse", "HEAD")).toBe(original);
  expect(readFileSync(join(root, path), "utf8")).toContain("Edited accepted account");
});

test("dirty checkouts are refused before refs or fetch state change", () => {
  const root = fixture(),
    before = git(root, "show-ref");
  writeFileSync(join(root, "untracked.txt"), "pending\n");
  expect(() => integrateBranch(root, "rebase", { target: "main" })).toThrow(/clean index/);
  expect(git(root, "show-ref")).toBe(before);
  expect(branchIntegration(root)).toBeUndefined();
});

test("an old feature acquires a target's archive explicitly without activating its configuration", () => {
  const provider = archiveFixture(),
    remote = mkdtempSync(join(tmpdir(), "workbench-integration-remote-"));
  roots.push(remote);
  const original = git(provider, "rev-parse", "HEAD~1");
  git(provider, "init", "--bare", "-q", remote);
  git(provider, "remote", "add", "origin", remote);
  enableArchive(provider, { remote: "origin" });
  git(provider, "add", "workbench/config.toml");
  git(provider, "commit", "-qm", "Select publication remote");
  transferArchive(provider);
  publishArchive(provider);
  const clone = mkdtempSync(join(tmpdir(), "workbench-integration-clone-"));
  roots.push(clone);
  git(provider, "clone", "--no-local", "--single-branch", "--branch", "main", remote, clone);
  git(clone, "config", "user.name", "Integration fixture");
  git(clone, "config", "user.email", "integration@example.invalid");
  git(clone, "checkout", "-qb", "feature", original);
  commit(clone, "feature.txt", "independent feature\n", "Implement feature");
  const config = readFileSync(join(clone, "workbench/config.toml"), "utf8"),
    before = git(clone, "rev-parse", "HEAD");
  expect(() => integrateBranch(clone, "rebase", { target: "origin/main" })).toThrow(/fetch --from/);
  expect(branchIntegration(clone)).toBeUndefined();
  expect(git(clone, "rev-parse", "HEAD")).toBe(before);
  fetchArchive(clone, { from: "origin/main" });
  expect(readFileSync(join(clone, "workbench/config.toml"), "utf8")).toBe(config);
  expect(integrateBranch(clone, "rebase", { target: "origin/main" }).completed).toBe(true);
  expect(readArchivedFile(clone, "workbench/tasks/TSK-00.md")?.toString()).toContain("Accepted work");
  expect(readFileSync(join(clone, "feature.txt"), "utf8")).toBe("independent feature\n");
  expect(git(clone, "status", "--porcelain=v1")).toBe("");
});

test("continuation repairs a stale archive pin while preserving resolved allocation counters", () => {
  const root = archiveFixture();
  transferArchive(root);
  const state = readFileSync(join(root, "workbench/state.toml"), "utf8");
  git(root, "checkout", "-qb", "feature");
  commit(root, "workbench/state.toml", state.replace('TSK="1"', 'TSK="3"'), "Reserve feature records");
  git(root, "checkout", "main");
  commit(
    root,
    "workbench/tasks/TSK-01.md",
    "---\nstatus: Accepted\n---\n\n# TSK-1: Second delivered record\n\nCompleted work.\n",
    "Finish another task",
  );
  commit(root, "workbench/state.toml", state.replace('TSK="1"', 'TSK="2"'), "Reserve upstream record");
  transferArchive(root);
  const archive = git(root, "rev-parse", "records");
  git(root, "checkout", "feature");
  expect(() => integrateBranch(root, "merge", { target: "main" })).toThrow(/stopped/);
  writeFileSync(join(root, "workbench/state.toml"), state.replace('TSK="1"', 'TSK="3"'));
  git(root, "add", "workbench/state.toml");
  const result = integrateBranch(root, "merge", { action: "continue" });
  expect(result.completed).toBe(true);
  expect(result.reconciliation).toBeDefined();
  expect(readFileSync(join(root, "workbench/state.toml"), "utf8")).toContain(archive);
  expect(readFileSync(join(root, "workbench/state.toml"), "utf8")).toContain('TSK="3"');
  expect(readArchivedFile(root, "workbench/tasks/TSK-01.md")?.toString()).toContain("Completed work");
  expect(git(root, "rev-parse", "records")).toBe(archive);
  expect(git(root, "status", "--porcelain=v1")).toBe("");
});

test("the CLI can inspect and abort a rebase with conflicted project configuration", () => {
  const root = fixture(),
    path = "workbench/config.toml",
    before = readFileSync(join(root, path), "utf8");
  git(root, "checkout", "-qb", "feature");
  commit(root, path, before.replace("wrap_width=120", "wrap_width=100"), "Feature formatting policy");
  const original = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "main");
  commit(root, path, before.replace("wrap_width=120", "wrap_width=80"), "Upstream formatting policy");
  git(root, "checkout", "feature");
  expect(() => integrateBranch(root, "rebase", { target: "main" })).toThrow(/stopped/);
  expect(readFileSync(join(root, path), "utf8")).toContain("<<<<<<<");
  for (const action of ["--status", "--abort"]) {
    const result = spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), "rebase", action], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(action === "--status" ? "pending" : "Restored");
  }
  expect(git(root, "rev-parse", "HEAD")).toBe(original);
  expect(readFileSync(join(root, path), "utf8")).toBe(before.replace("wrap_width=120", "wrap_width=100"));
  expect(git(root, "status", "--porcelain=v1")).toBe("");
});
