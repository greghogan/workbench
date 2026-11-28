import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  GitSnapshot,
  gitBytes,
  gitPaths,
  stagedReviewTree,
  writeRawReviewObjects,
  readGitObjects,
  readGitCommit,
  writeReviewBlobs,
  readGitTree,
} from "../../../src/core/git/git-snapshot.ts";
import { MissingResource } from "../../../src/core/runtime/input-errors.ts";
import { withRepositoryReads } from "../../../src/core/git/repository-reads.ts";
import { repositoryStatePath } from "../../../src/core/git/repository-state.ts";
import { taskRepositoryDirectory } from "../../../src/core/tasks/task-project-state.ts";
import {
  reviewStatus,
  ReviewSource,
  captureReviews,
  approveCapturedReviews,
  reviewedBaselines,
  workingReviewContents,
} from "../../../src/core/review/review-service.ts";
import { webServers } from "../../fixtures/web.mjs";
import { git } from "../../fixtures/adoption.mjs";
import { WorkspaceCollector } from "../../../src/server/workspace/workspace-service.ts";
const fixtures = webServers();

test.each(["split", "sparse"] as const)(
  "staged capture preserves a %s alternate index in a linked worktree",
  (layout) => {
    const root = fixtures.project();
    for (const directory of ["visible", "hidden/nested"]) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, "file.txt"), "Baseline\n");
    }
    git(root, "add", "visible", "hidden");
    git(root, "commit", "-qm", "Add both directories");
    const linked = join(root, "linked-checkout");
    git(root, "worktree", "add", "-qb", "linked-fixture", linked);
    if (layout === "split") git(linked, "update-index", "--split-index");
    else {
      git(linked, "sparse-checkout", "set", "--cone", "--sparse-index", "visible");
      expect(git(linked, "ls-files", "--sparse").split("\n")).toContain("hidden/");
    }
    writeFileSync(join(linked, "visible/file.txt"), "Staged in the linked checkout\n");
    git(linked, "add", "visible/file.txt");
    const expected = git(linked, "write-tree");
    const live = git(linked, "rev-parse", "--path-format=absolute", "--git-path", "index");
    const alternate = join(root, ".git", "alternate index");
    copyFileSync(live, alternate);
    const original = readFileSync(alternate);
    const lock = alternate + ".lock";
    writeFileSync(lock, "Another writer\n", { flag: "wx" });
    vi.stubEnv("GIT_INDEX_FILE", relative(linked, alternate).replaceAll("\\", "/"));
    expect(stagedReviewTree(linked)).toBe(expected);
    expect(readFileSync(live)).toEqual(original);
    expect(readFileSync(alternate)).toEqual(original);
    expect(readFileSync(lock, "utf8")).toBe("Another writer\n");
  },
);

test("staged capture identifies the conflicted path and preserves the active index", () => {
  const root = fixtures.project();
  const [blob] = writeReviewBlobs(root, [Buffer.from("Conflicting contents\n")]);
  if (!blob) throw new Error("Missing conflict fixture blob");
  const path = "conflicted path.txt";
  gitBytes(root, ["update-index", "-z", "--index-info"], `100644 ${blob} 2\t${path}\0` + `100644 ${blob} 3\t${path}\0`);
  const index = join(root, ".git", "index");
  const original = readFileSync(index);
  expect(() => stagedReviewTree(root)).toThrow(`resolve the conflicted index entry: ${path}`);
  expect(readFileSync(index)).toEqual(original);
});

test.skipIf(process.platform === "win32")("batched Git paths preserve a newline in the metadata directory", () => {
  const root = join(fixtures.project(), "metadata\nfixture");
  mkdirSync(root);
  git(root, "init", "-q");
  const names = ["rebase-merge", "MERGE_HEAD", "index"];
  expect(gitPaths(root, names)).toEqual(names.map((name) => join(root, ".git", name)));
});

test("commit reads follow a moving ref while an explicit object keeps its original contents", () => {
  const root = fixtures.project();
  withRepositoryReads(() => {
    const original = readGitCommit(root, "HEAD");
    expect(readGitCommit(root, original.oid)).toEqual(original);
    git(root, "tag", "-am", "Keep the original commit", "review-base");
    git(root, "commit", "--allow-empty", "-qm", "Advance the reviewed branch");
    const updated = readGitCommit(root, "HEAD");
    expect(updated.oid).toBe(git(root, "rev-parse", "HEAD"));
    expect(updated.bytes.toString()).toContain(`parent ${original.oid}\n`);
    expect(readGitCommit(root, "refs/tags/review-base")).toEqual(original);
    expect(readGitCommit(root, original.oid)).toEqual(original);
    expect(() => readGitCommit(root, "refs/heads/unavailable")).toThrow(MissingResource);
  });
});

test("repository locations honor Git redirection without changing task ownership", () => {
  const root = fixtures.project(),
    other = fixtures.project();
  try {
    withRepositoryReads(() => {
      const state = repositoryStatePath(root);
      const owner = join(taskRepositoryDirectory(root) ?? "", "workbench");
      expect(owner).toBe(state);
      const redirected = repositoryStatePath(other);
      vi.stubEnv("GIT_DIR", join(other, ".git"));
      expect(repositoryStatePath(root)).toBe(redirected);
      expect(join(taskRepositoryDirectory(root) ?? "", "workbench")).toBe(owner);
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

test("staging unchanged current contents does not change the workspace review revision", () => {
  const root = fixtures.project(),
    file = "workbench/decisions/ADR-00.md";
  writeFileSync(join(root, file), "# ADR-0: Current proposal\n\nReview these contents.\n");
  const collector = new WorkspaceCollector(root);
  const before = collector.collect();
  git(root, "add", file);
  const after = collector.collect();
  expect(after).not.toBe(before);
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
  expect(snapshot.changedPaths).toEqual([]);
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
  const original = readGitTree(root, snapshot.head),
    copy = readGitTree(root, snapshot.head);
  const entry = copy.get(file);
  if (!entry) throw new Error("Missing captured tree entry");
  entry.mode = "100755";
  copy.delete(file);
  expect(readGitTree(root, snapshot.head)).toEqual(original);
  expect(readGitTree(root, "HEAD")).toEqual(original);
  const oid = snapshot.staged.get(file)?.oid;
  if (!oid) throw new Error("Missing captured staged object");
  expect(snapshot.blob(oid).toString()).toBe("staged content\n");
  writeFileSync(join(root, file), "later content\n");
  git(root, "add", file);
  git(root, "commit", "-qm", "Later commit");
  expect(snapshot.blob(oid).toString()).toBe("staged content\n");
  expect(reviewStatus(root, ReviewSource.Staged, snapshot).digest).toBe(pending.digest);
  expect(new GitSnapshot(root).head).not.toBe(snapshot.head);
  expect(readGitTree(root, snapshot.head)).toEqual(original);
  expect(readGitTree(root, "HEAD").get(file)).not.toEqual(original.get(file));
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

test("batch blob reads preserve exact bytes, deduplicate immutable objects, and reject invalid requests", async () => {
  const { readGitObjects } = await import("../../../src/core/git/git-snapshot.ts");
  const root = fixtures.project(),
    bytes = Buffer.from([0, 255, 10, 13, 32]);
  writeFileSync(join(root, "binary"), bytes);
  writeFileSync(join(root, "same binary"), bytes);
  git(root, "add", ".");
  const tree = git(root, "write-tree");
  const first = `${tree}:binary`,
    second = `${tree}:same binary`,
    missing = `${tree}:missing`;
  const objects = readGitObjects(root, [first, second, missing, first]);
  expect(() => readGitObjects(root, [first, missing], undefined, { requirePresent: true })).toThrow(MissingResource);
  expect(objects.size).toBe(3);
  expect(objects.get(first)).toEqual(bytes);
  expect(objects.get(second)).toBe(objects.get(first));
  expect(objects.get(missing)).toBeUndefined();
  expect(() => readGitObjects(root, [tree])).toThrow(/blob/);
  expect(() => readGitObjects(root, [first], 4)).toThrow(/oversized/);
  expect(() => readGitObjects(root, [first + "\nHEAD"])).toThrow(/Invalid/);
});

test("a large logical record inventory reads all objects across bounded Git output batches", () => {
  const root = fixtures.project(),
    bodies = Array.from({ length: 35 }, (_, index) =>
      Buffer.from(String(index).padStart(2, "0") + "x".repeat(2 * 1024 * 1024 - 2)),
    );
  const ids = writeReviewBlobs(root, bodies),
    result = readGitObjects(root, [...ids, ids[0] ?? ""]);
  expect(result.size).toBe(bodies.length);
  for (const [index, id] of ids.entries()) expect(result.get(id)?.equals(bodies[index] ?? Buffer.alloc(0))).toBe(true);
});

test("small reads of an exact blob honor the byte limit before and after reuse", () => {
  const root = fixtures.project();
  const bytes = Buffer.alloc(512, 255);
  const [oid] = writeReviewBlobs(root, [bytes]);
  if (!oid) throw new Error("Missing fixture blob");
  withRepositoryReads(() => {
    expect(() => readGitObjects(root, [oid], 4)).toThrow(/oversized/);
    const first = readGitObjects(root, [oid], bytes.length).get(oid);
    expect(first).toEqual(bytes);
    first?.fill(0);
    expect(readGitObjects(root, [oid]).get(oid)).toEqual(bytes);
    expect(() => readGitObjects(root, [oid], 4)).toThrow(/oversized/);
  });
});

test("retained blob limits count unique bytes across aliases and reject larger captures before acquisition", () => {
  const root = fixtures.project(),
    one = Buffer.from("first snapshot"),
    two = Buffer.from("second snapshot"),
    objects = writeReviewBlobs(root, [one, two]);
  const first = objects[0],
    second = objects[1];
  if (!first || !second) throw new Error("Missing fixture blobs");
  git(root, "update-ref", "refs/workbench/read-alias", first);
  expect(
    readGitObjects(root, [first, "refs/workbench/read-alias"], one.length, { retainedBytes: one.length }).get(first),
  ).toEqual(one);
  expect(() =>
    readGitObjects(root, [first, second], Math.max(one.length, two.length), {
      retainedBytes: one.length + two.length - 1,
    }),
  ).toThrow(/retained read limit/);
});
