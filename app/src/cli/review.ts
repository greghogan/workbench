import { committedReview } from "../core/review/review-units.js";
import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { colorDisabled, plainOutput } from "../core/diagnostics/presentation.js";
import { GitSnapshot, reviewEntry, updatedReviewTree, writeReviewBlobs } from "../core/git/git-snapshot.js";
import { formatPendingReviews } from "../core/review/review-formatting.js";
import {
  approveCapturedReviews,
  captureReviews,
  reviewStatus as fileReviewStatus,
  reviewGit as git,
  reviewedBaselines,
  ReviewSource,
  type ReviewChange,
} from "../core/review/review-service.js";
import { terminalAvailable } from "./terminal/terminal-choice.js";

function presentation(root: string, source: ReviewSource, snapshot: GitSnapshot, changes: ReviewChange[]) {
  const captured = captureReviews(root, changes, source, snapshot);
  const previous = reviewedBaselines(root, snapshot.head);
  const prior = changes.flatMap((change) => {
    const review = previous.get(change.path);
    return review ? [{ change, contents: review.contents }] : [];
  });
  const baselineObjects = writeReviewBlobs(
    root,
    prior.map(({ contents }) => Buffer.from(contents)),
  );
  const baseline = updatedReviewTree(
    root,
    snapshot.head,
    prior.map(({ change }, index) => ({
      path: change.path,
      entry: {
        mode: reviewEntry(change.before).mode === "100755" ? "100755" : "100644",
        oid: baselineObjects[index] ?? "",
      },
    })),
  );
  return {
    captured,
    baseline,
    tree: updatedReviewTree(
      root,
      baseline,
      changes.map((change) => ({ path: change.path, entry: reviewEntry(change.after) })),
    ),
  };
}

export function reviewStatus(root: string, source: ReviewSource = ReviewSource.Working, commit?: string): void {
  const snapshot =
    commit !== undefined
      ? committedReview(root, commit).snapshot
      : new GitSnapshot(root, { staged: source === ReviewSource.Staged });
  const { changes, digest, receipt } = fileReviewStatus(root, source, snapshot);
  if (!changes.length) {
    console.log("No protected record changes.");
    return;
  }
  const { baseline, tree } = presentation(root, source, snapshot, changes);
  process.stdout.write(
    git(root, [
      "diff",
      baseline,
      tree,
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ...changes.map((change) => change.path),
    ]),
  );
  console.log(`Review digest: ${digest}\nReceipt: ${receipt}`);
  if (changes.some((change) => change.charter)) console.log("Charter content must be written by a human.");
}

/** Terminal approval is deliberately unavailable through flags or redirected input. */
export async function reviewInteractively(root: string, recordPath?: string, commit?: string): Promise<void> {
  if (commit === undefined) await formatPendingReviews(root, recordPath);
  const source = commit !== undefined ? ReviewSource.Staged : ReviewSource.Working;
  const snapshot = commit ? committedReview(root, commit).snapshot : new GitSnapshot(root, { staged: false });
  const pending = fileReviewStatus(root, source, snapshot);
  const record = recordPath ? relative(root, recordPath).replaceAll("\\", "/").replace(/\.md$/, "") : undefined;
  const changes = pending.changes.filter(
    (change) => !change.approved && (!record || change.path === record + ".md" || change.path.startsWith(record + "/")),
  );
  if (record && !changes.length) {
    console.log("This record and its supporting files have no pending review.");
    return;
  }
  if (!terminalAvailable() || !pending.changes.length) {
    reviewStatus(root, source, commit);
    return;
  }
  if (pending.changes.every((change) => change.approved)) {
    console.log("Protected record changes are already approved.");
    return;
  }
  const { captured, baseline, tree } = presentation(root, source, snapshot, changes);
  const diff = spawnSync(
    "git",
    [
      "-C",
      root,
      plainOutput() ? "--no-pager" : "--paginate",
      "diff",
      baseline,
      tree,
      colorDisabled() ? "--color=never" : "--color=auto",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ...changes.map((change) => change.path),
    ],
    { stdio: "inherit" },
  );
  if (diff.error || diff.status !== 0) throw new Error("cannot display captured review diff");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
    ...(plainOutput() ? { terminal: false } : {}),
  });
  const cancellation = new AbortController();
  const cancel = () => {
    cancellation.abort();
  };
  prompt.on("SIGINT", cancel);
  prompt.on("close", cancel);
  try {
    const yes = async (question: string) =>
      /^(y|yes)$/i.test((await prompt.question(`${question} [y/N] `, { signal: cancellation.signal })).trim());
    if (!(await yes("Approve these record changes?"))) {
      console.log("Approval not recorded.");
      return;
    }
    const charters = changes.some((change) => change.charter);
    if (charters && !(await yes("Was all changed charter text written by a human?"))) {
      console.log("Approval not recorded: charter authorship was not confirmed.");
      return;
    }
    approveCapturedReviews(root, captured, charters);
    console.log("Recorded acknowledgment for the presented record changes.");
  } finally {
    prompt.close();
  }
}
