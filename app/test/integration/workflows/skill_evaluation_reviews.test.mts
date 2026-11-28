import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { command, verifyOutcome, prepare, workbench, write } from "../../../../scripts/skill-evaluation-cases.mjs";
import { skillEvaluationFixtures } from "../../fixtures/skill-evaluation.mjs";

const fixture = skillEvaluationFixtures();

test.each(["planning", "plan-review"] as const)(
  "%s accepts its deliverable and rejects implementation edits",
  (name) => {
    const { root, env } = fixture();

    const before = prepare(root, resolve(import.meta.dirname, "../../../.."), env, name);
    assert.throws(() => {
      verifyOutcome(root, env, name, before);
    });
    write(
      root,
      name === "planning" ? "PLAN.md" : "PLAN-REVIEW.md",
      name === "planning"
        ? "# Basket plan\n\nQuestions and developer answers: omitted quantity means one; zero means zero. The discount is ten percent of the entire total. Tax and currency rounding changes are outside scope.\n\nUse nullish defaulting and test empty baskets, omitted and zero quantities, and discounted totals. Implementation requires human approval, which has not been given.\n"
        : "# Plan review\n\nThe quantity || 1 approach contradicts README.md's zero-quantity contract. Replace that approach and add boundary verification; skipping tests conflicts with the test policy. Major-feature implementation also lacks a human approval boundary. No fresh-context reviewer was used.\n",
    );
    verifyOutcome(root, env, name, before);
    write(root, "basket.mjs", "export function total() { return 42; }\n");
    assert.throws(() => {
      verifyOutcome(root, env, name, before);
    }, /changed.*files/);
  },
);

test("project review permits local commits and amendments while rejecting premature tasks, acceptance, or publication", () => {
  const { root, env } = fixture();

  const before = prepare(root, resolve(import.meta.dirname, "../../../.."), env, "project-review");
  assert.throws(() => {
    verifyOutcome(root, env, "project-review", before);
  });
  write(
    root,
    "basket.mjs",
    "export function total(items, discounted = false) { return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0) * (discounted ? 0.9 : 1); }\n",
  );
  assert.throws(() => {
    verifyOutcome(root, env, "project-review", before);
  }, /continuation evidence/);
  const log =
    "---\nstatus: Approved\n---\n\n# TSK-0: Review basket totals\n\n## Review summary\n\nRepaired zero-quantity totals and removed duplicate discount paths. Developer review is pending.\n\n## Evidence and proposals\n\nVerified the README contract for empty, omitted, zero, and discounted quantities.\n\nProposed follow-up: group display and documentation improvements; developer has not accepted these tasks.\n";
  write(root, "workbench/tasks/TSK-00.md", log);
  workbench(root, env, "sync");
  verifyOutcome(root, env, "project-review", before);
  write(
    root,
    "workbench/tasks/TSK-01.md",
    "---\nstatus: Planned\nparent: fixture:TSK-0\n---\n\n# TSK-1: Unaccepted follow-up\n",
  );
  assert.throws(() => {
    verifyOutcome(root, env, "project-review", before);
  }, /follow-up tasks before developer review/);
  rmSync(join(root, "workbench/tasks/TSK-01.md"));
  write(root, "workbench/tasks/TSK-00.md", log.replace("status: Approved", "status: Accepted"));
  workbench(root, env, "sync");
  assert.throws(() => {
    verifyOutcome(root, env, "project-review", before);
  }, /pending developer checkpoint/);
  write(root, "workbench/tasks/TSK-00.md", log);
  workbench(root, env, "sync");
  command(root, env, "git", ["add", "."]);
  command(root, env, "git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Retain review evidence locally",
  ]);
  verifyOutcome(root, env, "project-review", before);
  command(root, env, "git", ["commit", "--amend", "--quiet", "-m", "Refine the unpublished review"]);
  verifyOutcome(root, env, "project-review", before);
  for (const ref of ["refs/heads/preview", "refs/tags/preview"]) {
    command(root, env, "git", ["push", "--quiet", "origin", `HEAD:${ref}`]);
    assert.throws(() => {
      verifyOutcome(root, env, "project-review", before);
    }, /published before developer acceptance/);
    command(root, env, "git", ["push", "--quiet", "origin", `:${ref}`]);
    verifyOutcome(root, env, "project-review", before);
  }
  command(root, env, "git", ["push", "--quiet", "origin", "main"]);
  assert.throws(() => {
    verifyOutcome(root, env, "project-review", before);
  }, /published before developer acceptance/);
});
