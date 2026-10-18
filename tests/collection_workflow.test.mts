import { required } from "../src/invariants.ts";
import { approveReview } from "../src/review.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { consumer, provider, distribution, git } from "./fixtures/adoption.mjs";
import { setConfiguration } from "../src/config-command.ts";
import { readConfig } from "../src/core.ts";
import { collectionOriginals, collectionRepository } from "../src/collection-git.ts";
import { snapshotCIProject } from "../src/ci-workspace.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a consumer adopts, commits, clones offline, fetches, reconciles, and snapshots deinitialized collections", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const root = await consumer(),
    scratch = mkdtempSync(join(tmpdir(), "workbench-collection-workflow-"));
  temporary.push(root, scratch);
  setConfiguration(root, "checks.allow_empty", "true");
  const source = provider(root, "company", "1", ["First rule.\n\nMiddle rule.\n\nLast rule."]);
  const environment = { ...process.env, PATH: [join(distribution, "bin"), process.env.PATH ?? ""].join(delimiter) };
  const invoke = (cwd: string, command: string, args: readonly string[]) =>
    spawnSync(command, args, { cwd, env: environment, encoding: "utf8" });
  const cli = (cwd: string, ...args: string[]) => {
    const result = invoke(cwd, process.execPath, [join(distribution, "bin/workbench.mjs"), ...args]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  const approve = (cwd: string) => {
    const digest = /Review digest: ([a-f0-9]{64})/.exec(cli(cwd, "review"))?.[1];
    expect(digest).toBeTruthy();
    approveReview(cwd, required(digest, "Fixture value digest"), true);
  };
  const gate = (cwd: string) => invoke(cwd, "git", ["hook", "run", "pre-commit"]);
  cli(root, "setup", "--id", "consumer");
  cli(root, "collection", "install", source.directory, "--commit", source.commit, "--sha256", source.pin.sha256);
  cli(root, "sync");
  cli(root, "validate");
  expect(git(root, "ls-files", "--stage")).toBe("");
  git(root, "add", ".");
  approve(root);
  const unstagedLink = gate(root);
  expect(unstagedLink.status).not.toBe(0);
  expect(unstagedLink.stderr).toMatch(/staged gitlink/);
  cli(root, "collection", "stage");
  approve(root);
  const staged = gate(root);
  expect(staged.status, staged.stdout + staged.stderr).toBe(0);
  git(root, "commit", "-qm", "Adopt collection fixture");
  expect(git(root, "status", "--porcelain")).toBe("");

  const clone = join(scratch, "clone");
  git(root, "clone", "--quiet", "--no-local", "--no-recurse-submodules", root, clone);
  const pin = required(
    required(readConfig(clone).collections, "Expected fixture value: readConfig(clone).collections").sources,
    "Expected fixture value: readConfig(clone).collections.sources",
  )[0];
  expect(existsSync(collectionRepository(clone, "company"))).toBe(false);
  expect(() => collectionOriginals(clone, required(pin, "Fixture value pin"))).toThrow(/fetch/);
  const context = readFileSync(join(clone, "AGENTS.md"));
  const hidden = join(root, ".git/provider-fixtures/unavailable");
  renameSync(source.directory, hidden);
  try {
    cli(clone, "sync");
    cli(clone, "validate");
    expect(readFileSync(join(clone, "AGENTS.md"))).toEqual(context);
    expect(git(clone, "status", "--porcelain")).toBe("");
  } finally {
    renameSync(hidden, source.directory);
  }
  cli(clone, "collection", "fetch", "company");
  expect(JSON.parse(cli(clone, "collection", "changes", "company"))).toEqual([]);
  const policy = join(clone, "workbench/collections/company/decisions/ADR-00.md");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("First rule.", "Project first rule."));
  const next = provider(root, "company", "2", ["First rule.\n\nMiddle rule.\n\nUpdated last rule."]);
  const index = git(clone, "write-tree");
  cli(clone, "collection", "update", "company", next.directory, "--commit", next.commit, "--sha256", next.pin.sha256);
  expect(git(clone, "write-tree")).toBe(index);
  expect(readFileSync(policy, "utf8")).toContain("Project first rule.");
  expect(readFileSync(policy, "utf8")).toContain("Updated last rule.");
  cli(clone, "sync");
  cli(clone, "validate");
  cli(clone, "collection", "stage", "company");
  git(clone, "add", ".");
  git(clone, "commit", "-qm", "Reconcile collection fixture");
  expect(git(clone, "ls-tree", "HEAD", ".workbench/collections/company")).toBe(
    `160000 commit ${next.commit}\t.workbench/collections/company`,
  );
  expect(readdirSync(join(clone, ".workbench/collections/company"))).toEqual([]);
  const snapshot = join(scratch, "snapshot");
  await snapshotCIProject(clone, snapshot);
  expect(git(snapshot, "ls-files", "--stage", ".workbench/collections/company")).toBe(
    `160000 ${next.commit} 0\t.workbench/collections/company`,
  );
  expect(existsSync(join(snapshot, ".workbench/collections/company/workbench"))).toBe(false);
  expect(existsSync(collectionRepository(snapshot, "company"))).toBe(false);
});

test("staging preflights all collections and preserves unrelated index entries on failure", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const root = await consumer();
  temporary.push(root);
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
    });
  for (const id of ["alpha", "beta"]) {
    const source = provider(root, id);
    const result = cli("collection", "install", source.directory, "--commit", source.commit);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  writeFileSync(join(root, "unrelated.txt"), "staged work\n");
  git(root, "add", "unrelated.txt");
  const index = git(root, "write-tree");
  rmSync(collectionRepository(root, "beta"), { recursive: true });
  const failed = cli("collection", "stage");
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toMatch(/fetch/);
  expect(git(root, "write-tree")).toBe(index);
  expect(git(root, "show", ":unrelated.txt")).toBe("staged work");
  expect(existsSync(join(root, ".workbench/collections/alpha"))).toBe(false);
});
