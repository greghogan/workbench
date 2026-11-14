import { checkPlanningPublication } from "../tasks/planning/planning-publication.js";
import { gitBytes } from "../git/git-snapshot.js";
import { checkProvisionalPush } from "../git/commit-history.js";
import { pushUpdates, zeroRevision } from "../git/push-updates.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../diagnostics/diagnostics.mjs";
import { checkArchivePublication } from "./archive-publication.js";

// This copied guard also runs in planning-only and archive-only checkouts.
try {
  const [root, remoteName, remote, input, output] = process.argv.slice(2);
  if (!root || !remoteName || !remote || !input || !output) throw new Error("Invalid push guard invocation");
  const updates = readBoundedFile(input, 4 * 1024 * 1024, "push updates").toString();
  const archives = new Set([
    ...checkArchivePublication(root, updates, remote),
    ...checkPlanningPublication(root, updates, remoteName, remote),
  ]);
  const project = updates
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((row) => !archives.has(row.split(/\s+/)[0] ?? ""));
  for (const update of pushUpdates(project.join("\n")))
    if (
      !zeroRevision(update.tip) &&
      gitBytes(root, ["cat-file", "-t", `${update.tip}^{}`])
        .toString()
        .trim() === "commit"
    )
      checkProvisionalPush(root, update.tip, update.previous);
  writeAtomic(output, project.length ? project.join("\n") + "\n" : "", 0o600);
} catch (error) {
  diagnostic(LogLevel.Error, DiagnosticOperation.Command, DiagnosticOutcome.Failed, { command: "push" }, error);
  process.exitCode = 1;
}
