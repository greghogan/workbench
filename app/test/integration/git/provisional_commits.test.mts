import {
  captureCommittedReview,
  committedReview,
  pendingCommitReviews,
} from "../../../src/core/review/review-units.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { git } from "../../fixtures/adoption.mjs";
import {
  approveReviewFiles,
  approveCapturedReviews,
  reviewStatus,
  ReviewSource,
  reviewedBaselines,
} from "../../../src/core/review/review-service.ts";
import { GitSnapshot } from "../../../src/core/git/git-snapshot.ts";
import {
  checkProvisionalPush,
  provisionalCommitRequested,
  provisionalEnvironment,
  provisionalMessage,
  reviewedCommit,
} from "../../../src/core/git/commit-history.ts";
import { checkCommitReview } from "../../../src/cli/commit-workflow.ts";
import { provisionalFixtures } from "../../fixtures/provisional-commits.mjs";

const { fixture, project } = provisionalFixtures();

test("provisional commits retain review baselines and stay local until reviewed publication", async () => {
  const { f, base, path, stage } = await project();
  git(f.root, "branch", "-M", "feature");
  const remote = join(f.state, "remote.git");
  git(f.root, "init", "--bare", "--quiet", remote);
  git(f.root, "remote", "add", "origin", remote);
  git(remote, "fetch", "--quiet", f.root, `${base}:refs/heads/main`);
  f.review();
  f.run("commit", "--provisional", "-m", "feat: record draft");
  expect(git(f.root, "log", "-1", "--format=%B")).toContain("Workbench-Provisional: true");
  expect(reviewedCommit(f.root, "HEAD")).toBe(base);
  expect(new GitSnapshot(f.root).head).toBe(git(f.root, "rev-parse", "HEAD"));
  expect(reviewStatus(f.root, ReviewSource.Working).changes).toEqual([]);
  expect(pendingCommitReviews(f.root)[0]?.changes).toEqual([expect.objectContaining({ path, approved: false })]);
  stage("Revised draft");
  f.review();
  const piped = f.invoke(
    process.execPath,
    [join(f.runtime, "bin/workbench.mjs"), "commit", "--provisional", "--file", "-"],
    "refactor: refine draft\n",
  );
  expect(piped.status, piped.stdout + piped.stderr).toBe(0);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, "HEAD").captured, false);
  stage("Further refinement");
  f.review();
  const message = join(f.state, "commit-message"),
    parent = git(f.root, "rev-parse", "HEAD^");
  writeFileSync(message, "fix: refine proposed decision\n");
  f.run("commit", "--provisional", "--amend", "--file", message);
  expect(git(f.root, "rev-parse", "HEAD^")).toBe(parent);
  expect(reviewedBaselines(f.root).get(path)).toBeUndefined();
  expect(committedReview(f.root, "HEAD").changes[0]?.approved).toBe(false);
  git(f.root, "checkout", "-b", "integration", base);
  expect(f.invoke("git", ["merge", "--ff-only", "feature"]).status).toBe(0);
  const pushed = f.invoke("git", ["push", "origin", "HEAD:main"]);
  expect(pushed.status).not.toBe(0);
  expect(pushed.stderr).toContain("provisional commits");
  expect(git(remote, "rev-parse", "refs/heads/main")).toBe(base);
  git(f.root, "reset", "--soft", base);
  const final = reviewStatus(f.root, ReviewSource.Staged);
  approveReviewFiles(
    f.root,
    final.changes.map((change) => ({ path: change.path, digest: change.digest })),
    false,
  );
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
  const snapshot = new GitSnapshot(f.root);
  expect(snapshot.committed.size).toBeGreaterThan(0);
  expect(snapshot.staged.has("workbench/CHARTER.md")).toBe(true);
  expect(pendingCommitReviews(f.root)[0]?.changes.some((change) => change.charter)).toBe(true);
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
