import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewSource, reviewStatus, approveReviewFiles, reviewFileContents } from "../src/review-service.ts";
import { stagedRecordTree } from "../src/staged-records.ts";
import { checkReview } from "../src/review.ts";
import {
  RecordCatalog,
  workspaceRecords,
  saveRecord,
  recordBytes,
  supportingFiles,
  contentDigest,
} from "../src/record-service.ts";
import { webFixture } from "./fixtures/web.mjs";
import { git } from "./fixtures/adoption.mjs";
let root: string;
beforeEach(() => {
  root = webFixture();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const stage = (path: string, text: string) => {
  writeFileSync(join(root, path), text);
  git(root, "add", path);
};
test("independent file acknowledgments preserve other reviews and invalidate only changed files", () => {
  stage("workbench/decisions/ADR-00.md", "# Revised first\n");
  stage("workbench/decisions/ADR-01.md", "# Second\n");
  const [first, second] = reviewStatus(root, ReviewSource.Staged).changes;
  if (!first || !second) throw new Error("missing staged fixture");
  approveReviewFiles(root, [first], false);
  expect(reviewStatus(root, ReviewSource.Staged).changes.map((change) => change.approved)).toEqual([true, false]);
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
  approveReviewFiles(root, [second], false);
  checkReview(root);
  stage(first.path, "# New first\n");
  expect(reviewStatus(root, ReviewSource.Staged).changes.map((change) => change.approved)).toEqual([false, true]);
  expect(() => {
    approveReviewFiles(root, [first], false);
  }).toThrow(/digest changed/);
  expect(reviewStatus(root, ReviewSource.Staged).changes[1]?.approved).toBe(true);
});
test("approving another file preserves an acknowledgment while its file is temporarily unstaged", () => {
  stage("workbench/decisions/ADR-00.md", "# First approved change\n");
  stage("workbench/decisions/ADR-01.md", "# Second change\n");
  const [first, second] = reviewStatus(root, ReviewSource.Staged).changes;
  if (!first || !second) throw new Error("missing staged files");
  approveReviewFiles(root, [first], false);
  git(root, "restore", "--staged", first.path);
  approveReviewFiles(root, [second], false);
  git(root, "add", first.path);
  checkReview(root);
  expect(reviewStatus(root, ReviewSource.Staged).changes.every((change) => change.approved)).toBe(true);
});

test("charter authorship is per file; supporting files and deletions require independent review", () => {
  stage("workbench/CHARTER.md", "# Human rewrite\n");
  mkdirSync(join(root, "workbench/experiments/EXP-00"), { recursive: true });
  stage("workbench/experiments/EXP-00.md", "# Experiment\n");
  stage("workbench/experiments/EXP-00/results.txt", "retained evidence\n");
  const changes = reviewStatus(root, ReviewSource.Staged).changes;
  const charter = changes.find((change) => change.charter);
  if (!charter) throw new Error("missing charter fixture");
  expect(() => {
    approveReviewFiles(root, [charter], false);
  }).toThrow(/human authorship/);
  approveReviewFiles(root, [charter], true);
  for (const change of changes.filter((change) => !change.charter)) approveReviewFiles(root, [change], false);
  checkReview(root);
  git(root, "commit", "-qm", "Reviewed fixture");
  git(root, "rm", "workbench/decisions/ADR-00.md");
  const deleted = reviewStatus(root, ReviewSource.Staged).changes[0];
  if (!deleted) throw new Error("missing deletion fixture");
  expect(reviewFileContents(root, deleted.after)).toBeUndefined();
  expect(reviewFileContents(root, deleted.before)?.toString()).toContain("Keep files authoritative");
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
  approveReviewFiles(root, [deleted], false);
  checkReview(root);
});
test("unstaged edits cannot change the snapshot being reviewed; locked receipts reject without losing approvals", () => {
  stage("workbench/decisions/ADR-00.md", "# Staged\n");
  const change = reviewStatus(root, ReviewSource.Staged).changes[0];
  if (!change) throw new Error("missing staged fixture");
  writeFileSync(join(root, change.path), "# Unstaged\n");
  expect(reviewFileContents(root, change.after)?.toString()).toBe("# Staged\n");
  mkdirSync(`${reviewStatus(root, ReviewSource.Staged).receipt}.lock`, { recursive: true });
  expect(() => {
    approveReviewFiles(root, [change], false);
  }).toThrow(/busy/);
  rmSync(`${reviewStatus(root, ReviewSource.Staged).receipt}.lock`, { recursive: true });
  approveReviewFiles(root, [change], false);
  checkReview(root);
  expect(() => {
    approveReviewFiles(root, [], false);
  }).toThrow(/distinct/);
  expect(() => {
    approveReviewFiles(root, [change, change], false);
  }).toThrow(/distinct/);
  writeFileSync(reviewStatus(root, ReviewSource.Staged).receipt, "damaged");
  expect(() => {
    checkReview(root);
  }).toThrow(/human review/);
});
test("record editing preserves exact source, rejects stale drafts, and keeps other kinds read only", () => {
  const adr = workspaceRecords(root).find((record) => record.type === "ADR");
  if (!adr) throw new Error("missing record");
  const original = recordBytes(adr);
  const contents = "---\n# Keep this comment\nsummary: Edited.\n---\n\n# ADR-0: Files\n\nNew text.\n";
  expect(saveRecord(root, adr.id, contentDigest(original), contents)).toBe(contentDigest(contents));
  expect(readFileSync(join(root, adr.path), "utf8")).toBe(contents);
  expect(() => {
    saveRecord(root, adr.id, contentDigest(original), "stale");
  }).toThrow(/changed since/);
  mkdirSync(join(root, "workbench/tasks"));
  writeFileSync(join(root, "workbench/tasks/TSK-00.md"), "---\nstatus: Planned\n---\n\n# Task\n");
  expect(() => {
    saveRecord(root, "demo:TSK-0", "", "");
  }).toThrow(/only project-owned/);
  mkdirSync(join(root, "workbench/decisions/ADR-00"));
  writeFileSync(join(root, "workbench/decisions/ADR-00/note.txt"), "Evidence\n");
  expect(supportingFiles(adr)).toEqual([{ path: "workbench/decisions/ADR-00/note.txt", size: 9 }]);
  expect(() => {
    saveRecord(root, "unknown:ADR-0", "", "");
  }).toThrow(/not found/);
});

test("the disposable catalog refreshes changed and removed record metadata", () => {
  const catalog = new RecordCatalog(root);
  expect(catalog.records().find((record) => record.type === "ADR")?.title).toBe("ADR-0: Files");
  expect(catalog.records().find((record) => record.type === "ADR")?.title).toBe("ADR-0: Files");
  writeFileSync(join(root, "workbench/decisions/ADR-00.md"), "# Changed title\n");
  expect(catalog.records().find((record) => record.type === "ADR")?.title).toBe("Changed title");
  rmSync(join(root, "workbench/decisions/ADR-00.md"));
  expect(catalog.records().filter((record) => record.type === "ADR")).toEqual([]);
});

test("reading staged reviews does not acquire or rewrite the user's index", () => {
  stage("workbench/decisions/ADR-00.md", "# Proposed change\n");
  const index = join(root, ".git/index"),
    before = readFileSync(index);
  writeFileSync(join(root, ".git/index.lock"), "Owned by another Git operation");
  expect(reviewStatus(root, ReviewSource.Staged).changes).toHaveLength(1);
  expect(readFileSync(index)).toEqual(before);
  expect(readFileSync(join(root, ".git/index.lock"), "utf8")).toBe("Owned by another Git operation");
});

test("malformed per-file receipt fields fail closed without losing the staged review", () => {
  stage("workbench/decisions/ADR-00.md", "# Revised decision\n");
  const pending = reviewStatus(root, ReviewSource.Staged),
    change = pending.changes[0];
  if (!change) throw new Error("missing staged change");
  const receipt = {
    digest: pending.digest,
    changes: pending.changes.map(({ path, before, after, charter }) => ({ path, before, after, charter })),
    files: { [change.path]: { approved_at: "2026-10-25T00:00:00Z", human_written_charter: "yes" } },
  };
  mkdirSync(join(root, ".git/workbench"), { recursive: true });
  writeFileSync(pending.receipt, JSON.stringify(receipt));
  expect(reviewStatus(root, ReviewSource.Staged).changes[0]?.approved).toBe(false);
  writeFileSync(pending.receipt, JSON.stringify({ ...receipt, changes: [null] }));
  expect(reviewStatus(root, ReviewSource.Staged).changes[0]?.approved).toBe(false);
});

test("staged inspection excludes intent-to-add files without rewriting the index", () => {
  writeFileSync(join(root, "workbench/decisions/ADR-01.md"), "# Unstaged intent\n");
  git(root, "add", "--intent-to-add", "workbench/decisions/ADR-01.md");
  const before = readFileSync(join(root, ".git/index"));
  expect(stagedRecordTree(root).entries.has("workbench/decisions/ADR-01.md")).toBe(false);
  expect(reviewStatus(root, ReviewSource.Staged).changes).toEqual([]);
  expect(readFileSync(join(root, ".git/index"))).toEqual(before);
});

test("a charter without a heading follows its display name when the registry changes", () => {
  writeFileSync(join(root, "workbench/CHARTER.md"), "Human intent without an invented title.\n");
  const registry = join(root, "workbench/projects.toml");
  const rename = (name: string) => {
    writeFileSync(registry, `[[project]]\nid="demo"\nname="${name}"\npath="."\n`);
  };
  rename("First Name");
  const catalog = new RecordCatalog(root);
  expect(catalog.records().find((record) => record.type === "CHARTER")?.title).toBe("First Name charter");
  rename("New Name");
  expect(catalog.records().find((record) => record.type === "CHARTER")?.title).toBe("New Name charter");
  expect(readFileSync(join(root, "workbench/CHARTER.md"), "utf8")).toBe("Human intent without an invented title.\n");
});
