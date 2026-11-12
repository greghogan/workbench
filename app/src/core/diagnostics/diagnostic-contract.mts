export const diagnosticLogFile = "events.jsonl";
export const LogLevel = { Debug: "debug", Info: "info", Warn: "warn", Error: "error" } as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];
const severity: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
export function acceptsLogLevel(level: LogLevel, minimum: LogLevel): boolean {
  return severity[level] >= severity[minimum];
}
export function minimumLogLevel(left: LogLevel, right: LogLevel): LogLevel {
  return acceptsLogLevel(left, right) ? right : left;
}
export const LogFormat = { Text: "text", Json: "json" } as const;
export type LogFormat = (typeof LogFormat)[keyof typeof LogFormat];
export const DiagnosticFlag = {
  Level: "--log-level",
  FileLevel: "--log-file-level",
  Format: "--log-format",
} as const;
export const diagnosticOptions = [
  {
    flag: DiagnosticFlag.Level,
    key: "logLevel",
    argument: "level",
    description: "Diagnostic severity on stderr",
    choices: Object.values(LogLevel),
  },
  {
    flag: DiagnosticFlag.FileLevel,
    key: "logFileLevel",
    argument: "level",
    description: "Diagnostic severity in retained logs",
    choices: Object.values(LogLevel),
  },
  {
    flag: DiagnosticFlag.Format,
    key: "logFormat",
    argument: "format",
    description: "Diagnostic rendering on stderr",
    choices: Object.values(LogFormat),
  },
] as const;
export const CheckEvent = { Start: "start", Pass: "pass", Fail: "fail" } as const;
export type CheckEvent = (typeof CheckEvent)[keyof typeof CheckEvent];
export interface ProcessTermination {
  pid: number | null;
  status: number | null;
  signal: string | null;
}
export interface ProcessDiagnostic extends ProcessTermination {
  operation: string;
}
export function readProcessDiagnostic(value: unknown): ProcessDiagnostic | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("operation" in value) ||
    typeof value.operation !== "string" ||
    value.operation.length > 1024 ||
    !("pid" in value) ||
    !(value.pid === null || (Number.isSafeInteger(value.pid) && Number(value.pid) > 0)) ||
    !("status" in value) ||
    !(value.status === null || Number.isSafeInteger(value.status)) ||
    !("signal" in value) ||
    !(value.signal === null || (typeof value.signal === "string" && value.signal.length <= 64))
  )
    return;
  return {
    operation: value.operation,
    pid: value.pid as number | null,
    status: value.status as number | null,
    signal: value.signal,
  };
}
export const DiagnosticOperation = {
  Command: "command",
  NetworkAcquisition: "network.acquisition",
  ArtifactConnection: "artifact.connection",
  AdvisoryConnection: "advisory.connection",
  CacheLock: "cache.lock",
  CacheRecovery: "cache.recovery",
  CheckLogs: "checks.logs",
  CheckCache: "checks.cache",
  CheckLogRetention: "checks.log-retention",
  CitationVerification: "citation.verify",
  LogCompression: "logs.compress",
  LogRetention: "logs.retention",
  CollectionWorker: "collection.worker",
  WebRequest: "web.request",
  WebAction: "web.action",
  WebActionRefresh: "web.action.refresh",
  WebErrorPage: "web.error-page",
  WebResponse: "web.response",
  WebListener: "web.listener",
  WebEvents: "web.events",
  WebService: "web.service",
  SupportingFile: "web.supporting-file",
  CitationDocument: "web.citation-document",
  PersistentDiagnostics: "diagnostics.persist",
  StderrDiagnostics: "diagnostics.stderr",
  WorkspaceRefresh: "workspace.refresh",
  WorkspaceWorker: "workspace.worker",
  WorkspaceWatch: "workspace.watch",
  CILogCompression: "ci.log-compression",
  LogRecovery: "logs.recovery",
} as const;
export type DiagnosticOperation = (typeof DiagnosticOperation)[keyof typeof DiagnosticOperation];
export const DiagnosticOutcome = {
  Started: "started",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
  Retrying: "retrying",
  Exhausted: "exhausted",
  Waiting: "waiting",
  Acquired: "acquired",
  Unavailable: "unavailable",
  Recovered: "recovered",
  Degraded: "degraded",
  Stopped: "stopped",
  Stopping: "stopping",
  Listening: "listening",
  Rejected: "rejected",
  Dropped: "dropped",
  Preserved: "preserved",
  Pruned: "pruned",
  Discarded: "discarded",
  Warnings: "completed-with-warnings",
  OverBudget: "over-budget",
  Fallback: "fallback",
  Applied: "applied",
  Prepared: "prepared",
  Requested: "requested",
  Reused: "reused",
  Stored: "stored",
  Missing: "missing",
  Unconfirmed: "unconfirmed",
} as const;
export type DiagnosticOutcome = (typeof DiagnosticOutcome)[keyof typeof DiagnosticOutcome];
export const CheckState = {
  Pending: "pending",
  Running: "running",
  Passed: "passed",
  Failed: "failed",
  Cancelled: "cancelled",
  Blocked: "blocked",
} as const;
export type CheckState = (typeof CheckState)[keyof typeof CheckState];
export const LogRunState = { Active: "active", Completed: "completed" } as const;
export type LogRunState = (typeof LogRunState)[keyof typeof LogRunState];
export const LogCompression = { Zstd: "zstd", Gzip: "gzip", None: "none" } as const;
export type LogCompression = (typeof LogCompression)[keyof typeof LogCompression];
export const LogCompressionPreference = { Auto: "auto", ...LogCompression } as const;
export type LogCompressionPreference = (typeof LogCompressionPreference)[keyof typeof LogCompressionPreference];
export const LogScope = { Check: "check", Cli: "cli", Server: "server" } as const;
export type LogScope = (typeof LogScope)[keyof typeof LogScope];
export const WebAction = {
  PolicyResolution: "policy-resolution",
  Task: "task-state",
  Queue: "task-queue",
  CreateCharter: "create-charter",
  Save: "save",
  Review: "review",
  ReviewPrepare: "review-prepare",
  Preview: "collection-preview",
  Apply: "collection-apply",
  Unknown: "unknown",
} as const;
export type WebAction = (typeof WebAction)[keyof typeof WebAction];
export const ActionEffect = {
  Applied: "applied",
  Prepared: "prepared",
  Rejected: "rejected",
  Unconfirmed: "unconfirmed",
} as const;
export type ActionEffect = (typeof ActionEffect)[keyof typeof ActionEffect];
export const CollectionOperation = { Preview: "preview", Apply: "apply" } as const;
export type CollectionOperation = (typeof CollectionOperation)[keyof typeof CollectionOperation];
export function hasEnumValue<T extends string>(choices: Readonly<Record<string, T>>, value: unknown): value is T {
  return typeof value === "string" && Object.values(choices).some((choice) => choice === value);
}
