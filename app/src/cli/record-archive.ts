import { readConfig } from "../core/projects/project-configuration.js";
import { archiveRevision } from "../core/records/archive-store.js";
import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { terminalAvailable } from "./terminal/terminal-choice.js";
import { terminalTable } from "../core/diagnostics/terminal-table.js";
import {
  archiveOperation,
  enableArchive,
  fetchArchive,
  previewArchive,
  publishArchive,
  recoverArchive,
  transferArchive,
  type ArchiveOperation,
} from "../core/records/archive-workflow.js";
import { InvalidInput } from "../core/runtime/input-errors.js";

async function confirm(message: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  if (!terminalAvailable())
    throw new InvalidInput("Inspect archive status, then pass --yes to authorize the transfer commits");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(?:y|yes)$/i.test((await prompt.question(`${message}? [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

function report(operation: ArchiveOperation, json = false): void {
  if (json) {
    console.log(JSON.stringify(operation, null, 2));
    return;
  }
  const count = operation.files.filter((file) => /(?:TSK|EXP)-[0-9A-Z]+\.md$/.test(file.path)).length;
  console.log(`${operation.kind === "restore" ? "Restored" : "Archived"} ${String(count)} record(s).`);
  console.log(
    `Project commit: ${operation.after.slice(0, 12)}\nArchive commit: ${operation.archiveAfter.slice(0, 12)}`,
  );
}
export function registerArchiveCommands(records: Command, root: string): void {
  const archive = records.command("archive").description("Manage optional completed-record archives");
  const inspect = (options: { json?: boolean }) => {
    const enabled = !!readConfig(root).records?.archive_branch;
    const groups = enabled || archiveRevision(root) ? previewArchive(root) : [],
      operation = archiveOperation(root);
    if (options.json) console.log(JSON.stringify({ enabled, groups, operation }, null, 2));
    else {
      if (!enabled) console.log("Record archival is disabled.");
      if (operation && !operation.completed)
        console.log(`Transfer ${operation.id} requires recovery in ${operation.checkout}`);
      console.log(
        terminalTable(
          ["SCOPE", "TYPE", "RANGE", "RECORDS", "STATUS"],
          groups.map((group) => [
            group.scopePath,
            group.kind,
            `${group.first}–${group.last}`,
            String(group.paths.length),
            group.blockers.length ? group.blockers.join("; ") : group.complete ? "Eligible" : "Partial group",
          ]),
        ),
      );
    }
  };
  archive.option("--json", "Print groups and recovery state as JSON").action(inspect);
  archive
    .command("status")
    .description("Preview eligible groups and pending transfers")
    .option("--json", "Print structured status")
    .action(inspect);
  archive
    .command("enable")
    .description("Select archival and leave its configuration unstaged")
    .option("--branch <name>", "Archive branch (offered default: workbench/archive)")
    .option("--group-size <count>", "Positive integer record range size (default: 1296)")
    .option("--integration-branch <name>", "Branch allowed to initiate archival")
    .option("--remote <name>", "Integration and archive publication remote")
    .action((options: { branch?: string; groupSize?: string; integrationBranch?: string; remote?: string }) => {
      const { groupSize, ...selection } = options;
      enableArchive(root, { ...selection, ...(groupSize === undefined ? {} : { groupSize: Number(groupSize) }) });
      console.log("Archive configuration saved. Review and commit it before transferring records.");
    });
  archive
    .command("run")
    .description("Commit verified archive copies, then working-branch removals")
    .option("--include-partial", "Also include eligible incomplete final groups")
    .option("--yes", "Authorize the displayed transfer without an interactive prompt")
    .option("--json", "Print the completed transfer as JSON")
    .action(async (options: { includePartial?: boolean; yes?: boolean; json?: boolean }) => {
      if (!options.json) inspect({});
      if (await confirm("Archive the eligible groups in two local commits", options.yes))
        report(transferArchive(root, options), options.json);
    });
  archive
    .command("disable")
    .description("Restore archived records, then retire their archive copies")
    .option("--yes", "Authorize restoration commits without an interactive prompt")
    .option("--json", "Print the completed restoration as JSON")
    .action(async (options: { yes?: boolean; json?: boolean }) => {
      if (await confirm("Restore the archive and disable archival in two local commits", options.yes))
        report(transferArchive(root, { restore: true }), options.json);
    });
  archive
    .command("recover")
    .description("Resume the recorded transfer without duplicating commits")
    .option("--json", "Print the recovered transfer as JSON")
    .action((options: { json?: boolean }) => {
      report(recoverArchive(root), options.json);
    });
  archive
    .command("fetch")
    .description("Explicitly acquire the selected archive history")
    .option("--from <revision>", "Read archive selection from another branch or commit")
    .option("--remote <name>", "Acquire from this configured remote")
    .action((options: { from?: string; remote?: string }) => {
      fetchArchive(root, options);
      console.log("Archive history is available locally.");
    });
  archive
    .command("publish")
    .description("Publish integration and archive updates in a safe order")
    .action(() => {
      publishArchive(root);
      console.log("Archive and integration updates published.");
    });
}
