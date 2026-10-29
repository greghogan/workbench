import { combineFailures } from "../scripts/diagnostic-errors.mjs";
import { DiagnosticRecordStream } from "../scripts/diagnostic-records.mjs";
import { marker, readRun, publish, logFiles, type LogRun, type LogFile } from "./log-run.js";
import { transferZstd } from "./log-codec.js";
import { pruneLogRuns } from "./log-retention.js";
export { startLogRun, requireActiveLogRun } from "./log-run.js";
export { pruneLogRuns } from "./log-retention.js";
export type { LogRun } from "./log-run.js";
import { StringDecoder } from "node:string_decoder";
import { safeOutput } from "./terminal-output.js";
import {
  LogRunState,
  LogCompression,
  LogLevel,
  DiagnosticOperation,
  DiagnosticOutcome,
  DiagnosticRedactor,
  diagnostic,
  diagnosticError,
  type DiagnosticError,
} from "./diagnostics.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, linkSync, rmSync, renameSync } from "node:fs";
import { dirname, basename } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ownedPath } from "./paths.js";
import { releaseAfterFailure } from "./cache-lock.js";
import { userConfigValues } from "./user-config.js";
import { localConfiguration } from "./environments.js";

export interface LogRetention {
  maxAgeDays: number;
  maxBytes: number;
  compress: boolean;
}
export function logRetention(root?: string): LogRetention {
  const user = userConfigValues(),
    local = root ? localConfiguration(root).logs : undefined;
  return {
    maxAgeDays: local?.max_age_days ?? (user["logs.max_age_days"] as number),
    maxBytes: local?.max_bytes ?? (user["logs.max_bytes"] as number),
    compress: local?.compress ?? (user["logs.compress"] as boolean),
  };
}
function digestSink(expectedLimit = Number.MAX_SAFE_INTEGER) {
  const hash = createHash("sha256");
  let bytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > expectedLimit) {
        callback(new Error("decoded log exceeds its recorded byte count"));
        return;
      }
      hash.update(chunk);
      callback();
    },
  });
  return { sink, result: () => ({ bytes, sha256: hash.digest("hex") }) };
}
async function sanitizeLogFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const temporary = `${path}.${randomUUID()}.partial`,
    hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(path),
      path.endsWith(".jsonl") ? new DiagnosticRecordStream() : new DiagnosticRedactor(),
      tap,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    renameSync(temporary, path);
    return { bytes, sha256: hash.digest("hex") };
  } catch (failure) {
    releaseAfterFailure(
      () => {
        rmSync(temporary, { force: true });
      },
      failure,
      "Log sanitization and temporary cleanup failed",
    );
  }
}
export async function compressLogFile(path: string): Promise<LogFile> {
  const temporary = `${path}.${randomUUID()}.partial`,
    archive = `${path}.zst`;
  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const source = createReadStream(path);
  const destination = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const stop = (error: unknown): never => {
    source.destroy();
    tap.destroy();
    destination.destroy();
    throw error;
  };
  try {
    const outcomes = await Promise.allSettled([
      pipeline(source, path.endsWith(".jsonl") ? new DiagnosticRecordStream() : new DiagnosticRedactor(), tap).catch(
        stop,
      ),
      transferZstd(tap, destination, "compress").catch(stop),
    ]);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const sha256 = hash.digest("hex"),
      verify = digestSink(bytes);
    await transferZstd(createReadStream(temporary), verify.sink, "decompress");
    const decoded = verify.result();
    if (decoded.bytes !== bytes || decoded.sha256 !== sha256)
      throw new Error("compressed log verification failed; preserving complete source");
    linkSync(temporary, archive);
    const result: LogFile = {
      name: basename(archive),
      bytes: lstatSync(archive).size,
      originalBytes: bytes,
      sha256,
      compression: LogCompression.Zstd,
    };
    rmSync(temporary, { force: true });
    rmSync(path);
    return result;
  } catch (failure) {
    let retainedFailure = failure;
    // A failed archive retains a complete sanitized source for recovery.
    if (existsSync(path)) {
      try {
        await sanitizeLogFile(path);
      } catch (cleanup) {
        retainedFailure = combineFailures(failure, cleanup, "Log compression and source sanitization failed");
      }
    }
    releaseAfterFailure(
      () => {
        rmSync(temporary, { force: true });
      },
      retainedFailure,
      "Log compression and temporary cleanup failed",
    );
  } finally {
    source.destroy();
    tap.destroy();
    destination.destroy();
  }
}

function addLogIssue(run: LogRun, error: unknown): void {
  if (run.errors.length < 31) {
    run.errors.push(diagnosticError(error));
    return;
  }
  const last = run.errors.at(-1);
  if (last?.name === "Omitted") last.omittedCauses = (last.omittedCauses ?? 0) + 1;
  else run.errors.push({ name: "Omitted", message: "Additional log finalization failures omitted", omittedCauses: 1 });
}
/** Complete runs are the retention unit. Active, unknown, and locked runs are never age-pruned. */
export async function finishLogRun(
  directory: string,
  policy: LogRetention,
  issues: unknown[] = [],
  maintenance = true,
): Promise<{ files: LogFile[]; errors: DiagnosticError[]; completed: boolean }> {
  const path = ownedPath(directory, marker);
  const value: LogRun = { ...readRun(directory), files: [], errors: [] };
  if (value.state !== LogRunState.Active) throw new Error("invalid active log run receipt");
  for (const issue of issues) addLogIssue(value, issue);
  for (const name of logFiles(directory)) {
    if (name === marker || name.endsWith(".partial") || name.endsWith(".zst") || name === "results.json") continue;
    const file = ownedPath(directory, name);
    if (!lstatSync(file).isFile()) continue;
    try {
      if (policy.compress) value.files.push({ ...(await compressLogFile(file)), name: `${name}.zst` });
      else {
        const result = await sanitizeLogFile(file);
        value.files.push({
          name,
          bytes: result.bytes,
          originalBytes: result.bytes,
          sha256: result.sha256,
          compression: LogCompression.None,
        });
      }
    } catch (error) {
      addLogIssue(value, error);
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.LogCompression,
        DiagnosticOutcome.Preserved,
        { file },
        error,
        "complete source preserved",
      );
    }
  }
  value.completed = new Date().toISOString();
  value.state = LogRunState.Completed;
  let completed = false;
  try {
    publish(path, value);
    completed = true;
  } catch (error) {
    addLogIssue(value, error);
  }
  if (completed && maintenance) {
    try {
      await pruneLogRuns(dirname(directory), policy, directory);
    } catch (error) {
      addLogIssue(value, error);
      try {
        publish(path, value);
      } catch (publication) {
        addLogIssue(value, publication);
      }
    }
  }
  return { files: value.files, errors: value.errors, completed };
}
export async function readLog(path: string, output: Writable): Promise<void> {
  const redactor = path.replace(/\.zst$/, "").endsWith(".jsonl")
    ? new DiagnosticRecordStream()
    : new DiagnosticRedactor();
  const decoder = new StringDecoder("utf8");
  const terminal = new Transform({
    transform(bytes: Buffer, _encoding, callback) {
      callback(null, safeOutput(decoder.write(bytes)));
    },
    flush(callback) {
      callback(null, safeOutput(decoder.end()));
    },
  });
  const target = output === process.stdout && process.stdout.isTTY ? terminal : output;
  if (target === terminal) terminal.pipe(output, { end: false });
  const source = createReadStream(
    existsSync(path) && !path.endsWith(".zst") ? path : path.endsWith(".zst") ? path : `${path}.zst`,
  );
  const stop = (error: unknown): never => {
    source.destroy();
    redactor.destroy();
    terminal.destroy();
    throw error;
  };
  const plain = existsSync(path) && !path.endsWith(".zst");
  const results = await Promise.allSettled([
    pipeline(redactor, target).catch(stop),
    (plain ? pipeline(source, redactor) : transferZstd(source, redactor, "decompress", { deadlineMs: null })).catch(
      stop,
    ),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
