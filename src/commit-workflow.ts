import { mkdtempSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitBytes } from "./git-snapshot.js";
import { launchProcess } from "./launcher.js";
import { InvalidInput } from "./input-errors.js";
import { readBoundedFile } from "./file-reads.js";
import { checkCommit, commitMessageLimit, readCommitMessage } from "./commit.js";
import { checkReview } from "./review.js";
import { checkAgentCommit } from "./agent-review.js";
import { settleCleanup } from "../scripts/diagnostic-errors.mjs";
import {
  provisionalCommitRequested,
  provisionalEnvironment,
  provisionalMessage,
  provisionalTrailer,
} from "./commit-history.js";

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
  const tree = gitBytes(root, ["write-tree"]).toString().trim();
  const environment = { ...process.env };
  Reflect.deleteProperty(environment, provisionalEnvironment);
  if (options.provisional) environment[provisionalEnvironment] = tree;
  const directory = mkdtempSync(join(tmpdir(), "workbench-commit-"));
  let failure: unknown;
  try {
    const path = join(directory, "message");
    writeFileSync(path, message.trimEnd() + (options.provisional ? `\n\n${provisionalTrailer}: true\n` : "\n"), {
      mode: 0o600,
    });
    checkCommit(root, path);
    await launchProcess("git", ["-C", root, "commit", ...(options.amend ? ["--amend"] : []), "--file", path], {
      env: environment,
      cwd: root,
    });
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
