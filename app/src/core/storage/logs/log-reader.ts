import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { readLogFile } from "./log-storage.js";
import { logSegments, marker, readRun } from "./log-run.js";
import { withCacheLock } from "../cache-lock.js";
import { LogRunState, LogScope, diagnosticLogFile } from "../../diagnostics/diagnostics.mjs";
import { terminalLogFile, type TerminalChannel } from "./terminal-log.js";

/** Active check producers already hold the deletion lock; completed units acquire it for the whole read. */
async function readOwnedFile(path: string, output: Writable, keepOpen = false): Promise<void> {
  const directory = dirname(path);
  const owner = existsSync(join(directory, marker))
    ? directory
    : /^session-\d+$/.test(basename(directory)) && existsSync(join(dirname(directory), marker))
      ? dirname(directory)
      : undefined;
  const read = () => readLogFile(path, output, keepOpen);
  if (!owner) {
    await read();
    return;
  }
  let active = true;
  try {
    active = readRun(owner).state === LogRunState.Active;
  } catch {
    /* Unknown receipts already prevent automatic deletion; the evidence remains readable. */
  }
  if (active && existsSync(`${owner}.lock`)) {
    await read();
    return;
  }
  await withCacheLock(owner, read, undefined, undefined, { mutable: false });
}
export async function readLog(path: string, output: Writable, channel?: TerminalChannel): Promise<void> {
  const directory = lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  if (!directory) {
    if (channel) throw new Error("Select a server log session when using --stream");
    await readOwnedFile(path, output);
    return;
  }
  const receipt = readRun(path);
  if (channel && receipt.scope !== LogScope.Server) throw new Error("--stream requires a server log session");
  if (receipt.scope === LogScope.Cli) {
    await readOwnedFile(join(path, diagnosticLogFile), output);
    return;
  }
  if (receipt.scope !== LogScope.Server || !receipt.segmented)
    throw new Error("Select a log file or a diagnostic session");
  await withCacheLock(
    path,
    async () => {
      const name = channel ? terminalLogFile(channel) : diagnosticLogFile;
      const files = logSegments(path)
        .map((segment) => join(segment, name))
        .filter((file) => !channel || [file, `${file}.zst`, `${file}.gz`].some(existsSync));
      if (!files.length)
        throw new Error(
          channel ? `No retained ${channel} output is available` : "No retained server segments are available",
        );
      for (const [index, file] of files.entries()) await readOwnedFile(file, output, index !== files.length - 1);
    },
    undefined,
    undefined,
    { mutable: false },
  );
}
