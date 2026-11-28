import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { git } from "../../fixtures/adoption.mjs";
import { captureCommittedReview, pendingCommitReviews } from "../../../src/core/review/review-units.ts";
import { approveCapturedReviews } from "../../../src/core/review/review-service.ts";
import { finalizationPlan, finalizeHistory, resumePreparedFinalization } from "../../../src/core/git/finalization.ts";
import { subscribeDiagnostics } from "../../../src/core/diagnostics/diagnostics.mjs";
import {
  applyInterruptedMoves,
  linkedCheckout,
  preparedMoves,
  recoveryCases,
  refActivationInterrupted,
  stopBeforeRefActivation,
} from "../../fixtures/ref-recovery.mts";
import { reviewUnitFixture } from "../../fixtures/review-units.mjs";

const { fixture } = reviewUnitFixture();

test.for(recoveryCases)(
  "finalization resumes from the linked checkout with %s refs interrupted %s",
  ([format, stage], context) => {
    const f = fixture({ format, context }),
      first = f.commit("Recoverable policy.");
    f.agent(first);
    approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
    const linked = linkedCheckout(f.root, "shared");
    git(f.root, "tag", "-am", "Original annotation", "recovery-test");
    const stop = stopBeforeRefActivation(f.root),
      plan = finalizationPlan(f.root);
    const dirty = join(linked, f.path);
    writeFileSync(dirty, readFileSync(dirty, "utf8") + "\nPrivate edit.\n");
    const staged = git(linked, "write-tree"),
      status = git(linked, "status", "--porcelain");

    expect(() => finalizeHistory(f.root, plan.digest)).toThrow(refActivationInterrupted);
    const moves = preparedMoves(f.root, "finalization");
    expect(moves.map(({ name }) => name)).toEqual(["refs/heads/main", "refs/heads/shared", "refs/tags/recovery-test"]);
    for (const { name, before } of moves) expect(git(f.root, "rev-parse", name)).toBe(before);
    stop();
    applyInterruptedMoves(f.root, moves, stage);
    git(f.root, "reflog", "expire", "--expire=now", "--all");
    git(f.root, "gc", "--prune=now");

    const messages: string[] = [],
      unsubscribe = subscribeDiagnostics(({ message }) => {
        if (message) messages.push(message);
      });
    try {
      expect(resumePreparedFinalization(linked)?.completed).toBe(true);
      expect(resumePreparedFinalization(linked)).toBeUndefined();
    } finally {
      unsubscribe();
    }
    expect(messages.filter((message) => message.includes("reftable"))).toHaveLength(stage === "partial" ? 1 : 0);
    for (const { name, after } of moves) expect(git(f.root, "rev-parse", name)).toBe(after);
    expect(git(f.root, "for-each-ref", "--format=%(contents:subject)", "refs/tags/recovery-test")).toBe(
      "Original annotation",
    );
    expect(git(linked, "status", "--porcelain")).toBe(status);
    expect(git(linked, "write-tree")).toBe(staged);
    expect(pendingCommitReviews(f.root)).toEqual([]);
  },
);

test("automatic finalization leaves prepared refs untouched when review or publication authority changed", () => {
  const f = fixture(),
    first = f.commit("Reviewed but unpublished policy.");
  f.agent(first);
  approveCapturedReviews(f.root, captureCommittedReview(f.root, first).captured, false);
  git(f.root, "tag", "recovery-test");
  const plan = finalizationPlan(f.root);
  const stop = stopBeforeRefActivation(f.root);
  expect(() => finalizeHistory(f.root, plan.digest)).toThrow(refActivationInterrupted);
  stop();
  const moves = preparedMoves(f.root, "finalization");
  git(f.root, "update-ref", "refs/remotes/origin/archive", first);

  expect(() => resumePreparedFinalization(f.root)).toThrow(/Review set changed/);
  for (const { name, before, after } of moves) {
    expect(git(f.root, "rev-parse", name)).toBe(before);
    expect(git(f.root, "cat-file", "-t", after)).toBe("commit");
  }
  git(f.root, "update-ref", "-d", "refs/remotes/origin/archive");
  expect(resumePreparedFinalization(f.root)?.completed).toBe(true);
});
