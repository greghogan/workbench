import { required } from "./invariants.js";
import { colorDisabled, plainOutput } from "./presentation.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { terminalAvailable } from "./terminal-choice.js";
import { writeAtomic } from "./core.js";
import { proposedRecordTrees } from "./staged-records.js";

interface Change {
  path: string;
  before: string;
  after: string;
  charter: boolean;
}
const changesDigest = (changes: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(changes)).digest("hex");
function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(`cannot inspect proposed review: ${String(result.stderr || result.error)}`);
  return result.stdout;
}
function proposed(root: string) {
  const changes: Change[] = [];
  const trees = proposedRecordTrees(root);
  const raw = git(root, ["diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z"]).split("\0");
  for (let index = 0; index < raw.length - 1; index += 2) {
    const header = required(raw[index], "expected raw[index]");
    const path = required(raw[index + 1], "expected raw[index + 1]");
    const fields = header.slice(1).split(" ");
    if (fields[4] === "U") throw new Error(`resolve the conflicted index entry: ${path}`);
    const locations = trees.map((tree) => tree.classify(path));
    const charter = locations.some((location) => location.charter);
    if (locations.some((location) => location.protected))
      changes.push({
        path,
        before: `${String(fields[0])}:${String(fields[2])}`,
        after: `${String(fields[1])}:${String(fields[3])}`,
        charter,
      });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  const digest = changesDigest(changes);
  const receipt = resolve(root, git(root, ["rev-parse", "--git-path", "workbench/review.json"]).trim());
  return { changes, digest, receipt };
}

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
  const { changes, digest, receipt } = proposed(root);
  if (!changes.length) throw new Error("no protected staged changes to approve");
  if (expected !== digest) throw new Error("review digest changed; inspect 'workbench review' again");
  if (changes.some((change) => change.charter) && !humanWrittenCharters)
    throw new Error("charter changes require confirmation of human authorship");
  writeAtomic(
    receipt,
    `${JSON.stringify({ digest, changes, approved_at: new Date().toISOString(), human_written_charters: humanWrittenCharters }, null, 2)}\n`,
  );
  console.log("Recorded acknowledgment for the exact protected staged changes.");
}

/** A prior approval still covers a smaller selection when every remaining change is identical. */
function alreadyApproved({ changes, digest, receipt }: ReturnType<typeof proposed>): boolean {
  if (!existsSync(receipt)) return false;
  const saved = JSON.parse(readFileSync(receipt, "utf8")) as {
    digest?: unknown;
    changes?: unknown;
    human_written_charters?: unknown;
  };
  if (changes.some((change) => change.charter) && saved.human_written_charters !== true) return false;
  if (!Array.isArray(saved.changes) || saved.digest !== changesDigest(saved.changes)) return false;
  if (saved.digest === digest) return true;
  const approved = new Set(saved.changes.map((change) => JSON.stringify(change)));
  return changes.every((change) => approved.has(JSON.stringify(change)));
}

export function checkReview(root: string): void {
  const pending = proposed(root);
  if (!pending.changes.length || alreadyApproved(pending)) return;
  throw new Error("protected staged changes need human review; run 'workbench review' in an interactive terminal");
}

/** Terminal approval is deliberately unavailable through flags or redirected input. */
export async function reviewInteractively(root: string): Promise<void> {
  const pending = proposed(root);
  if (!terminalAvailable() || !pending.changes.length) {
    reviewStatus(root);
    return;
  }
  if (alreadyApproved(pending)) {
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
