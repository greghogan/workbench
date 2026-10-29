import type { GitSnapshot } from "../git-snapshot.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewGit } from "../review-service.js";

export interface SourceDifference {
  patch: string;
  before: string;
  after: string;
}
export function sourceDifference(
  before: string,
  after: string,
  path: string,
  patch = contentsDiff(before, after, path),
): SourceDifference {
  return { patch, before, after };
}

export function contentsDiff(before: string, after: string, path: string): string {
  const directory = mkdtempSync(join(tmpdir(), "workbench-web-diff-"));
  try {
    const old = join(directory, "before"),
      next = join(directory, "after");
    writeFileSync(old, before);
    writeFileSync(next, after);
    const result = spawnSync(
      "git",
      ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", old, next],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.error || (result.status !== 0 && result.status !== 1))
      throw new Error("cannot produce source differences");
    return result.stdout
      .replace(/^diff --git .*$/m, `diff --git a/${path} b/${path}`)
      .replace(/^--- .*$/m, `--- a/${path}`)
      .replace(/^\+\+\+ .*$/m, `+++ b/${path}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
export function workingDiff(root: string, path: string, contents: string, snapshot?: GitSnapshot): SourceDifference {
  if (snapshot) return sourceDifference(snapshot.committedBytes(path)?.toString("utf8") ?? "", contents, path);
  const result = spawnSync("git", ["-C", root, "--literal-pathspecs", "ls-tree", "HEAD", "--", path], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) return sourceDifference("", contents, path);
  const before = reviewGit(root, ["show", `HEAD:${path}`]);
  return sourceDifference(before, contents, path);
}
