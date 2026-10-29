import { colorDisabled, plainOutput } from "./presentation.js";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { terminalAvailable } from "./terminal-choice.js";
import {
  proposedReview as proposed,
  reviewGit as git,
  stagedReview,
  approveReviewFiles,
  reviewChangeDigest,
} from "./review-service.js";

export function reviewStatus(root: string): void {
  const { changes, digest, receipt } = proposed(root);
  if (!changes.length) {
    console.log("No protected staged changes.");
    return;
  }
  process.stdout.write(
    git(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", ...changes.map((change) => change.path)]),
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

export function checkReview(root: string): void {
  const pending = stagedReview(root).changes.filter((change) => !change.approved);
  if (!pending.length) return;
  throw new Error(
    `protected staged changes need human review:\n${pending.map((change) => `  ${change.path}${change.charter ? " (confirm human authorship)" : ""}`).join("\n")}\nRun 'workbench review' in an interactive terminal or use 'workbench serve' and select each applicable record source.`,
  );
}

/** Terminal approval is deliberately unavailable through flags or redirected input. */
export async function reviewInteractively(root: string): Promise<void> {
  const pending = stagedReview(root);
  if (!terminalAvailable() || !pending.changes.length) {
    reviewStatus(root);
    return;
  }
  if (pending.changes.every((change) => change.approved)) {
    console.log("Protected staged changes are already approved.");
    return;
  }
  const diff = spawnSync(
    "git",
    [
      "-C",
      root,
      plainOutput() ? "--no-pager" : "--paginate",
      "diff",
      "--cached",
      colorDisabled() ? "--color=never" : "--color=auto",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ...pending.changes.map((change) => change.path),
    ],
    { stdio: "inherit" },
  );
  if (diff.error || diff.status !== 0) throw new Error("cannot display staged review diff");
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
    if (!(await yes("Approve these staged record changes?"))) {
      console.log("Approval not recorded.");
      return;
    }
    const charters = pending.changes.some((change) => change.charter);
    if (charters && !(await yes("Was all changed charter text written by a human?"))) {
      console.log("Approval not recorded: charter authorship was not confirmed.");
      return;
    }
    if (proposed(root).digest !== pending.digest)
      throw new Error("review digest changed; inspect 'workbench review' again");
    approveReview(root, pending.digest, charters);
  } finally {
    prompt.close();
  }
}
