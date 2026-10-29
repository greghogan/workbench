import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, lstatSync, opendirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { LogRunState, LogCompression, hasEnumValue, type DiagnosticError } from "./diagnostics.js";
import { ownedPath } from "./paths.js";
import { releaseAfterFailure } from "./cache-lock.js";
import { ownedFileBytes } from "./collection-files.js";
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
}
export const marker = ".workbench-log-run.json";
function entries(directory: string): { names: string[]; omitted: boolean } {
  const reader = opendirSync(directory),
    names: string[] = [];
  let omitted = false;
  try {
    for (;;) {
      const item = reader.readSync();
      if (!item) break;
      if (names.length >= 10000) {
        omitted = true;
        break;
      }
      names.push(item.name);
    }
  } catch (failure) {
    releaseAfterFailure(
      () => {
        reader.closeSync();
      },
      failure,
      "Log scan and directory cleanup failed",
    );
  }
  reader.closeSync();
  return { names, omitted };
}
/** Inspect ownership fields without claiming that unused manifest payloads have been decoded. */
export function readRun(directory: string): Pick<LogRun, "version" | "state" | "started" | "completed" | "owner"> {
  const value: unknown = JSON.parse(ownedFileBytes(directory, marker, 8 * 1024 * 1024).toString("utf8"));
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
    value.files.length > 10000 ||
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
  return {
    version: 1,
    state: value.state,
    started: value.started,
    ...(completed === undefined ? {} : { completed }),
    ...(owner ? { owner } : {}),
  };
}
export function publish(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
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
export function startLogRun(directory: string): void {
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
    } satisfies LogRun),
    { flag: "wx", mode: 0o600 },
  );
}
export function requireActiveLogRun(directory: string): void {
  if (readRun(directory).state !== LogRunState.Active || !existsSync(`${directory}.lock`))
    throw new Error("parent log run is no longer active; preserving existing evidence");
}
export function logFiles(directory: string): string[] {
  const files: string[] = [];
  const folders = [""];
  for (const prefix of folders) {
    const listed = entries(prefix ? ownedPath(directory, prefix) : directory);
    if (listed.omitted) throw new Error("log directory scan exceeds 10000 entries; source evidence preserved");
    for (const name of listed.names) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(ownedPath(directory, relative));
      if (stat.isDirectory()) {
        if (prefix || !/^session-\d+$/.test(name)) throw new Error("unknown directory in log run; preserving evidence");
        folders.push(relative);
      } else {
        if (!stat.isFile()) throw new Error("non-file in log run; preserving evidence");
        files.push(relative);
      }
      if (files.length + folders.length > 10000)
        throw new Error("log run exceeds 10000 files and directories; preserving evidence");
    }
  }
  return files;
}
