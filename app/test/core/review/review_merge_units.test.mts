import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { git } from "../../fixtures/adoption.mjs";
import {
  captureCommittedReview,
  commitVersion,
  committedReview,
  pendingCommitReviews,
  stagedMergeReview,
} from "../../../src/core/review/review-units.ts";
import { approveCapturedReviews, captureReviews } from "../../../src/core/review/review-service.ts";
import { checkReview } from "../../../src/core/review/review-check.ts";
import {
  AgentReviewKind,
  checkAgentCommit,
  checkAgentUnit,
  proposedAgentReview,
  recordAgentReview,
  reviewIdentity,
} from "../../../src/core/review/agent-review.ts";
import { finalizationPlan, finalizeHistory } from "../../../src/core/git/finalization.ts";
import { prepareTaskDecisionChange, applyTaskDecisionChange } from "../../../src/core/tasks/task-decisions.ts";
import { taskDigest } from "../../../src/core/tasks/task-model.ts";
import { reviewUnitFixture } from "../../fixtures/review-units.mjs";

const { fixture, temporary } = reviewUnitFixture();

test("a ready merge side moves its linked branch and both tag forms together", () => {
  const f = fixture(),
    first = f.commit("Ready merge side");
  f.agent(first);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
  const linked = mkdtempSync(join(tmpdir(), "workbench-finalization-linked-"));
  temporary.push(linked);
  git(f.root, "worktree", "add", "-qb", "linked", linked, first);
  writeFileSync(join(linked, "linked.txt"), "Linked branch source.\n");
  git(linked, "add", "linked.txt");
  git(linked, "commit", "-qm", "Linked descendant");
  const linkedBefore = git(linked, "rev-parse", "HEAD");
  git(f.root, "tag", "light", first);
  git(f.root, "tag", "-a", "annotated", "-m", "Keep this exact annotation", linkedBefore);
  const annotation = git(f.root, "cat-file", "tag", "refs/tags/annotated").split("\n").slice(1).join("\n");
  git(f.root, "switch", "-qc", "pending", f.base);
  mkdirSync(join(f.root, "workbench/decisions"), { recursive: true });
  writeFileSync(
    join(f.root, "workbench/decisions/ADR-01.md"),
    "---\nsummary: Pending side.\n---\n\n# ADR-1: Pending side\n",
  );
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "Pending side\n\nWorkbench-Provisional: true");
  const other = git(f.root, "rev-parse", "HEAD");
  f.agent(other);
  git(f.root, "switch", "-q", "main");
  git(f.root, "merge", "--no-commit", "--no-ff", "pending");
  git(f.root, "commit", "-qm", "Merge both sides\n\nWorkbench-Provisional: true");
  const merge = commitVersion(f.root, "HEAD");
  f.agent(merge.revision);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, merge.revision).captured, false);
  const linkedIndex = readFileSync(join(git(linked, "rev-parse", "--absolute-git-dir"), "index"));

  const plan = finalizationPlan(f.root);
  expect(plan.eligible).toEqual([first]);
  expect(plan.references.map((ref) => ref.name)).toEqual([
    "refs/heads/linked",
    "refs/heads/main",
    "refs/tags/annotated",
    "refs/tags/light",
  ]);
  const result = finalizeHistory(f.root, plan.digest),
    updated = commitVersion(f.root, result.after),
    light = git(f.root, "rev-parse", "refs/tags/light"),
    linkedAfter = git(linked, "rev-parse", "HEAD");
  expect(light).not.toBe(first);
  expect(linkedAfter).not.toBe(linkedBefore);
  expect(updated).toMatchObject({ tree: merge.tree, parents: [light, other], provisional: true });
  expect(committedReview(f.root, updated.revision).pending).toBe(0);
  expect(commitVersion(f.root, light).provisional).toBe(false);
  expect(git(f.root, "rev-parse", "refs/tags/annotated^{commit}")).toBe(linkedAfter);
  expect(git(f.root, "cat-file", "tag", "refs/tags/annotated").split("\n").slice(1).join("\n")).toBe(annotation);
  expect(readFileSync(join(git(linked, "rev-parse", "--absolute-git-dir"), "index"))).toEqual(linkedIndex);
  expect(git(linked, "status", "--porcelain")).toBe("");
});

test("a task across both merge sides waits for all reviews and acceptance in retained history", () => {
  const f = fixture(),
    reference = "demo:TSK-0",
    relative = "workbench/tasks/TSK-00.md",
    task = (outcome: string, status = "Approved") =>
      `---\nstatus: ${status}\n---\n\n# TSK-0: Shared delivery\n\n${outcome}\n`;
  mkdirSync(join(f.root, "workbench/tasks"));
  writeFileSync(join(f.root, relative), task("Deliver both parts."));
  writeFileSync(
    join(f.root, "workbench/config.toml"),
    readFileSync(join(f.root, "workbench/config.toml"), "utf8") + "tasks=true\ntask_approvals=true\n",
  );
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "Approved shared delivery");
  const base = git(f.root, "rev-parse", "HEAD");
  writeFileSync(join(f.root, relative), task("Delivered the first part."));
  git(f.root, "add", relative);
  const first = f.commit("First part policy");
  f.agent(first);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);

  git(f.root, "switch", "-qc", "other", base);
  const secondPath = "workbench/decisions/ADR-01.md",
    secondPolicy = "---\nsummary: Second part policy.\n---\n\n# ADR-1: Second part\n";
  mkdirSync(join(f.root, "workbench/decisions"), { recursive: true });
  writeFileSync(join(f.root, relative), task("Delivered the second part."));
  writeFileSync(join(f.root, secondPath), secondPolicy);
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "Second part\n\nWorkbench-Provisional: true");
  const other = git(f.root, "rev-parse", "HEAD");
  f.agent(other);
  git(f.root, "switch", "-q", "main");
  const combined = "Delivered both parts together.",
    accepted = task(combined, "Accepted");
  writeFileSync(join(f.root, relative), task(combined));
  writeFileSync(join(f.root, secondPath), secondPolicy);
  git(f.root, "add", ".");
  const merge = git(
    f.root,
    "commit-tree",
    git(f.root, "write-tree"),
    "-p",
    first,
    "-p",
    other,
    "-m",
    "Combined delivery\n\nWorkbench-Provisional: true",
  );
  git(f.root, "update-ref", "refs/heads/main", merge, first);
  f.agent(merge);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, merge).captured, false);
  const review = proposedAgentReview(f.root, AgentReviewKind.Task, { commit: merge, base });
  recordAgentReview(
    f.root,
    AgentReviewKind.Task,
    { commit: merge, base },
    {
      expected: reviewIdentity(review),
      summary: "Reviewed both parts together",
      verification: "Verified both retained sides",
    },
  );
  expect(finalizationPlan(f.root).eligible).toEqual([]);

  approveCapturedReviews(f.root, captureCommittedReview(f.root, other).captured, false);
  writeFileSync(join(f.root, relative), accepted);
  applyTaskDecisionChange(
    f.root,
    prepareTaskDecisionChange(f.root, reference, () => [
      {
        reference,
        status: "Accepted",
        updated: new Date().toISOString(),
        digest: taskDigest(accepted),
        outcome: taskDigest(accepted),
      },
    ]),
  );
  const working = finalizationPlan(f.root);
  expect(working.eligible).toEqual([]);
  expect(working.problems.join("\n")).toMatch(/human acceptance is required/);

  git(f.root, "add", relative);
  git(f.root, "commit", "-qm", "Retain delivery acceptance");
  expect(new Set(finalizationPlan(f.root).eligible)).toEqual(new Set([first, other, merge]));

  const amended = task(combined + " Refined the second part after review.", "Accepted");
  writeFileSync(join(f.root, relative), amended);
  git(f.root, "add", relative);
  git(f.root, "commit", "-qm", "Refine the retained outcome");
  expect(finalizationPlan(f.root).eligible).toEqual([]);
  const refreshed = proposedAgentReview(f.root, AgentReviewKind.Task, { commit: "HEAD", base });
  recordAgentReview(
    f.root,
    AgentReviewKind.Task,
    { commit: "HEAD", base },
    {
      expected: reviewIdentity(refreshed),
      summary: "Reviewed the refinement",
      verification: "Verified the complete updated delivery",
    },
  );
  applyTaskDecisionChange(
    f.root,
    prepareTaskDecisionChange(f.root, reference, (previous) => [
      ...previous,
      {
        reference,
        status: "Accepted",
        updated: new Date().toISOString(),
        digest: taskDigest(amended),
        outcome: taskDigest(amended),
      },
    ]),
  );
  const plan = finalizationPlan(f.root);
  expect(new Set(plan.eligible)).toEqual(new Set([first, other, merge]));
  expect(finalizeHistory(f.root, plan.digest).finalized).toBe(3);
  expect(pendingCommitReviews(f.root)).toEqual([]);
});

test("a merge requires review of the result against every parent in order", () => {
  const f = fixture();
  git(f.root, "switch", "-qc", "side");
  writeFileSync(join(f.root, "side.txt"), "Side contribution\n");
  git(f.root, "add", "side.txt");
  git(f.root, "commit", "-qm", "Side contribution");
  const side = git(f.root, "rev-parse", "HEAD");

  git(f.root, "switch", "-q", "main");
  writeFileSync(join(f.root, "main.txt"), "Main contribution\n");
  git(f.root, "add", "main.txt");
  git(f.root, "commit", "-qm", "Main contribution");
  const main = git(f.root, "rev-parse", "HEAD");
  git(f.root, "merge", "--no-commit", "--no-ff", "side");
  writeFileSync(join(f.root, "integration.txt"), "A choice made during the merge\n");
  writeFileSync(join(f.root, f.path), "---\nsummary: Merge choice.\n---\n\n# ADR-0: Integrate both sides\n");
  git(f.root, "add", "integration.txt", f.path);
  const tree = git(f.root, "write-tree");
  const linear = git(f.root, "commit-tree", tree, "-p", main, "-m", "First-parent-only comparison");
  f.agent(linear);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, linear).captured, false);
  expect(() => {
    checkAgentCommit(f.root);
  }).toThrow(/Change review is required/);
  expect(() => {
    checkReview(f.root, tree);
  }).toThrow(/compare the staged merge against each parent/);
  const staged = stagedMergeReview(f.root, tree);
  if (!staged) throw new Error("Expected a staged merge review");
  approveCapturedReviews(f.root, captureReviews(f.root, staged.changes, staged.source, staged.snapshot), false);
  expect(() => {
    checkReview(f.root, tree);
  }).not.toThrow();

  const review = proposedAgentReview(f.root, AgentReviewKind.Changes, { staged: true });
  expect(review.parentTrees).toEqual([
    git(f.root, "rev-parse", main + "^{tree}"),
    git(f.root, "rev-parse", side + "^{tree}"),
  ]);
  recordAgentReview(
    f.root,
    AgentReviewKind.Changes,
    { staged: true },
    {
      expected: reviewIdentity(review),
      summary: "Reviewed both sides and the merge choice",
      verification: "Compared the complete result",
    },
  );
  expect(() => {
    checkAgentCommit(f.root);
  }).not.toThrow();

  git(f.root, "commit", "-qm", "Merge\n\nWorkbench-Provisional: true");
  const merge = commitVersion(f.root, "HEAD");
  expect(committedReview(f.root, merge.revision).pending).toBe(0);
  expect(() => {
    checkAgentUnit(f.root, merge);
  }).not.toThrow();
  expect(() => {
    checkAgentUnit(f.root, { ...merge, parents: [side, main] });
  }).toThrow(/Agent change review/);
  expect(() => {
    checkAgentUnit(f.root, { ...merge, parents: [main, f.base] });
  }).toThrow(/Agent change review/);

  const rewritten = git(
    f.root,
    "commit-tree",
    git(f.root, "rev-parse", side + "^{tree}"),
    "-p",
    f.base,
    "-m",
    "New ID",
  );
  expect(() => {
    checkAgentUnit(f.root, { ...merge, parents: [main, rewritten] });
  }).not.toThrow();
});

test("human merge acknowledgment binds a record to the result and all ordered parents", () => {
  const f = fixture(),
    main = f.commit("Main decision"),
    result = git(f.root, "rev-parse", `${main}^{tree}`);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, main).captured, false);
  git(f.root, "switch", "-qc", "side", f.base);
  mkdirSync(join(f.root, "workbench/decisions"), { recursive: true });
  const side = f.commit("Distinct side decision");
  approveCapturedReviews(f.root, captureCommittedReview(f.root, side).captured, false);
  git(f.root, "switch", "-q", "main");
  const merge = (left: string, right: string) =>
    git(
      f.root,
      "commit-tree",
      result,
      "-p",
      left,
      "-p",
      right,
      "-m",
      "Choose the main decision\n\nWorkbench-Provisional: true",
    );
  const chosen = merge(main, side);
  git(f.root, "update-ref", "refs/heads/main", chosen, main);
  const review = captureCommittedReview(f.root, chosen);
  expect(review.unit.pending).toBe(1);
  expect(review.unit.changes[0]).toMatchObject({ path: f.path, merge: { tree: result } });
  expect(review.unit.changes[0]?.before).toBe(review.unit.changes[0]?.after);
  approveCapturedReviews(f.root, review.captured, false);

  const after = f.commit("Later provisional decision");
  approveCapturedReviews(f.root, captureCommittedReview(f.root, after).captured, false);
  const copied = git(f.root, "commit-tree", result, "-p", f.base, "-m", "Replacement identity");
  expect(committedReview(f.root, merge(copied, side)).pending).toBe(0);
  expect(committedReview(f.root, merge(side, main)).pending).toBe(1);
  expect(committedReview(f.root, chosen).pending).toBe(0);
});
