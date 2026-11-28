import {
  prefetchGitCommits,
  readCommitDeltas,
  readGitCommit,
  GitSnapshot,
  stagedReviewTree,
  type GitDelta,
} from "../git/git-snapshot.js";
import { gitRevision } from "../git/refs.js";
import {
  pendingMergeParents,
  provisionalCommits,
  reviewableProvisionalHistory,
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
import { withRepositoryReads } from "../git/repository-reads.js";

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
  const { oid: selected, bytes } = readGitCommit(root, revision),
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

function inspectReviewCommit(root: string, unit: CommitVersion, deltas?: readonly GitDelta[]) {
  const snapshot = new GitSnapshot(root, { base: unit.parents[0] ?? "", tree: unit.tree, ...(deltas && { deltas }) }),
    { changes, digest } =
      unit.parents.length > 1
        ? proposedMergeReview(root, snapshot, unit.tree, unit.parents)
        : proposedReview(root, ReviewSource.Staged, snapshot);
  return {
    snapshot,
    comparison: {
      ...unit,
      changes,
      digest,
      changedPaths: snapshot.changedPaths,
      head: snapshot.head,
      source: ReviewSource.Staged,
    },
  };
}

const comparisonKey = (root: string, revision: string) => `${resolve(root)}:${revision}`;

function saveComparison(key: string, comparison: ReturnType<typeof inspectReviewCommit>["comparison"]): void {
  comparisons.set(key, comparison, retainedBytes(comparison, 32 * 1024 * 1024));
}

/** Read immutable comparison identity independently of acknowledgment state. */
export function committedReviewComparison(root: string, revision: string) {
  const commit = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)
    ? revision
    : gitRevision(root, `${revision}^{commit}`);
  if (!commit) throw new MissingResource(`Commit unavailable locally: ${revision}`);
  const key = comparisonKey(root, commit);
  let comparison = comparisons.get(key);
  let snapshot: GitSnapshot | undefined;
  if (!comparison) {
    ({ comparison, snapshot } = inspectReviewCommit(root, commitVersion(root, commit)));
    saveComparison(key, comparison);
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

export function allCommitReviews(root: string, head = gitRevision(root, "HEAD") ?? "") {
  const { revisions, onHead } = reviewableProvisionalHistory(root, head);
  return reviewUnits(root, revisions).map((unit) => Object.assign(unit, { onHead: onHead.has(unit.revision) }));
}

function reviewUnits(root: string, revisions: string[]) {
  if (!revisions.length) return [];
  return withRepositoryReads(() => {
    const status = reviewChangeStatus(root);
    const result: ReturnType<typeof committedReview>[] = [];
    for (let offset = 0; offset < revisions.length; offset += 32) {
      const batch = revisions.slice(offset, offset + 32);
      const uncached = batch.filter((revision) => !comparisons.get(comparisonKey(root, revision)));
      prefetchGitCommits(root, uncached);
      const units = uncached.map((revision) => commitVersion(root, revision));
      const deltas = readCommitDeltas(
        root,
        units.filter(({ parents }) => parents.length < 2),
      );
      for (const unit of units) {
        const { comparison } = inspectReviewCommit(root, unit, deltas.get(unit.revision));
        saveComparison(comparisonKey(root, unit.revision), comparison);
      }
      for (const revision of batch) result.push(committedReview(root, revision, status));
    }
    return result;
  });
}
