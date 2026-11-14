import { historyCommits } from "../../../src/core/git/history.ts";
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { git } from "../../fixtures/adoption.mjs";
import { gitBytes, readGitTree, updatedReviewTree, writeReviewBlobs } from "../../../src/core/git/git-snapshot.ts";
import { publishGitTree, sameGitEntry } from "../../../src/core/git/tree-publication.ts";
import { withGitIndex } from "../../../src/core/git/index-transaction.ts";
import { recoveryReferences, removeRecoveryReference } from "../../../src/core/git/recovery-refs.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-tree-publication-"));
  roots.push(root);
  git(root, "init", "-qb", "main");
  writeFileSync(join(root, ".gitattributes"), "encoded.txt working-tree-encoding=UTF-16LE\nlines.txt text eol=crlf\n");
  writeFileSync(join(root, "encoded.txt"), Buffer.from("Before.\n", "utf16le"));
  writeFileSync(join(root, "lines.txt"), "Before.\r\n");
  writeFileSync(join(root, "unrelated.txt"), "Original.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Baseline");
  return root;
}
function transition(root: string) {
  const before = git(root, "rev-parse", "HEAD"),
    entries = readGitTree(root, before),
    blob = writeReviewBlobs(root, [Buffer.from("After.\n")])[0];
  if (!blob) throw new Error("Missing fixture blob");
  const tree = updatedReviewTree(
      root,
      before,
      ["encoded.txt", "lines.txt"].map((path) => ({ path, entry: { mode: "100644", oid: blob } })),
    ),
    after = git(root, "commit-tree", tree, "-p", before, "-m", "Prepared transition"),
    current = readGitTree(root, after);
  return {
    before,
    after,
    updates: [...new Set([...entries.keys(), ...current.keys()])]
      .filter((path) => !sameGitEntry(entries.get(path), current.get(path)))
      .map((path) => ({ path, before: entries.get(path), after: current.get(path) })),
  };
}
test("Git tree publication preserves checkout encodings, line endings and unrelated staged changes", () => {
  const root = fixture(),
    prepared = transition(root);
  writeFileSync(join(root, "unrelated.txt"), "Keep staged edits.\n");
  git(root, "add", "unrelated.txt");
  const unrelated = git(root, "rev-parse", ":unrelated.txt");
  publishGitTree(root, "main", prepared.before, prepared.after, prepared.updates);
  expect(readFileSync(join(root, "encoded.txt"))).toEqual(Buffer.from("After.\n", "utf16le"));
  expect(readFileSync(join(root, "lines.txt"), "utf8")).toBe("After.\r\n");
  expect(git(root, "diff", "--name-only")).toBe("");
  expect(git(root, "diff", "--cached", "--name-only")).toBe("unrelated.txt");
  expect(git(root, "rev-parse", ":unrelated.txt")).toBe(unrelated);
});
test("index publication excludes competing Git writers and leaves the real index intact after failure", () => {
  const root = fixture(),
    index = git(root, "write-tree");
  writeFileSync(join(root, "unrelated.txt"), "Working edit.\n");
  expect(() =>
    withGitIndex(root, (prepared) => {
      const competing = spawnSync("git", ["-C", root, "add", "unrelated.txt"], { encoding: "utf8" });
      expect(competing.status).not.toBe(0);
      expect(competing.stderr).toContain("index.lock");
      gitBytes(root, ["add", "unrelated.txt"], undefined, { GIT_INDEX_FILE: prepared });
      throw new Error("Interrupted before index publication");
    }),
  ).toThrow("Interrupted before index publication");
  expect(git(root, "write-tree")).toBe(index);
  expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  const prepared = transition(root);
  writeFileSync(join(root, ".git/index.lock"), "Other Git writer\n");
  expect(() => {
    publishGitTree(root, "main", prepared.before, prepared.after, prepared.updates);
  }).toThrow(/index is busy/);
  expect(readFileSync(join(root, "encoded.txt"))).toEqual(Buffer.from("Before.\n", "utf16le"));
  expect(git(root, "rev-parse", "HEAD")).toBe(prepared.before);
  expect(readFileSync(join(root, ".git/index.lock"), "utf8")).toBe("Other Git writer\n");
});
test("recovery cleanup requires the inspected reference and protects unfinished operations", () => {
  const root = fixture(),
    head = git(root, "rev-parse", "HEAD"),
    reference = "refs/workbench/recovery/example/before";
  git(root, "update-ref", reference, head);
  expect(recoveryReferences(root)).toEqual([{ reference, object: head, type: "commit" }]);
  expect(() => {
    removeRecoveryReference(root, reference, "0".repeat(head.length));
  }).toThrow(/changed/);
  mkdirSync(join(root, ".git/workbench"), { recursive: true });
  writeFileSync(join(root, ".git/workbench/archive-operation.json"), JSON.stringify({ version: 1, completed: false }));
  expect(() => {
    removeRecoveryReference(root, reference, head);
  }).toThrow(/pending repository recovery/);
  rmSync(join(root, ".git/workbench/archive-operation.json"));
  removeRecoveryReference(root, reference, head);
  expect(recoveryReferences(root)).toEqual([]);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
});

test("history cursors accept only the selected first-parent chain, including merge boundaries", () => {
  const root = fixture(),
    base = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-qb", "feature");
  git(root, "commit", "--allow-empty", "-qm", "Feature");
  const side = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  git(root, "commit", "--allow-empty", "-qm", "Main work");
  const main = git(root, "rev-parse", "HEAD");
  git(root, "merge", "--no-ff", "feature", "-qm", "Integrate feature");
  const tip = git(root, "rev-parse", "HEAD");
  expect(historyCommits(root, tip, main).commits.map((unit) => unit.revision)).toEqual([main, base]);
  expect(historyCommits(root, tip, tip).commits[0]?.revision).toBe(tip);
  expect(() => historyCommits(root, tip, side)).toThrow(/cursor does not belong/);
});
