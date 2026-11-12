import { DiagnosticIssues } from "../../diagnostics/diagnostic-issues.js";
import { combineFailures, settleCleanup } from "../../diagnostics/diagnostic-errors.mjs";
import { DiagnosticRecordStream } from "../../diagnostics/diagnostic-records.mjs";
import { marker, readRun, publish, logFiles, type LogRun, type LogFile } from "./log-run.js";
import { transferLog, selectLogCompression, logExtension } from "./log-codec.js";
import { pruneLogRuns } from "./log-retention.js";
export { startLogRun, requireActiveLogRun } from "./log-run.js";
export { pruneLogRuns } from "./log-retention.js";
export type { LogRun } from "./log-run.js";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { safeOutput } from "../../diagnostics/terminal-output.js";
import {
  LogRunState,
  LogCompression,
  LogCompressionPreference,
  LogScope,
  LogLevel,
  DiagnosticOperation,
  DiagnosticOutcome,
  DiagnosticRedactor,
  diagnostic,
  type DiagnosticError,
} from "../../diagnostics/diagnostics.mjs";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, linkSync, rmSync, renameSync } from "node:fs";
import { dirname, basename } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ownedPath } from "../../runtime/paths.js";
import { releaseAfterFailure } from "../cache-lock.js";
import { userConfigValues } from "../../configuration/user-config.js";
import { localConfiguration } from "../../execution/environments/environments.js";

export interface LogRetention {
  maxAgeDays: number;
  maxBytes: number;
  compression: LogCompressionPreference;
}
export function logRetention(root?: string, explicitProject = false): LogRetention {
  const user = userConfigValues(),
    local = root ? localConfiguration(root, explicitProject ? root : undefined).logs : undefined;
  return {
    maxAgeDays: local?.check_max_age_days ?? (user["logs.check_max_age_days"] as number),
    maxBytes: local?.check_max_bytes ?? (user["logs.check_max_bytes"] as number),
    compression: local?.compression ?? (user["logs.compression"] as LogCompressionPreference),
  };
}
export function diagnosticRetention(
  scope: typeof LogScope.Cli | typeof LogScope.Server,
  user = userConfigValues(),
): LogRetention {
  return {
    maxAgeDays: user[`logs.${scope}_max_age_days`] as number,
    maxBytes: user[`logs.${scope}_max_bytes`] as number,
    compression: user["logs.compression"] as LogCompressionPreference,
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
export async function compressLogFile(
  path: string,
  preference: LogCompressionPreference = LogCompressionPreference.Auto,
): Promise<LogFile> {
  let compression: LogCompression;
  try {
    compression = selectLogCompression(preference);
  } catch (failure) {
    try {
      await sanitizeLogFile(path);
    } catch (cleanup) {
      throw combineFailures(failure, cleanup, "Log codec selection and source sanitization failed");
    }
    throw failure;
  }
  if (compression === LogCompression.None) {
    const result = await sanitizeLogFile(path);
    return {
      name: basename(path),
      bytes: result.bytes,
      originalBytes: result.bytes,
      sha256: result.sha256,
      compression,
    };
  }
  const temporary = `${path}.${randomUUID()}.partial`,
    archive = `${path}${logExtension(compression)}`;
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
  try {
    await transferLog(source, destination, compression, "compress", {
      beforeCodec: [path.endsWith(".jsonl") ? new DiagnosticRecordStream() : new DiagnosticRedactor(), tap],
    });
    const sha256 = hash.digest("hex"),
      verify = digestSink(bytes);
    await transferLog(createReadStream(temporary), verify.sink, compression, "decompress");
    const decoded = verify.result();
    if (decoded.bytes !== bytes || decoded.sha256 !== sha256)
      throw new Error("compressed log verification failed; preserving complete source");
    linkSync(temporary, archive);
    const result: LogFile = {
      name: basename(archive),
      bytes: lstatSync(archive).size,
      originalBytes: bytes,
      sha256,
      compression,
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
  const collected = new DiagnosticIssues();
  for (const issue of issues) collected.add(issue);
  for (const name of logFiles(directory)) {
    if (
      basename(name) === marker ||
      name.endsWith(".partial") ||
      name.endsWith(".zst") ||
      name.endsWith(".gz") ||
      name === "results.json"
    )
      continue;
    const file = ownedPath(directory, name);
    if (!lstatSync(file).isFile()) continue;
    try {
      const result = await compressLogFile(file, policy.compression);
      value.files.push({ ...result, name: `${name}${logExtension(result.compression)}` });
    } catch (error) {
      collected.add(error);
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
  value.errors = collected.snapshot();
  value.completed = new Date().toISOString();
  value.state = LogRunState.Completed;
  let completed = false;
  try {
    publish(path, value);
    completed = true;
  } catch (error) {
    collected.add(error);
  }
  if (completed && maintenance) {
    try {
      await pruneLogRuns(dirname(directory), policy, { newest: directory });
    } catch (error) {
      collected.add(error);
      try {
        value.errors = collected.snapshot();
        publish(path, value);
      } catch (publication) {
        collected.add(publication);
      }
    }
  }
  return { files: value.files, errors: collected.snapshot(), completed };
}
export async function readLogFile(path: string, output: Writable, keepOpen = false): Promise<void> {
  const resolveFile = () => {
    if (existsSync(path) || /\.(?:gz|zst)$/.test(path)) return path;
    const encoded = [".zst", ".gz"].map((suffix) => path + suffix).filter(existsSync);
    if (encoded.length > 1) throw new Error("Multiple retained encodings exist; select an explicit compressed file");
    return encoded[0] ?? path;
  };
  let file = resolveFile(),
    handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || /\.(?:gz|zst)$/.test(path)) throw error;
    file = resolveFile();
    handle = await open(file, "r");
  }
  const compression = file.endsWith(".zst")
    ? LogCompression.Zstd
    : file.endsWith(".gz")
      ? LogCompression.Gzip
      : LogCompression.None;
  const redactor = path.replace(/\.(?:zst|gz)$/, "").endsWith(".jsonl")
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
  const source = handle.createReadStream({ autoClose: false });
  let failure: unknown;
  try {
    await transferLog(source, output, compression, "decompress", {
      afterCodec: [redactor, ...(output === process.stdout && process.stdout.isTTY ? [terminal] : [])],
      deadlineMs: null,
      end: output === process.stdout ? false : !keepOpen,
    });
  } catch (error) {
    failure = error;
  }
  await settleCleanup(
    [
      () => {
        source.destroy();
        return handle.close();
      },
    ],
    failure,
  );
}
