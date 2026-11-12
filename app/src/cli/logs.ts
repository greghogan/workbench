import { Command, Option } from "commander";
import { resolve } from "node:path";
import { inspectLogRun, recoverLogRun, removeLogRun } from "../core/storage/logs/log-recovery.js";
import { readLog } from "../core/storage/logs/log-reader.js";
import { registerCommand } from "./commands.js";
import { terminalChannels, type TerminalChannel } from "../core/storage/logs/terminal-log.js";

export function registerLogCommands(program: Command): void {
  const logsCommand = registerCommand(program, "logs").description(
    "Read retained log files or diagnostic sessions (plain, Zstd, or gzip)",
  );
  logsCommand
    .command("read")
    .description("Print the complete retained log, decompressing it when necessary")
    .argument("<path>")
    .addOption(new Option("--stream <channel>", "Read terminal output from a server session").choices(terminalChannels))
    .action(async (path: string, options: { stream?: TerminalChannel }) => {
      await readLog(resolve(path), process.stdout, options.stream);
    });
  logsCommand
    .command("inspect")
    .argument("<path>")
    .description("Inspect retained log ownership and obtain the exact review digest")
    .action(async (path: string) => {
      console.log(JSON.stringify(await inspectLogRun(path), null, 2));
    });
  logsCommand
    .command("recover")
    .argument("<path>")
    .requiredOption("--digest <sha256>", "Digest from logs inspect")
    .option("--confirm-abandoned", "Confirm the producer has stopped and incomplete evidence may be finalized")
    .description("Finalize explicitly reviewed interrupted logs without age-off or deletion")
    .action(async (path: string, options: { digest: string; confirmAbandoned?: boolean }) => {
      await recoverLogRun(path, options.digest, options.confirmAbandoned === true);
    });
  logsCommand
    .command("remove")
    .argument("<path>")
    .requiredOption("--digest <sha256>", "Digest from logs inspect")
    .option("--confirm-delete", "Authorize permanent deletion of this exact completed run")
    .description("Remove one explicitly reviewed completed log run")
    .action(async (path: string, options: { digest: string; confirmDelete?: boolean }) => {
      await removeLogRun(path, options.digest, options.confirmDelete === true);
    });
}
