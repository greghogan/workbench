import { restoreDiagnosticError, diagnosticError } from "../../diagnostics/diagnostic-errors.mjs";
import { opendir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, lstatSync, opendirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import {
  LogRunState,
  LogCompression,
  LogScope,
  hasEnumValue,
  type DiagnosticError,
} from "../../diagnostics/diagnostics.mjs";
import { ownedPath } from "../../runtime/paths.js";
import { releaseAfterFailure } from "../cache-lock.js";
import { ownedFileBytes } from "../../collections/collection-files.js";
export interface LogFile {
  name: string;
  bytes: number;
  originalBytes: number;
  sha256: string;
  compression: LogCompression;
}
export interface LogRun {
  version: 1;
  state: LogRunState;
  started: string;
  completed?: string;
  files: LogFile[];
  errors: DiagnosticError[];
  owner?: { pid: number; host: string };
  scope?: LogScope;
  segmented?: boolean;
}
const logReceiptLimit = 8 * 1024 * 1024;
export const marker = ".workbench-log-run.json";
function* entries(directory: string): Generator<string> {
  const reader = opendirSync(directory);
  try {
    for (;;) {
      const item = reader.readSync();
      if (!item) break;
      yield item.name;
    }
  } finally {
    reader.closeSync();
  }
}
export type LogReceipt = Omit<LogRun, "scope" | "segmented" | "state" | "completed"> &
  ({ scope: typeof LogScope.Server; segmented: true } | { scope: LogScope; segmented?: never }) &
  (
    { state: typeof LogRunState.Active; completed?: never } | { state: typeof LogRunState.Completed; completed: string }
  );
/** Decode the complete bounded receipt before trusting its ownership or completion state. */
export function readRun(directory: string): LogReceipt {
  const value: unknown = JSON.parse(ownedFileBytes(directory, marker, logReceiptLimit).toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("state" in value) ||
    !hasEnumValue(LogRunState, value.state) ||
    !("started" in value) ||
    typeof value.started !== "string" ||
    !Number.isFinite(Date.parse(value.started)) ||
    !("files" in value) ||
    !Array.isArray(value.files) ||
    !("errors" in value) ||
    !Array.isArray(value.errors) ||
    value.errors.length > 32
  )
    throw new Error("invalid log run ownership receipt; preserving it");
  const completed = "completed" in value ? value.completed : undefined;
  if (completed !== undefined && (typeof completed !== "string" || !Number.isFinite(Date.parse(completed))))
    throw new Error("invalid log completion timestamp; preserving evidence");
  if (value.state === LogRunState.Completed && completed === undefined)
    throw new Error("completed log receipt lacks a completion timestamp; preserving evidence");
  if (value.state === LogRunState.Active && (value.files.length || value.errors.length))
    throw new Error("unsupported partial log receipt; preserving evidence");
  const candidate = "owner" in value ? value.owner : undefined;
  const scope = "scope" in value ? value.scope : LogScope.Check;
  if (!hasEnumValue(LogScope, scope)) throw new Error("invalid log scope; preserving evidence");
  const segmented = "segmented" in value ? value.segmented : undefined;
  if (segmented !== undefined && (segmented !== true || scope !== LogScope.Server))
    throw new Error("invalid segmented log receipt");
  const owner =
    candidate &&
    typeof candidate === "object" &&
    "pid" in candidate &&
    Number.isSafeInteger(candidate.pid) &&
    Number(candidate.pid) > 0 &&
    "host" in candidate &&
    typeof candidate.host === "string"
      ? { pid: Number(candidate.pid), host: candidate.host }
      : undefined;
  const files = value.files.map((entry: unknown): LogFile => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("name" in entry) ||
      typeof entry.name !== "string" ||
      !entry.name ||
      entry.name.startsWith("/") ||
      entry.name.split("/").includes("..") ||
      entry.name.includes("\\") ||
      entry.name.includes("\0") ||
      !("bytes" in entry) ||
      !Number.isSafeInteger(entry.bytes) ||
      Number(entry.bytes) < 0 ||
      !("originalBytes" in entry) ||
      !Number.isSafeInteger(entry.originalBytes) ||
      Number(entry.originalBytes) < 0 ||
      !("sha256" in entry) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !("compression" in entry) ||
      !hasEnumValue(LogCompression, entry.compression)
    )
      throw new Error("invalid log file receipt; preserving evidence");
    return {
      name: entry.name,
      bytes: Number(entry.bytes),
      originalBytes: Number(entry.originalBytes),
      sha256: entry.sha256,
      compression: entry.compression,
    };
  });
  const errors = value.errors.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("message" in entry) ||
      typeof entry.message !== "string" ||
      !("name" in entry) ||
      typeof entry.name !== "string"
    )
      throw new Error("invalid log issue receipt; preserving evidence");
    return diagnosticError(restoreDiagnosticError(entry));
  });
  const common = { version: 1 as const, started: value.started, files, errors, ...(owner ? { owner } : {}) };
  const layout = segmented ? { scope: LogScope.Server, segmented: true as const } : { scope };
  return value.state === LogRunState.Active
    ? { ...common, ...layout, state: LogRunState.Active }
    : { ...common, ...layout, state: LogRunState.Completed, completed: String(completed) };
}
export function publish(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const body = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(body) > logReceiptLimit)
      throw new Error("Log receipt exceeds its byte limit; source evidence preserved");
    writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (failure) {
    releaseAfterFailure(
      () => {
        rmSync(temporary, { force: true });
      },
      failure,
      "Log receipt publication and cleanup failed",
    );
  }
}
export function startLogRun(directory: string, options: { scope?: LogScope; segmented?: boolean } = {}): void {
  const path = ownedPath(directory, marker);
  if (existsSync(path)) throw new Error("log run already exists");
  // codeql[js/file-system-race] Exclusive creation (wx) makes a concurrent existing receipt fail without modifying it.
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      state: LogRunState.Active,
      started: new Date().toISOString(),
      files: [],
      errors: [],
      owner: { pid: process.pid, host: hostname() },
      scope: options.scope ?? LogScope.Check,
      ...(options.segmented ? { segmented: true } : {}),
    } satisfies LogRun),
    { flag: "wx", mode: 0o600 },
  );
}
export function logSegments(directory: string): string[] {
  return [...entries(directory)]
    .filter((name) => /^session-\d+$/.test(name))
    .sort()
    .map((name) => {
      const path = ownedPath(directory, name);
      if (!lstatSync(path).isDirectory() || readRun(path).scope !== LogScope.Server)
        throw new Error("uncertain server log segment; preserving evidence");
      return path;
    });
}
export function requireActiveLogRun(directory: string): void {
  if (readRun(directory).state !== LogRunState.Active || !existsSync(`${directory}.lock`))
    throw new Error("parent log run is no longer active; preserving existing evidence");
}
export async function* walkLogSegments(directory: string): AsyncGenerator<{ directory: string; receipt: LogReceipt }> {
  for await (const entry of await opendir(directory))
    if (/^session-\d+$/.test(entry.name)) {
      const path = ownedPath(directory, entry.name);
      if (!entry.isDirectory()) throw new Error("uncertain server log segment; preserving evidence");
      const receipt = readRun(path);
      if (receipt.scope !== LogScope.Server || receipt.segmented)
        throw new Error("invalid server log segment; preserving evidence");
      yield { directory: path, receipt };
    }
}
export function* logFiles(directory: string): Generator<string> {
  for (const name of entries(directory)) {
    const stat = lstatSync(ownedPath(directory, name));
    if (stat.isDirectory()) {
      if (!/^session-\d+$/.test(name)) throw new Error("unknown directory in log run; preserving evidence");
      for (const child of entries(ownedPath(directory, name))) {
        const relative = `${name}/${child}`;
        if (!lstatSync(ownedPath(directory, relative)).isFile())
          throw new Error("non-file in log run; preserving evidence");
        yield relative;
      }
    } else {
      if (!stat.isFile()) throw new Error("non-file in log run; preserving evidence");
      yield name;
    }
  }
}
