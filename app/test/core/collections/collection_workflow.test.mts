import { required } from "../../../src/core/runtime/invariants.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { consumer, provider, distribution, git } from "../../fixtures/adoption.mjs";
import { readConfig } from "../../../src/core/projects/project-configuration.ts";
import { collectionOriginals, collectionRepository } from "../../../src/core/collections/collection-git.ts";
import { collectionWorkflowFixtures } from "../../fixtures/collection-workflow.mjs";
import { validate } from "../../../src/core/records/validation.ts";

const { prepare, temporary } = collectionWorkflowFixtures();

test("a consumer adopts, clones offline, fetches, and reconciles a collection", async () => {
  const { root, scratch, source, cli, approve, gate } = await prepare();
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
  cli(clone, "project", "add", clone);
  expect(existsSync(collectionRepository(clone, "company"))).toBe(false);
  expect(() => collectionOriginals(clone, required(pin, "Fixture value pin"))).toThrow(/fetch/);
  const context = readFileSync(join(clone, "AGENTS.md"));
  const hidden = join(root, ".git/provider-fixtures/unavailable");
  renameSync(source.directory, hidden);
  try {
    cli(clone, "sync");
    await validate(clone);
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
  await validate(clone);
  cli(clone, "collection", "stage", "company");
  git(clone, "add", ".");
  git(clone, "commit", "-qm", "Reconcile collection fixture");
  expect(git(clone, "ls-tree", "HEAD", ".workbench/collections/company")).toBe(
    `160000 commit ${next.commit}\t.workbench/collections/company`,
  );
  expect(readdirSync(join(clone, ".workbench/collections/company"))).toEqual([]);
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
