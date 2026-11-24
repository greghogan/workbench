import { gitBytes, GitSnapshot, stagedReviewTree } from "../git/git-snapshot.js";
import { gitRevision } from "../git/refs.js";
import {
  pendingMergeParents,
  provisionalCommits,
  retainedProvisionalCommits,
  provisionalMessage,
} from "../git/commit-history.js";
import { InvalidInput, MissingResource } from "../runtime/input-errors.js";
import { recordOwnerPath } from "../records/staged-records.js";
import {
  captureReviews,
  proposedMergeReview,
  proposedReview,
  reviewedChanges,
  reviewChangeStatus,
  ReviewSource,
} from "./review-service.js";
import { WeightedCache } from "../storage/weighted-cache.js";
import { retainedBytes } from "../runtime/retained-bytes.js";
import { resolve } from "node:path";

export interface CommitVersion {
  revision: string;
  tree: string;
  parents: string[];
  author: string;
  committerDate: string;
  message: string;
  provisional: boolean;
  signed: boolean;
  embeddedMergeTag: boolean;
}
export function commitVersion(root: string, revision: string): CommitVersion {
  const selected = gitRevision(root, `${revision}^{commit}`);
  if (!selected) throw new MissingResource(`Commit unavailable locally: ${revision}`);
  const bytes = gitBytes(root, ["cat-file", "commit", selected]),
    contents = bytes.toString("utf8");
  if (!Buffer.from(contents).equals(bytes))
    throw new InvalidInput("Commit metadata is not UTF-8; preserve its original history before rewriting");
  const boundary = contents.indexOf("\n\n"),
    headers = contents.slice(0, boundary).split("\n"),
    tree = headers.find((line) => line.startsWith("tree "))?.slice(5),
    author = headers.find((line) => line.startsWith("author "))?.slice(7),
    committer = headers.find((line) => line.startsWith("committer ")),
    committerDate = / (\d+ [+-]\d{4})$/.exec(committer ?? "")?.[1],
    parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  if (
    boundary < 0 ||
    !tree ||
    !author ||
    !committerDate ||
    ![tree, ...parents].every((oid) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid))
  )
    throw new InvalidInput("Invalid retained commit metadata");
  const message = contents.slice(boundary + 2);
  return {
    revision: selected,
    tree,
    parents,
    author,
    committerDate,
    message,
    provisional: provisionalMessage(root, message),
    signed: headers.some((line) => /^(?:gpgsig|gpgsig-sha256) /.test(line)),
    embeddedMergeTag: headers.some((line) => line.startsWith("mergetag ")),
  };
}
const comparisons = new WeightedCache<ReturnType<typeof inspectReviewCommit>["comparison"]>(32 * 1024 * 1024);

function inspectReviewCommit(root: string, revision: string) {
  const unit = commitVersion(root, revision),
    snapshot = new GitSnapshot(root, { base: unit.parents[0] ?? "", tree: unit.tree }),
    { changes, digest } =
      unit.parents.length > 1
        ? proposedMergeReview(root, snapshot, unit.tree, unit.parents)
        : proposedReview(root, ReviewSource.Staged, snapshot);
  return { snapshot, comparison: { ...unit, changes, digest, head: snapshot.head, source: ReviewSource.Staged } };
}

/** Read immutable comparison identity independently of acknowledgment state. */
export function committedReviewComparison(root: string, revision: string) {
  const commit = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)
    ? revision
    : gitRevision(root, `${revision}^{commit}`);
  if (!commit) throw new MissingResource(`Commit unavailable locally: ${revision}`);
  const key = `${resolve(root)}:${commit}`;
  let comparison = comparisons.get(key);
  let snapshot: GitSnapshot | undefined;
  if (!comparison) {
    ({ comparison, snapshot } = inspectReviewCommit(root, commit));
    comparisons.set(key, comparison, retainedBytes(comparison, 32 * 1024 * 1024));
  }
  const captured = comparison;
  return {
    captured,
    snapshot: () => {
      snapshot ??= new GitSnapshot(root, { base: captured.parents[0] ?? "", tree: captured.tree });
      return snapshot;
    },
  };
}

export function committedReview(root: string, revision: string, statusFor?: ReturnType<typeof reviewChangeStatus>) {
  const { captured, snapshot } = committedReviewComparison(root, revision),
    status = statusFor ? statusFor(captured.changes) : reviewedChanges(root, captured.changes);
  return {
    ...captured,
    ...status,
    pending: status.changes.filter((change) => !change.approved).length,
    get snapshot(): GitSnapshot {
      return snapshot();
    },
  };
}
export function captureCommittedReview(root: string, revision: string) {
  const unit = committedReview(root, revision);
  return { unit, captured: captureReviews(root, unit.changes, ReviewSource.Staged, unit.snapshot) };
}

export function stagedMergeReview(root: string, tree?: string) {
  const others = pendingMergeParents(root);
  if (!others.length) return undefined;
  const result = tree ?? stagedReviewTree(root),
    snapshot = new GitSnapshot(root, { tree: result }),
    comparison = proposedMergeReview(root, snapshot, result, [snapshot.head, ...others]);
  return {
    ...comparison,
    ...reviewedChanges(root, comparison.changes, comparison.receipt),
    snapshot,
    source: ReviewSource.Staged,
  };
}

export function pendingCommitReviews(root: string, tip = "HEAD") {
  if (!gitRevision(root, `${tip}^{commit}`)) return [];
  return reviewUnits(root, provisionalCommits(root, tip));
}

export function reviewRecordGroups(paths: readonly string[]): { path: string; paths: string[] }[] {
  const collections = paths.flatMap((path) => /^workbench\/collections\/([^/]+)\//.exec(path)?.[1] ?? []);
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const owner = recordOwnerPath(path, [], collections) ?? path;
    const members = groups.get(owner) ?? [];
    members.push(path);
    groups.set(owner, members);
  }
  return [...groups].map(([path, paths]) => ({ path, paths }));
}

export function reviewRecordCount(paths: readonly string[]): number {
  return reviewRecordGroups(paths).length;
}

export function allCommitReviews(root: string) {
  const current = gitRevision(root, "HEAD") ? provisionalCommits(root) : [],
    selected = new Set(current);
  return reviewUnits(root, [
    ...current,
    ...retainedProvisionalCommits(root).filter((revision) => !selected.has(revision)),
  ]);
}

function reviewUnits(root: string, revisions: string[]) {
  if (!revisions.length) return [];
  const status = reviewChangeStatus(root);
  return revisions.map((revision) => committedReview(root, revision, status));
}
