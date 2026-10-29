import { GitSnapshot, updatedReviewTree, reviewEntry, writeReviewBlobs } from "./git-snapshot.js";
import { colorDisabled, plainOutput } from "./presentation.js";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { terminalAvailable } from "./terminal-choice.js";
import {
  proposedReview as proposed,
  reviewGit as git,
  reviewStatus as fileReviewStatus,
  ReviewSource,
  approveReviewFiles,
  captureReviews,
  approveCapturedReviews,
  reviewChangeDigest,
  reviewedBaselines,
  type ReviewChange,
} from "./review-service.js";

function presentation(root: string, source: ReviewSource, snapshot: GitSnapshot, changes: ReviewChange[]) {
  const captured = captureReviews(root, changes, source, snapshot);
  const previous =
    source === ReviewSource.Working ? reviewedBaselines(root, snapshot.head) : new Map<string, { contents: string }>();
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

export function reviewStatus(root: string, source: ReviewSource = ReviewSource.Working): void {
  const snapshot = new GitSnapshot(root, { staged: source === ReviewSource.Staged });
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

/** A cooperative acknowledgment, never a claim of authenticated human identity. */
export function approveReview(root: string, expected: string, humanWrittenCharters: boolean): void {
  const { changes, digest } = proposed(root);
  if (!changes.length) throw new Error("no protected staged changes to approve");
  if (expected !== digest) throw new Error("review digest changed; inspect 'workbench review' again");
  approveReviewFiles(
    root,
    changes.map((change) => ({ path: change.path, digest: reviewChangeDigest(change) })),
    humanWrittenCharters,
  );
  console.log("Recorded acknowledgment for the exact protected staged changes.");
}

export function checkReview(root: string, tree?: string): void {
  const pending = fileReviewStatus(
    root,
    ReviewSource.Staged,
    tree ? new GitSnapshot(root, { tree }) : undefined,
  ).changes.filter((change) => !change.approved);
  if (!pending.length) return;
  throw new Error(
    `protected staged changes need human review:\n${pending.map((change) => `  ${change.path}${change.charter ? " (confirm human authorship)" : ""}`).join("\n")}\nReview the current files in 'workbench serve' and stage those exact contents, or run 'workbench review' in an interactive terminal to review the proposed commit.`,
  );
}

/** Terminal approval is deliberately unavailable through flags or redirected input. */
export async function reviewInteractively(root: string): Promise<void> {
  const snapshot = new GitSnapshot(root, { staged: false });
  const pending = fileReviewStatus(root, ReviewSource.Working, snapshot);
  if (!terminalAvailable() || !pending.changes.length) {
    reviewStatus(root);
    return;
  }
  if (pending.changes.every((change) => change.approved)) {
    console.log("Protected record changes are already approved.");
    return;
  }
  const changes = pending.changes.filter((change) => !change.approved);
  const { captured, baseline, tree } = presentation(root, ReviewSource.Working, snapshot, changes);
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
