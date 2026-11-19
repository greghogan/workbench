import { mkdtempSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleCleanup } from "../core/diagnostics/diagnostic-errors.mjs";
import { launchProcess } from "../core/distribution/launcher-runtime.js";
import {
  pendingMergeParents,
  provisionalCommitRequested,
  provisionalEnvironment,
  provisionalMessage,
  provisionalTrailer,
} from "../core/git/commit-history.js";
import { checkCommit, commitMessageLimit, readCommitMessage } from "../core/git/commit.js";
import { stagedReviewTree } from "../core/git/git-snapshot.js";
import { checkAgentCommit } from "../core/review/agent-review.js";
import { checkReview } from "../core/review/review-check.js";
import { commitVersion } from "../core/review/review-units.js";
import { commitSigningEnabled } from "../core/git/commit-writing.js";
import { finalizationBranch } from "../core/git/finalization-refs.js";
import { gitRevision } from "../core/git/refs.js";
import { signCreatedCommit } from "../core/git/sign-history.js";
import { readBoundedFile } from "../core/runtime/file-reads.js";
import { InvalidInput } from "../core/runtime/input-errors.js";

function stdinMessage(): string {
  const buffer = Buffer.allocUnsafe(commitMessageLimit + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(0, buffer, length, buffer.length - length, null);
    if (!count) return buffer.subarray(0, length).toString("utf8");
    length += count;
  }
  throw new InvalidInput("Commit text must be at most 1 MiB");
}

export async function createCommit(
  root: string,
  options: { message: string[]; file?: string; provisional?: boolean; amend?: boolean },
): Promise<void> {
  if ((!options.message.length && options.file === undefined) || (options.message.length && options.file !== undefined))
    throw new InvalidInput("Supply commit text using --message (repeatable) or --file; --file - reads standard input");
  const message =
    options.file === undefined
      ? options.message.join("\n\n")
      : options.file === "-"
        ? stdinMessage()
        : readBoundedFile(options.file, commitMessageLimit, "commit message").toString("utf8");
  if (!message.trim() || Buffer.byteLength(message) > commitMessageLimit)
    throw new InvalidInput("Commit text must be nonempty and at most 1 MiB");
  if (provisionalMessage(root, message))
    throw new InvalidInput(
      `Workbench manages the reserved ${provisionalTrailer} trailer; omit it from the supplied text`,
    );
  const tree = stagedReviewTree(root);
  const attemptSigning = commitSigningEnabled(root);
  const branch = attemptSigning && process.stdin.isTTY && process.stderr.isTTY ? finalizationBranch(root) : undefined;
  const head = branch || options.amend ? gitRevision(root, "HEAD^{commit}") : undefined;
  const amended = options.amend && head ? commitVersion(root, head) : undefined;
  const parents = branch ? (amended?.parents ?? [...(head ? [head] : []), ...pendingMergeParents(root)]) : [];
  const environment = { ...process.env };
  if (amended) environment.GIT_COMMITTER_DATE ??= amended.committerDate;
  Reflect.deleteProperty(environment, provisionalEnvironment);
  if (options.provisional) environment[provisionalEnvironment] = tree;
  const directory = mkdtempSync(join(tmpdir(), "workbench-commit-"));
  let failure: unknown;
  try {
    const path = join(directory, "message");
    const contents = message.trimEnd() + (options.provisional ? `\n\n${provisionalTrailer}: true\n` : "\n");
    writeFileSync(path, contents, {
      mode: 0o600,
    });
    checkCommit(root, path);
    await launchProcess(
      "git",
      ["-C", root, "commit", "--no-gpg-sign", ...(options.amend ? ["--amend"] : []), "--file", path],
      {
        env: environment,
        cwd: root,
      },
    );
    if (attemptSigning && process.exitCode === 0) {
      let signed: string | undefined;
      try {
        if (branch) signed = signCreatedCommit(root, branch, tree, parents, contents);
      } catch {
        // Git has already published the local commit and run its hooks successfully.
      }
      console.log(
        signed
          ? `Signed commit ${signed.slice(0, 12)}.`
          : "Commit saved unsigned. Run 'workbench sign' when your signer is ready.",
      );
    }
  } catch (error) {
    failure = error;
  }
  await settleCleanup(
    [
      () => {
        rmSync(directory, { recursive: true, force: true });
      },
    ],
    failure,
  );
}

/** The message hook closes the gap between a provisional pre-commit and Git's final edited message. */
export function checkCommitReview(root: string, messagePath: string, tree: string, message?: string): void {
  const requested = provisionalCommitRequested(tree),
    marked = provisionalMessage(root, message ?? readCommitMessage(root, messagePath));
  if (requested !== marked)
    throw new InvalidInput(
      marked
        ? "Create provisional commits with 'workbench commit --provisional'"
        : `Provisional commit preparation requires the ${provisionalTrailer}: true trailer`,
    );
  if (!marked) checkReview(root, tree);
  checkAgentCommit(root, tree);
}
