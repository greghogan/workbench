import { readBoundedFile } from "../runtime/file-reads.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../diagnostics/diagnostics.mjs";
import { checkArchivePublication } from "./archive-publication.js";

// This copied, self-contained guard also runs in archive-only checkouts.
try {
  const [root, remote, input, output] = process.argv.slice(2);
  if (!root || !remote || !input || !output) throw new Error("Invalid archive guard invocation");
  const updates = readBoundedFile(input, 4 * 1024 * 1024, "push updates").toString();
  const archives = new Set(checkArchivePublication(root, updates, remote));
  const project = updates
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((row) => !archives.has(row.split(/\s+/)[0] ?? ""));
  writeAtomic(output, project.length ? project.join("\n") + "\n" : "", 0o600);
} catch (error) {
  diagnostic(
    LogLevel.Error,
    DiagnosticOperation.Command,
    DiagnosticOutcome.Failed,
    { command: "archive publication" },
    error,
  );
  process.exitCode = 1;
}
