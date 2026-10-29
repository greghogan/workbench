import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync } from "node:fs";
import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { marker, readRun, logFiles } from "./log-run.js";
import { ownedPath } from "./paths.js";
import { withCacheLock } from "./cache-lock.js";
import { finishLogRun, logRetention } from "./log-storage.js";
import { diagnostic, LogLevel, LogRunState, DiagnosticOperation, DiagnosticOutcome } from "./diagnostics.js";

/** Inspection never recovers or deletes. Unknown owners remain explicit, including older receipts. */
export async function inspectLogRun(path: string) {
  const directory = resolve(path);
  if (!lstatSync(directory).isDirectory()) throw new Error("log run must be an ordinary directory");
  const receipt = readRun(directory);
  let ownership: "alive" | "gone" | "unknown" = "unknown";
  if (receipt.owner?.host === hostname()) {
    try {
      process.kill(receipt.owner.pid, 0);
      ownership = "alive";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") ownership = "gone";
    }
  }
  const files = logFiles(directory).sort();
  const hash = createHash("sha256");
  let bytes = 0;
  for (const name of files) {
    const file = ownedPath(directory, name),
      before = lstatSync(file);
    hash.update(JSON.stringify([name, before.size, before.mtimeMs, before.ino, before.dev]));
    // Active producers are observable without racing their complete output. Recovery always refuses them.
    if (ownership !== "alive") {
      for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
      const after = lstatSync(file);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino)
        throw new Error("log run changed during inspection; inspect again");
    }
    bytes += before.size;
  }
  return {
    version: 1 as const,
    kind: "workbench-log-inspection" as const,
    directory,
    state: receipt.state,
    started: receipt.started,
    completed: receipt.completed ?? null,
    owner: receipt.owner ?? null,
    ownership,
    locked: existsSync(`${directory}.lock`),
    files: files.length,
    bytes,
    digest: hash.digest("hex"),
  };
}
async function reviewedRun(
  path: string,
  expected: string,
  action: (directory: string) => Promise<void>,
): Promise<void> {
  const inspected = await inspectLogRun(path);
  if (inspected.locked) throw new Error("log run is locked; preserving active or uncertain work");
  if (inspected.ownership === "alive") throw new Error("log owner is still alive; refusing recovery or removal");
  if (inspected.digest !== expected) throw new Error("log inspection changed; inspect and review again");
  await withCacheLock(
    inspected.directory,
    async () => {
      // The receipt's lock file is outside the run and therefore does not change its review digest.
      const current = await inspectLogRun(path);
      if (current.ownership === "alive" || current.digest !== expected)
        throw new Error("log run changed before mutation; preserved");
      await action(inspected.directory);
    },
    0,
  );
}
export async function recoverLogRun(path: string, expected: string, confirmed: boolean): Promise<void> {
  if (!confirmed)
    throw new Error(
      "recovery requires --confirm-abandoned after inspection; uncertain evidence is otherwise preserved",
    );
  await reviewedRun(path, expected, async (directory) => {
    if (readRun(directory).state !== LogRunState.Active)
      throw new Error("only an interrupted active log receipt can be recovered");
    const result = await finishLogRun(
      directory,
      logRetention(),
      [new Error("Explicitly recovered interrupted diagnostic evidence; completeness is unknown")],
      false,
    );
    if (!result.completed)
      throw new AggregateError(result.errors, "Log recovery could not publish completion; source evidence preserved");
    diagnostic(
      LogLevel.Info,
      DiagnosticOperation.LogRecovery,
      DiagnosticOutcome.Recovered,
      { directory, issues: result.errors.length },
      undefined,
      "evidence retained; no age-off performed",
    );
  });
}
export async function removeLogRun(path: string, expected: string, confirmed: boolean): Promise<void> {
  if (!confirmed) throw new Error("removal requires --confirm-delete after inspecting the exact run");
  await reviewedRun(path, expected, async (directory) => {
    if (readRun(directory).state !== LogRunState.Completed)
      throw new Error("interrupted evidence must be inspected and recovered before removal");
    // Validate ownership immediately before the explicit whole-run deletion.
    ownedPath(directory, marker);
    await rm(directory, { recursive: true });
    diagnostic(LogLevel.Info, DiagnosticOperation.LogRecovery, DiagnosticOutcome.Pruned, { directory });
  });
}
