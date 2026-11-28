import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { git } from "../../fixtures/adoption.mjs";
import {
  captureCommittedReview,
  commitVersion,
  committedReview,
  pendingCommitReviews,
} from "../../../src/core/review/review-units.ts";
import {
  approveCapturedReviews,
  approveReviewFiles,
  reviewStatus,
  ReviewSource,
} from "../../../src/core/review/review-service.ts";
import { finalizationPlan, finalizeHistory } from "../../../src/core/git/finalization.ts";
import {
  pendingFinalizationStatus,
  queueFinalization,
  resumeFinalization,
} from "../../../src/core/git/finalization-requests.ts";
import { reviewUnitFixture } from "../../fixtures/review-units.mjs";

const { fixture, temporary } = reviewUnitFixture();

test("many retained versions keep real acknowledgments; finalization preserves trees, authors, dirty work, and recovery", () => {
  const f = fixture(),
    commits: string[] = [];
  for (let index = 0; index < 5; index++) {
    const commit = f.commit(`Choice ${String(index)}`);
    commits.push(commit);
    f.agent(commit);
    approveCapturedReviews(f.root, captureCommittedReview(f.root, commit).captured, false);
  }
  expect(pendingCommitReviews(f.root).every((unit) => unit.pending === 0)).toBe(true);
  const captured = finalizationPlan(f.root);
  expect(captured.problems).toEqual([]);
  writeFileSync(join(f.root, "unrelated.txt"), "Uncommitted work\n");
  expect(() => finalizeHistory(f.root, "stale")).toThrow(/changed/);
  const result = finalizeHistory(f.root, captured.digest);
  expect(result.replacements).toHaveLength(5);
  expect(git(f.root, "rev-parse", result.recovery)).toBe(commits.at(-1));
  expect(readFileSync(join(f.root, "unrelated.txt"), "utf8")).toBe("Uncommitted work\n");
  for (const replacement of result.replacements) {
    expect(git(f.root, "show", "-s", "--format=%T %an %ae %aI", replacement.before)).toBe(
      git(f.root, "show", "-s", "--format=%T %an %ae %aI", replacement.after),
    );
    expect(git(f.root, "show", "-s", "--format=%B", replacement.after)).not.toContain("Workbench-Provisional");
    expect(committedReview(f.root, replacement.after).pending).toBe(0);
  }
  expect(finalizationPlan(f.root).units).toEqual([]);
});

test("finalization refuses missing agent evidence, missing human review, and remotely published checkpoints", () => {
  const f = fixture(),
    first = f.commit("Choice");
  expect(finalizationPlan(f.root).problems.join("\n")).toMatch(/human review/);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
  expect(finalizationPlan(f.root).problems.join("\n")).toMatch(/Agent change review/);
  f.agent(first);
  git(f.root, "update-ref", "refs/remotes/origin/draft", first);
  const plan = finalizationPlan(f.root);
  expect(plan.problems.join("\n")).toMatch(/published history/);
  expect(() => finalizeHistory(f.root, plan.digest)).toThrow(/published history/);
  expect(git(f.root, "rev-parse", "HEAD")).toBe(first);
});

test("finalization removes only the reserved trailer from a retained message", () => {
  const f = fixture();
  f.commit("Clarify commit requirements.");
  const body = "Clarify commit requirements.\n\nWorkbench-Provisional: true\nAn example in the body.\n\n";
  const otherTrailers = "Reviewed-by: Fixture\nFollow-up:\n";
  const message = join(f.root, ".git/message");
  writeFileSync(message, `${body}Reviewed-by: Fixture\nWorkbench-Provisional: true\nFollow-up:\n`);
  git(f.root, "commit", "--amend", "--cleanup=verbatim", "--file", message);
  const revision = git(f.root, "rev-parse", "HEAD");
  f.agent(revision);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, revision).captured, false);

  const result = finalizeHistory(f.root, finalizationPlan(f.root).digest);
  expect(commitVersion(f.root, result.after).message).toBe(body + otherTrailers);
});

test("partial finalization preserves pending descendants, the index, and later acknowledgments", () => {
  const f = fixture(),
    first = f.commit("Ready predecessor"),
    pending = f.commit("Pending predecessor");
  writeFileSync(join(f.root, "bridge.txt"), "A regular commit in the provisional ancestry.\n");
  git(f.root, "add", "bridge.txt");
  git(f.root, "commit", "-qm", "Unmarked bridge");
  const later = f.commit("Reviewed successor");
  for (const revision of [first, pending, later]) f.agent(revision);
  for (const revision of [first, later])
    approveCapturedReviews(f.root, captureCommittedReview(f.root, revision).captured, false);
  writeFileSync(join(f.root, "stage.txt"), "Preserve this staged data.\n");
  git(f.root, "add", "stage.txt");
  writeFileSync(join(f.root, "stage.txt"), "Preserve this working edit too.\n");
  const index = readFileSync(join(f.root, ".git/index"));

  const plan = finalizationPlan(f.root);
  expect(plan.eligible).toEqual([first]);
  expect(plan.problems.join("\n")).toMatch(/Earlier provisional work/);
  const operation = finalizeHistory(f.root, plan.digest),
    retained = pendingCommitReviews(f.root);
  expect(operation.finalized).toBe(1);
  expect(retained.map((unit) => [unit.message.split("\n")[0], unit.pending])).toEqual([
    ["Pending predecessor", 1],
    ["Reviewed successor", 0],
  ]);
  expect(commitVersion(f.root, operation.after).tree).toBe(commitVersion(f.root, later).tree);
  expect(readFileSync(join(f.root, ".git/index"))).toEqual(index);
  expect(readFileSync(join(f.root, "stage.txt"), "utf8")).toBe("Preserve this working edit too.\n");
  const next = retained[0]?.revision ?? "";
  expect(next).not.toBe(pending);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, next).captured, false);
  const ready = finalizationPlan(f.root);
  expect(ready.eligible).toEqual(retained.map((unit) => unit.revision));
  finalizeHistory(f.root, ready.digest);
  expect(pendingCommitReviews(f.root)).toEqual([]);
});

test("a published tag protects the complete rewrite even without any remote-tracking branch", () => {
  const f = fixture(),
    first = f.commit("Reviewed local policy"),
    remote = mkdtempSync(join(tmpdir(), "workbench-finalization-remote-"));
  temporary.push(remote);
  git(remote, "init", "--bare", "-q");
  f.agent(first);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
  git(f.root, "tag", "-a", "released", "-m", "Retained release annotation");
  const tag = git(f.root, "rev-parse", "refs/tags/released");
  git(f.root, "remote", "add", "published", remote);
  git(f.root, "push", "-q", "published", "refs/tags/released");
  expect(git(f.root, "for-each-ref", "refs/remotes")).toBe("");
  const plan = finalizationPlan(f.root);
  expect(plan.eligible).toEqual([first]);
  expect(() => finalizeHistory(f.root, plan.digest)).toThrow(/Preserve published tag/);
  expect(git(f.root, "rev-parse", "HEAD")).toBe(first);
  expect(git(f.root, "rev-parse", "refs/tags/released")).toBe(tag);
  expect(git(f.root, "for-each-ref", "refs/workbench/recovery")).toBe("");
});

test("a retained review schedules the branch containing it and waits for a named checkout", () => {
  const f = fixture();
  git(f.root, "switch", "-qc", "feature");
  const feature = f.commit("Feature policy");
  f.agent(feature);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, feature).captured, false);
  git(f.root, "switch", "-q", "main");
  expect(queueFinalization(f.root, { revision: feature })).toEqual(["refs/heads/feature"]);
  resumeFinalization(f.root);
  expect(git(f.root, "rev-parse", "HEAD")).toBe(f.base);
  expect(git(f.root, "rev-parse", "feature")).toBe(feature);
  git(f.root, "switch", "-q", "feature");
  resumeFinalization(f.root);
  expect(commitVersion(f.root, "HEAD")).toMatchObject({
    provisional: false,
    tree: commitVersion(f.root, feature).tree,
  });
  expect(pendingFinalizationStatus(f.root)).toBeUndefined();
});

test("a working record's finalization request survives an unrelated commit", () => {
  const f = fixture();
  writeFileSync(join(f.root, f.path), "---\nsummary: Fixture.\n---\n\n# ADR-0: Fixture\n\nReviewed decision.\n");
  const captured = reviewStatus(f.root, ReviewSource.Working);
  approveReviewFiles(f.root, captured.changes, false, ReviewSource.Working);
  queueFinalization(f.root);
  resumeFinalization(f.root);
  expect(pendingFinalizationStatus(f.root)).toMatch(/retained in Git/);

  writeFileSync(join(f.root, "unrelated.txt"), "Independent work.\n");
  git(f.root, "add", "unrelated.txt");
  git(f.root, "commit", "-qm", "Retain independent work");
  resumeFinalization(f.root);
  expect(pendingFinalizationStatus(f.root)).toMatch(/retained in Git/);

  const delivery = f.commit("Reviewed decision.");
  f.agent(delivery);
  resumeFinalization(f.root);
  expect(commitVersion(f.root, "HEAD")).toMatchObject({
    tree: commitVersion(f.root, delivery).tree,
    provisional: false,
  });
  expect(pendingFinalizationStatus(f.root)).toBeUndefined();
});
