import { archiveRepository, taskPath, support } from "../../fixtures/archive-workflow.mjs";
import { expect, test } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../fixtures/adoption.mjs";
import {
  archiveOperation,
  enableArchive,
  recoverArchive,
  transferArchive,
} from "../../../src/core/records/archive-workflow.ts";
import { archiveRevision, readArchiveIndex, readArchivedFile } from "../../../src/core/records/archive-store.ts";
import { verifyArchiveTransfer } from "../../../src/core/records/archive-transfer-proof.ts";
import { gitBytes } from "../../../src/core/git/git-snapshot.ts";
import { hashFile } from "../../../src/core/runtime/file-reads.ts";

test("archive and restore use two independent-history commits, preserve staged work, and retain old pinned revisions", () => {
  const root = archiveRepository(),
    original = readFileSync(join(root, taskPath));
  writeFileSync(join(root, "unrelated"), "keep staged\n");
  git(root, "add", "unrelated");
  const before = git(root, "rev-parse", "HEAD"),
    operation = transferArchive(root);
  expect(operation.completed).toBe(true);
  expect(git(root, "rev-parse", "HEAD^")).toBe(before);
  expect(git(root, "rev-list", "--count", "records")).toBe("1");
  expect(existsSync(join(root, taskPath))).toBe(false);
  expect(existsSync(join(root, "workbench/tasks/TSK-00"))).toBe(false);
  expect(readArchivedFile(root, taskPath)).toEqual(original);
  expect(readArchiveIndex(root, operation.archiveAfter).files.get(support)?.mode).toBe("100755");
  expect(git(root, "diff", "--cached", "--name-only")).toBe("unrelated");
  expect(readFileSync(join(root, "workbench/state.toml"), "utf8")).toContain('# Preserve counters\n[next]\nTSK="2"');
  expect(verifyArchiveTransfer(root, before, operation.after)).toEqual(new Set([support, taskPath]));
  git(root, "branch", "older-checkout");
  const restored = transferArchive(root, { restore: true });
  expect(restored.completed).toBe(true);
  expect(readFileSync(join(root, taskPath))).toEqual(original);
  expect(archiveRevision(root)).toBeUndefined();
  expect(readArchiveIndex(root, restored.archiveAfter).files.size).toBe(0);
  expect(git(root, "rev-list", "--count", "records")).toBe("2");
  expect(git(root, "diff", "--cached", "--name-only")).toBe("unrelated");
  git(root, "gc", "--prune=now");
  expect(readArchiveIndex(root, operation.archiveAfter).files.has(taskPath)).toBe(true);
  enableArchive(root, { branch: "records", groupSize: 1 });
  git(root, "add", "workbench/config.toml");
  git(root, "commit", "-qm", "Re-enable archival");
  transferArchive(root);
  expect(git(root, "rev-list", "--count", "records")).toBe("3");
});

test("a failure after the archive commit resumes exactly once and preserves intervening user edits", () => {
  const root = archiveRepository(),
    before = git(root, "rev-parse", "HEAD");
  expect(() =>
    transferArchive(root, {
      onProgress(stage) {
        if (stage === "archive-committed") throw new Error("Interrupted progress sink");
      },
    }),
  ).toThrow("Interrupted progress sink");
  const pending = archiveOperation(root);
  expect(pending?.completed).toBe(false);
  expect(git(root, "rev-parse", "HEAD")).toBe(before);
  const original = readFileSync(join(root, taskPath));
  writeFileSync(join(root, taskPath), "intervening user edit\n");
  expect(() => recoverArchive(root)).toThrow(/changed/);
  expect(readFileSync(join(root, taskPath), "utf8")).toBe("intervening user edit\n");
  writeFileSync(join(root, taskPath), original);
  const recovered = recoverArchive(root);
  expect(recovered.after).toBe(pending?.after);
  expect(recovered.archiveAfter).toBe(pending?.archiveAfter);
  expect(git(root, "rev-list", "--count", "records")).toBe("1");
  expect(recoverArchive(root)).toEqual(recovered);
});

test("affected edits and untracked supporting files block transfers; feature branches cannot initiate them", () => {
  const root = archiveRepository(),
    before = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "workbench/tasks/TSK-00/new-evidence"), "uncommitted evidence");
  expect(() => transferArchive(root)).toThrow(/edited or staged/);
  expect(git(root, "rev-parse", "HEAD")).toBe(before);
  rmSync(join(root, "workbench/tasks/TSK-00/new-evidence"));
  git(root, "checkout", "-qb", "feature");
  expect(() => transferArchive(root)).toThrow(/Only integration branch main/);
  git(root, "checkout", "main");
  transferArchive(root);
  const config = join(root, "workbench/config.toml");
  writeFileSync(config, readFileSync(config, "utf8").replace(/^archive_branch.*\n/m, ""));
  expect(() => {
    enableArchive(root, { branch: "missing" });
  }).toThrow(/contains the pinned/);
  enableArchive(root, { branch: "records" });
  git(root, "add", "workbench/config.toml");
  git(root, "commit", "-qm", "Restore archive configuration");
  expect(transferArchive(root, { restore: true }).completed).toBe(true);
});

test("recovery pins prepared commits through garbage collection and releases anchors only after completion", () => {
  const root = archiveRepository();
  expect(() =>
    transferArchive(root, {
      onProgress(stage) {
        if (stage === "recorded") throw new Error("Interruption before either ref advances");
      },
    }),
  ).toThrow("Interruption before either ref advances");
  const pending = archiveOperation(root);
  expect(
    git(root, "for-each-ref", "--format=%(objectname)", "refs/workbench/record-transfers").split("\n"),
  ).toHaveLength(2);
  git(root, "gc", "--prune=now");
  expect(recoverArchive(root).after).toBe(pending?.after);
  expect(git(root, "for-each-ref", "refs/workbench/record-transfers")).toBe("");
  expect(() =>
    transferArchive(root, {
      restore: true,
      onProgress(stage) {
        if (stage === "integration-committed") throw new Error("Interruption before archive cleanup");
      },
    }),
  ).toThrow("Interruption before archive cleanup");
  writeFileSync(join(root, taskPath), "user edits after restoration\n");
  expect(recoverArchive(root).completed).toBe(true);
  expect(readFileSync(join(root, taskPath), "utf8")).toBe("user edits after restoration\n");
});

test("large supporting assets transfer exactly without buffering or fixed restore size limits", () => {
  const root = archiveRepository(),
    path = join(root, support);
  truncateSync(path, 65 * 1024 * 1024);
  const expected = hashFile(path);
  git(root, "add", support);
  git(root, "commit", "-qm", "Retain large experiment evidence");
  transferArchive(root);
  expect(existsSync(path)).toBe(false);
  transferArchive(root, { restore: true });
  expect(hashFile(path)).toBe(expected);
});

test("Git checkout conversions do not become false user-edit conflicts during archival", () => {
  const root = archiveRepository();
  writeFileSync(join(root, ".gitattributes"), "*.md text eol=crlf\n");
  git(root, "add", ".gitattributes");
  git(root, "commit", "-qm", "Use checkout line endings");
  rmSync(join(root, taskPath));
  git(root, "checkout", "HEAD", "--", taskPath);
  expect(readFileSync(join(root, taskPath), "utf8")).toContain("\r\n");
  expect(git(root, "status", "--porcelain=v1", "--", taskPath)).toBe("");
  const original = gitBytes(root, ["show", `HEAD:${taskPath}`]);
  transferArchive(root);
  expect(readArchivedFile(root, taskPath)).toEqual(original);
  transferArchive(root, { restore: true });
  expect(readFileSync(join(root, taskPath), "utf8")).toBe(original.toString().replaceAll("\n", "\r\n"));
  expect(git(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
});
