import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { GitSnapshot, writeRawReviewObjects } from "../src/git-snapshot.ts";
import {
  reviewStatus,
  ReviewSource,
  captureReviews,
  approveCapturedReviews,
  reviewedBaselines,
  workingReviewContents,
} from "../src/review-service.ts";
import { webServers } from "./fixtures/web.mjs";
import { git } from "./fixtures/adoption.mjs";
import { WorkspaceCollector } from "../src/workspace-service.ts";
const fixtures = webServers();
test("staging unchanged current contents does not change the workspace review revision", () => {
  const root = fixtures.project(),
    file = "workbench/decisions/ADR-00.md";
  writeFileSync(join(root, file), "# ADR-0: Current proposal\n\nReview these contents.\n");
  const collector = new WorkspaceCollector(root);
  const before = collector.collect();
  git(root, "add", file);
  const after = collector.collect();
  expect(after.revision).toBe(before.revision);
  expect(after.review.changes).toEqual(before.review.changes);
  expect(after.reviewDocuments).toEqual(before.reviewDocuments);
});
test("a current-file snapshot ignores staged contents and staged permission changes", () => {
  const root = fixtures.project(),
    file = "workbench/decisions/ADR-00.md";
  git(root, "config", "core.filemode", "false");
  writeFileSync(join(root, file), "Staged candidate.\n");
  git(root, "add", file);
  git(root, "update-index", "--chmod=+x", file);
  writeFileSync(join(root, file), "Current record.\n");
  const snapshot = new GitSnapshot(root, { staged: false });
  expect(snapshot.changes).toEqual([]);
  const change = reviewStatus(root, ReviewSource.Working, snapshot).changes.find((change) => change.path === file);
  expect(change?.after).toMatch(/^100644:/);
  if (!change) throw new Error("Missing current-file review");
  expect(workingReviewContents(root, change)?.toString()).toBe("Current record.\n");
  expect(reviewStatus(root, ReviewSource.Staged).changes.find((change) => change.path === file)?.after).toMatch(
    /^100755:/,
  );
});
test("a Git read session retains its captured HEAD and staged blobs across later commits", () => {
  const root = fixtures.project(),
    file = "workbench/decisions/ADR-00.md";
  writeFileSync(join(root, file), "staged content\n");
  git(root, "add", file);
  const snapshot = new GitSnapshot(root),
    pending = reviewStatus(root, ReviewSource.Staged, snapshot);
  const oid = snapshot.staged.get(file)?.oid;
  if (!oid) throw new Error("Missing captured staged object");
  expect(snapshot.blob(oid).toString()).toBe("staged content\n");
  writeFileSync(join(root, file), "later content\n");
  git(root, "add", file);
  git(root, "commit", "-qm", "Later commit");
  expect(snapshot.blob(oid).toString()).toBe("staged content\n");
  expect(reviewStatus(root, ReviewSource.Staged, snapshot).digest).toBe(pending.digest);
  expect(new GitSnapshot(root).head).not.toBe(snapshot.head);
});

test("batch raw object writes preserve Unicode, spaces and exact bytes without applying Git filters", () => {
  const root = fixtures.project(),
    paths = ["space λ.md", "apostrophe' name.md", ...(process.platform === "win32" ? [] : ['quote" name.md'])];
  writeFileSync(join(root, ".gitattributes"), "*.md text eol=lf\n");
  for (const path of paths) writeFileSync(join(root, path), "exact\r\nbytes\n");
  const index = git(root, "write-tree");
  const ids = writeRawReviewObjects(
    root,
    paths.map((path) => join(root, path)),
  );
  expect(ids).toHaveLength(paths.length);
  const bytes = Buffer.from("exact\r\nbytes\n");
  const expected = createHash(ids[0]?.length === 64 ? "sha256" : "sha1")
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
  expect(ids).toEqual(paths.map(() => expected));
  expect(git(root, "write-tree")).toBe(index);
});
test("terminal review capture retains original HEAD and bytes across a concurrent commit", () => {
  const root = fixtures.project(),
    path = "workbench/decisions/ADR-00.md",
    contents = "# ADR-0: Presented\n\nPresented contents.\n";
  writeFileSync(join(root, path), contents);
  const snapshot = new GitSnapshot(root),
    pending = reviewStatus(root, ReviewSource.Working, snapshot),
    captured = captureReviews(root, pending.changes, ReviewSource.Working, snapshot);
  writeFileSync(join(root, "unrelated.txt"), "other");
  git(root, "add", "unrelated.txt");
  git(root, "commit", "-m", "other");
  approveCapturedReviews(root, captured, false);
  expect(reviewedBaselines(root).get(path)).toBeUndefined();
  expect(reviewedBaselines(root, captured.head).get(path)?.contents).toBe(contents);
});
