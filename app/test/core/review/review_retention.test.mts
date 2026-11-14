import { afterEach, expect, test } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../fixtures/adoption.mjs";
import { committedReview } from "../../../src/core/review/review-units.ts";
import { retainedAcknowledgments } from "../../../src/core/review/review-retention.ts";
import { reviewChangeDigest } from "../../../src/core/review/review-snapshot.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("receipt retention recognizes exact root, merge, mode, deletion and literal-path comparisons, excluding unreachable work", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-review-retention-"));
  temporary.push(root);
  git(root, "init", "-qb", "main");
  mkdirSync(join(root, "workbench/decisions/ADR-00"), { recursive: true });
  writeFileSync(join(root, "workbench/config.toml"), "schema_version=1\n[compatibility]\nrequired=false\n");
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  const path = "workbench/decisions/ADR-00.md",
    support = "workbench/decisions/ADR-00/note[1].txt";
  writeFileSync(join(root, path), "# ADR-0: First choice\n\nOriginal contents.\n");
  writeFileSync(join(root, support), "Retained supporting evidence.\n");
  const commit = (subject: string) => {
    git(root, "commit", "-qm", `${subject}\n\nWorkbench-Provisional: true`);
    return git(root, "rev-parse", "HEAD");
  };
  git(root, "add", ".");
  const initial = commit("Initial policies"),
    rootChanges = committedReview(root, initial).changes;
  git(root, "branch", "feature");
  writeFileSync(join(root, path), "# ADR-0: Main choice\n\nRevised contents.\n");
  git(root, "add", path);
  const revised = commit("Revise main policy"),
    revisions = committedReview(root, revised).changes;
  git(root, "checkout", "-q", "feature");
  writeFileSync(join(root, "workbench/decisions/ADR-01.md"), "# ADR-1: Feature choice\n\nAnother policy.\n");
  git(root, "add", ".");
  commit("Feature policy");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--no-ff", "-qm", "Integrate policy\n\nWorkbench-Provisional: true", "feature");
  const merged = git(root, "rev-parse", "HEAD"),
    mergeChanges = committedReview(root, merged).changes;
  git(root, "update-index", "--chmod=+x", path);
  const mode = commit("Change policy mode"),
    modeChanges = committedReview(root, mode).changes;
  git(root, "rm", "-q", support);
  const deleted = commit("Retire supporting file"),
    deletionChanges = committedReview(root, deleted).changes;
  git(root, "checkout", "-q", "--detach");
  writeFileSync(join(root, path), "# ADR-0: Discarded choice\n\nUnreachable refinement.\n");
  git(root, "add", path);
  const discarded = commit("Discarded policy"),
    discardedChanges = committedReview(root, discarded).changes;
  git(root, "checkout", "-q", "main");
  const actual = [...rootChanges, ...revisions, ...mergeChanges, ...modeChanges, ...deletionChanges];
  expect(actual.some((change) => change.before.startsWith("000000:"))).toBe(true);
  expect(modeChanges.some((change) => change.after.startsWith("100755:"))).toBe(true);
  expect(deletionChanges.some((change) => change.after.startsWith("000000:"))).toBe(true);
  expect(mergeChanges.some((change) => change.path.endsWith("ADR-01.md"))).toBe(true);
  expect(retainedAcknowledgments(root, [...actual, ...discardedChanges])).toEqual(
    new Set(actual.map(reviewChangeDigest)),
  );
  expect(retainedAcknowledgments(root, [])).toEqual(new Set());
});
