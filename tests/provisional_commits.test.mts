import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { consumer, distribution, git } from "./fixtures/adoption.mjs";
import { configureGitHooks } from "../src/projects.ts";
import { AgentReviewKind, proposedAgentReview, recordAgentReview, reviewIdentity } from "../src/agent-review.ts";
import { approveReviewFiles, reviewStatus, ReviewSource, reviewedBaselines } from "../src/review-service.ts";
import { GitSnapshot } from "../src/git-snapshot.ts";
import {
  checkProvisionalPush,
  provisionalCommitRequested,
  provisionalEnvironment,
  provisionalMessage,
  reviewedCommit,
} from "../src/commit-history.ts";
import { checkCommitReview } from "../src/commit-workflow.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function fixture() {
  const state = mkdtempSync(join(tmpdir(), "workbench-provisional-state-"));
  temporary.push(state);
  for (const kind of ["DATA", "CONFIG", "STATE", "CACHE"]) vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(state, kind));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = await consumer("demo");
  temporary.push(root);
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  const env = {
    ...process.env,
    PATH: join(distribution, "bin") + delimiter + (process.env.PATH ?? ""),
    WORKBENCH_PROJECT_ROOT: root,
  };
  const invoke = (command: string, args: string[], input?: string) =>
    spawnSync(command, args, { cwd: root, env, encoding: "utf8", input });
  const cli = (...args: string[]) => invoke(process.execPath, [join(distribution, "bin/workbench.mjs"), ...args]);
  const run = (...args: string[]) => {
    const result = cli(...args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  const review = () => {
    const proposed = proposedAgentReview(root, AgentReviewKind.Changes, { staged: true });
    recordAgentReview(
      root,
      {
        ...proposed,
        summary: "Reviewed the test-owned changes",
        verification: "Fixture checks exercise the selected source",
      },
      reviewIdentity(proposed),
      true,
    );
  };
  return { root, state, invoke, cli, run, review };
}

test("provisional commits retain checks and review baselines, cannot be pushed after fast-forwarding, and consolidate into a reviewed commit", async () => {
  const f = await fixture();
  const config = join(f.root, "workbench/config.toml");
  writeFileSync(
    config,
    readFileSync(config, "utf8") +
      '\n[review]\nchanges=true\n\n[[check]]\nname="Source quality"\nrole="lint"\ncommand=["node","quality.cjs"]\n',
  );
  writeFileSync(join(f.root, "source.txt"), "good");
  writeFileSync(
    join(f.root, "quality.cjs"),
    "if(require('node:fs').readFileSync('source.txt','utf8')==='bad')process.exit(7);\n",
  );
  f.run("sync");
  configureGitHooks(f.root, distribution);
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "baseline");
  const base = git(f.root, "rev-parse", "HEAD");
  git(f.root, "branch", "-M", "feature");
  const remote = join(f.state, "remote.git");
  git(f.root, "init", "--bare", "--quiet", remote);
  git(f.root, "remote", "add", "origin", remote);
  git(f.root, "push", "origin", `${base}:refs/heads/main`);
  git(f.root, "config", "trailer.separators", "=");
  const path = "workbench/decisions/ADR-00.md";
  mkdirSync(join(f.root, "workbench/decisions"), { recursive: true });
  const decision = (version: string) =>
    `---\nsummary: Fixture decision.\n---\n\n# ADR-0: Fixture policy\n\n${version}.\n`;
  const stage = (version: string) => {
    writeFileSync(join(f.root, path), decision(version));
    f.run("sync");
    git(f.root, "add", ".");
  };
  stage("First draft");
  const ordinary = f.cli("commit", "-m", "feat: record draft");
  expect(ordinary.status).not.toBe(0);
  expect(ordinary.stderr).toContain("human review");
  const unreviewed = f.cli("commit", "--provisional", "-m", "feat: record draft");
  expect(unreviewed.status).not.toBe(0);
  expect(unreviewed.stderr).toContain("Change review is required");
  writeFileSync(join(f.root, "source.txt"), "bad");
  git(f.root, "add", ".");
  f.review();
  const failed = f.cli("commit", "--provisional", "-m", "feat: record draft");
  expect(failed.status).not.toBe(0);
  expect(failed.stdout + failed.stderr).toContain("Source quality");
  expect(git(f.root, "rev-parse", "HEAD")).toBe(base);
  writeFileSync(join(f.root, "source.txt"), "good");
  git(f.root, "add", ".");
  f.review();
  f.run("commit", "--provisional", "-m", "feat: record draft");
  expect(git(f.root, "log", "-1", "--format=%B")).toContain("Workbench-Provisional: true");
  expect(reviewedCommit(f.root, "HEAD")).toBe(base);
  expect(new GitSnapshot(f.root, { review: true }).head).toBe(base);
  expect(reviewStatus(f.root, ReviewSource.Working).changes).toEqual([
    expect.objectContaining({ path, approved: false }),
  ]);
  stage("Revised draft");
  f.review();
  const piped = f.invoke(
    process.execPath,
    [join(distribution, "bin/workbench.mjs"), "commit", "--provisional", "--file", "-"],
    "refactor: refine draft\n",
  );
  expect(piped.status, piped.stdout + piped.stderr).toBe(0);
  const reviewed = reviewStatus(f.root, ReviewSource.Working);
  approveReviewFiles(
    f.root,
    reviewed.changes.map((change) => ({ path: change.path, digest: change.digest })),
    false,
    ReviewSource.Working,
  );
  stage("Further refinement");
  f.review();
  const message = join(f.state, "commit-message"),
    parent = git(f.root, "rev-parse", "HEAD^");
  writeFileSync(message, "fix: refine proposed decision\n");
  f.run("commit", "--provisional", "--amend", "--file", message);
  expect(git(f.root, "rev-parse", "HEAD^")).toBe(parent);
  expect(reviewedBaselines(f.root).get(path)?.contents).toBe(decision("Revised draft"));
  expect(reviewStatus(f.root, ReviewSource.Working).changes[0]?.approved).toBe(false);
  git(f.root, "checkout", "-b", "integration", base);
  expect(f.invoke("git", ["merge", "--ff-only", "feature"]).status).toBe(0);
  const pushed = f.invoke("git", ["push", "origin", "HEAD:main"]);
  expect(pushed.status).not.toBe(0);
  expect(pushed.stderr).toContain("provisional commits");
  expect(git(f.root, "ls-remote", "origin", "refs/heads/main").split("\t")[0]).toBe(base);
  const final = reviewStatus(f.root, ReviewSource.Working);
  approveReviewFiles(
    f.root,
    final.changes.map((change) => ({ path: change.path, digest: change.digest })),
    false,
    ReviewSource.Working,
  );
  git(f.root, "reset", "--soft", base);
  f.review();
  f.run("commit", "-m", "feat: accept reviewed result");
  expect(git(f.root, "log", "-1", "--format=%B")).not.toContain("Workbench-Provisional");
  const published = f.invoke("git", ["push", "origin", "HEAD:main"]);
  expect(published.status, published.stdout + published.stderr).toBe(0);
  expect(reviewStatus(f.root, ReviewSource.Working).changes).toEqual([]);
});

test("an entirely provisional history retains an empty baseline and cannot reach a new remote", async () => {
  const f = await fixture();
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "Initial draft\n\nWorkbench-Provisional: true");
  expect(reviewedCommit(f.root, "HEAD")).toBe("");
  const snapshot = new GitSnapshot(f.root, { review: true });
  expect(snapshot.committed.size).toBe(0);
  expect(snapshot.staged.has("workbench/CHARTER.md")).toBe(true);
  expect(reviewStatus(f.root, ReviewSource.Working).changes.some((change) => change.charter)).toBe(true);
  expect(() => {
    checkProvisionalPush(f.root, "HEAD", "0".repeat(40));
  }).toThrow(/provisional commit/);
  const original = git(f.root, "rev-parse", "HEAD"),
    replacement = git(f.root, "commit-tree", git(f.root, "write-tree"), "-m", "Unmarked replacement");
  git(f.root, "replace", original, replacement);
  expect(reviewedCommit(f.root, original)).toBe("");
  expect(() => {
    checkProvisionalPush(f.root, "HEAD", "0".repeat(40));
  }).toThrow(/provisional commit/);
});

test("the message hook binds provisional intent to the final trailer and exact staged snapshot", async () => {
  const f = await fixture(),
    path = join(f.state, "message"),
    tree = git(f.root, "write-tree");
  writeFileSync(path, "Draft\n\nWorkbench-Provisional: true\n");
  expect(() => {
    checkCommitReview(f.root, path, tree);
  }).toThrow(/workbench commit --provisional/);
  vi.stubEnv(provisionalEnvironment, tree);
  checkCommitReview(f.root, path, tree);
  writeFileSync(
    path,
    "Draft\n\nWorkbench-Provisional: true\n\n# ------------------------ >8 ------------------------\n" +
      "diff --git a/file b/file\n+" +
      "x".repeat(2 * 1024 * 1024) +
      "\n\nWorkbench-Provisional: false\n",
  );
  checkCommitReview(f.root, path, tree);
  writeFileSync(path, "Draft\n");
  expect(() => {
    checkCommitReview(f.root, path, tree);
  }).toThrow(/requires the Workbench-Provisional/);
  expect(() => provisionalCommitRequested("a".repeat(40))).toThrow(/snapshot changed/);
  for (const message of [
    "Draft\n\nWorkbench-Provisional: false\n",
    "Draft\n\nWorkbench-Provisional: true\nWorkbench-Provisional: true\n",
  ])
    expect(() => provisionalMessage(f.root, message)).toThrow(/reserved/);
});
