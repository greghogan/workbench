import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { git } from "../../fixtures/adoption.mjs";
import {
  captureCommittedReview,
  committedReview,
  pendingCommitReviews,
} from "../../../src/core/review/review-units.ts";
import { approveCapturedReviews, reviewStatus, ReviewSource } from "../../../src/core/review/review-service.ts";
import {
  AgentReviewKind,
  proposedAgentReview,
  recordAgentReview,
  reviewIdentity,
} from "../../../src/core/review/agent-review.ts";
import { finalizationPlan, finalizeHistory } from "../../../src/core/git/finalization.ts";
import { reconcileTaskIdentities } from "../../../src/core/git/identity-reconciliation.ts";
import {
  readTaskDecisions,
  prepareTaskDecisionChange,
  applyTaskDecisionChange,
} from "../../../src/core/tasks/task-decisions.ts";
import { retainTaskPlanApproval, readTaskPlanApproval } from "../../../src/core/tasks/task-approvals.ts";
import { taskDigest } from "../../../src/core/tasks/task-model.ts";
import { integrateBranch } from "../../../src/core/git/branch-integration.ts";
import { reviewUnitFixture } from "../../fixtures/review-units.mjs";

const { fixture, temporary } = reviewUnitFixture();

test("later approval cannot approve an earlier intermediate version, and working edits form another unit", () => {
  const f = fixture(),
    first = f.commit("First choice"),
    second = f.commit("Second choice");
  expect(reviewStatus(f.root, ReviewSource.Working).changes).toEqual([]);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, second).captured, false);
  expect(committedReview(f.root, second).pending).toBe(0);
  expect(committedReview(f.root, first).pending).toBe(1);
  rmSync(join(f.root, ".git/workbench/review.json"));
  expect(committedReview(f.root, second).pending).toBe(1);
  expect(committedReview(f.root, "HEAD").revision).toBe(second);
  writeFileSync(join(f.root, f.path), readFileSync(join(f.root, f.path), "utf8") + "Working refinement.\n");
  expect(reviewStatus(f.root, ReviewSource.Working).changes[0]?.approved).toBe(false);
  expect(pendingCommitReviews(f.root).map((unit) => unit.revision)).toEqual([first, second]);
});

test("cached comparisons follow the current Git directory without inheriting another repository's consent", () => {
  const f = fixture(),
    revision = f.commit("Reviewed contents"),
    metadata = mkdtempSync(join(tmpdir(), "workbench-review-stores-")),
    original = join(metadata, "original.git"),
    replacement = join(metadata, "replacement.git");
  temporary.push(metadata);
  renameSync(join(f.root, ".git"), original);
  const select = (directory: string) => {
    writeFileSync(join(f.root, ".git"), `gitdir: ${directory.replaceAll("\\", "/")}\n`);
  };
  select(original);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, revision).captured, false);
  const acknowledged = committedReview(f.root, revision);
  expect(acknowledged.pending).toBe(0);
  const saved = readFileSync(acknowledged.receipt, "utf8");
  git(f.root, "clone", "--bare", original, replacement);
  git(f.root, "--git-dir", replacement, "config", "core.bare", "false");
  git(f.root, "--git-dir", replacement, "config", "core.worktree", f.root);
  select(replacement);
  expect(committedReview(f.root, revision).pending).toBe(1);
  expect(committedReview(f.root, revision).receipt).not.toBe(acknowledged.receipt);
  expect(readFileSync(acknowledged.receipt, "utf8")).toBe(saved);
  select(original);
  expect(committedReview(f.root, revision).pending).toBe(0);
});

test("mechanical renumbering preserves actual plan and document approval, including supporting files", () => {
  const f = fixture(),
    previous = "workbench/tasks/TSK-00",
    next = "workbench/tasks/TSK-01",
    contents = "---\nstatus: Approved\n---\n\n# TSK-0: Deliver a tool\n\nImplement the approved tool.\n",
    at = new Date().toISOString(),
    files = [
      { name: "context.txt", contents: Buffer.from("Supporting context\n").toString("base64"), executable: false },
    ];
  mkdirSync(join(f.root, previous), { recursive: true });
  writeFileSync(join(f.root, previous + ".md"), contents);
  writeFileSync(join(f.root, previous, "context.txt"), "Supporting context\n");
  git(f.root, "add", "workbench/tasks");
  const before = f.commit("Use demo:TSK-0 for this work.");
  const snapshot = retainTaskPlanApproval(f.root, { reference: "demo:TSK-0", at, contents, files });
  applyTaskDecisionChange(
    f.root,
    prepareTaskDecisionChange(f.root, "demo:TSK-0", () => [
      { reference: "demo:TSK-0", status: "Approved", digest: taskDigest(contents), snapshot, updated: at },
    ]),
  );
  approveCapturedReviews(f.root, captureCommittedReview(f.root, before).captured, false);
  renameSync(join(f.root, previous), join(f.root, next));
  renameSync(join(f.root, previous + ".md"), join(f.root, next + ".md"));
  writeFileSync(join(f.root, next + ".md"), contents.replace("TSK-0", "TSK-1"));
  writeFileSync(join(f.root, f.path), readFileSync(join(f.root, f.path), "utf8").replace("demo:TSK-0", "demo:TSK-1"));
  git(f.root, "add", ".");
  git(f.root, "commit", "--amend", "--no-edit", "-q");
  const after = git(f.root, "rev-parse", "HEAD");
  reconcileTaskIdentities(f.root, before, after);
  const approval = readTaskDecisions(f.root).find((decision) => decision.reference === "demo:TSK-1");
  expect(approval?.updated).toBe(at);
  if (!approval) throw new Error("Renumbered plan approval missing");
  expect(readTaskPlanApproval(f.root, approval)?.files).toEqual(files);
  expect(committedReview(f.root, after).pending).toBe(0);
  writeFileSync(
    join(f.root, next + ".md"),
    contents.replace("TSK-0", "TSK-1").replace("approved tool", "different tool"),
  );
  git(f.root, "add", ".");
  git(f.root, "commit", "--amend", "--no-edit", "-q");
  expect(() => {
    reconcileTaskIdentities(f.root, before, git(f.root, "rev-parse", "HEAD"));
  }).toThrow(/lost|meaning/);
  expect(readTaskDecisions(f.root).find((decision) => decision.reference === "demo:TSK-1")?.updated).toBe(at);
});

test("rebasing accepted history without private receipts preserves unchanged document authority and renews agent evidence", () => {
  const f = fixture(),
    first = f.commit("Preserved policy.");
  f.agent(first);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
  const initial = finalizationPlan(f.root);
  finalizeHistory(f.root, initial.digest);
  git(f.root, "branch", "feature");
  const remote = mkdtempSync(join(tmpdir(), "workbench-units-remote-"));
  temporary.push(remote);
  git(f.root, "clone", "--bare", f.root, remote + "/repository.git");
  const clone = join(remote, "clone");
  git(f.root, "clone", remote + "/repository.git", clone);
  git(clone, "config", "user.name", "Fixture");
  git(clone, "config", "user.email", "fixture@example.invalid");
  git(clone, "checkout", "-B", "main", f.base);
  writeFileSync(join(clone, "upstream.txt"), "Additional upstream source.\n");
  git(clone, "add", "upstream.txt");
  git(clone, "commit", "-qm", "Upstream source");
  git(clone, "checkout", "feature");
  expect(existsSync(join(clone, ".git/workbench/review.json"))).toBe(false);
  integrateBranch(clone, "rebase", { target: "main" });
  const units = pendingCommitReviews(clone);
  expect(units).toHaveLength(1);
  expect(units[0]?.pending).toBe(0);
  expect(existsSync(join(clone, ".git/workbench/review.json"))).toBe(false);
  expect(finalizationPlan(clone).problems.join("\n")).toMatch(/Agent change review/);
  const current = proposedAgentReview(clone, AgentReviewKind.Changes, { commit: "HEAD" });
  recordAgentReview(
    clone,
    AgentReviewKind.Changes,
    { commit: "HEAD" },
    {
      expected: reviewIdentity(current),
      summary: "Reviewed the rebased task",
      verification: "Verified the new full snapshot and preserved policy",
    },
  );
  const plan = finalizationPlan(clone);
  expect(plan.problems).toEqual([]);
  finalizeHistory(clone, plan.digest);
  expect(readFileSync(join(clone, "upstream.txt"), "utf8")).toContain("Additional upstream");
  expect(git(clone, "for-each-ref", "--format=%(refname)", "refs/workbench/review-authority")).toBe("");
});
