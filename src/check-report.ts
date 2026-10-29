import { CheckEvent, type ProcessTermination } from "../scripts/diagnostic-contract.mjs";
import { CheckState, diagnosticError, describeError, type DiagnosticError } from "./diagnostics.js";
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync, linkSync, rmSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { type CheckDetail, checkDetailPrefix, readCheckDetail } from "../scripts/check-detail-data.mjs";
import type { planChecks } from "./check-plan.js";

export interface CheckResult {
  name: string;
  role: string;
  root: string;
  environment: string;
  status: CheckState;
  started?: string;
  finished?: string;
  log?: string;
  error?: DiagnosticError;
  blockedReason?: string;
  durationMs?: number;
  details: CheckDetail[];
  omittedDetails: number;
}
export interface CheckRunResult {
  version: 1;
  kind: "workbench-check-run";
  id: string;
  started: string;
  finished?: string;
  status: Exclude<CheckState, typeof CheckState.Pending | typeof CheckState.Blocked>;
  reused?: { verified: string };
  logs?: string;
  logFinalizationDurationMs?: number;
  error?: string;
  checks: CheckResult[];
  groups: {
    root: string;
    environment: string;
    status: CheckResult["status"];
    started?: string;
    finished?: string;
    stdout?: string;
    stderr?: string;
    error?: DiagnosticError;
    termination?: ProcessTermination;
  }[];
  logIssues: DiagnosticError[];
}
export class CheckReport {
  readonly result: CheckRunResult;
  private readonly groups: CheckResult[][];
  private readonly started = new Map<CheckResult, number>();
  private readonly active = new Map<number, CheckResult>();
  constructor(
    id: string,
    plan: ReturnType<typeof planChecks>,
    private readonly now = () => performance.now(),
    private readonly wallTime = () => new Date().toISOString(),
  ) {
    this.groups = plan.sessions.map((session) =>
      session.checks.map((check): CheckResult => ({
        name: check.name,
        role: check.role,
        root: session.directory,
        environment: session.environment,
        status: CheckState.Pending,
        details: [],
        omittedDetails: 0,
      })),
    );
    this.result = {
      version: 1,
      kind: "workbench-check-run",
      id,
      started: this.wallTime(),
      status: CheckState.Running,
      checks: this.groups.flat(),
      groups: plan.sessions.map((session) => ({
        root: session.directory,
        environment: session.environment,
        status: CheckState.Pending,
      })),
      logIssues: [],
    };
  }
  event(group: number, step: number, event: CheckEvent): CheckResult {
    const check = this.groups[group]?.[step - 1];
    if (!check) throw new Error("Unknown report check");
    if (event === CheckEvent.Start) {
      check.status = CheckState.Running;
      check.started = this.wallTime();
      this.started.set(check, this.now());
      this.active.set(group, check);
    } else {
      this.terminate(check, event === CheckEvent.Pass ? CheckState.Passed : CheckState.Failed);
    }
    return check;
  }
  startGroup(group: number, stdout: string, stderr: string): void {
    const result = this.result.groups[group];
    if (!result) throw new Error("Unknown report group");
    Object.assign(result, { status: CheckState.Running, started: this.wallTime(), stdout, stderr });
  }
  finishGroup(group: number, error?: unknown, termination?: ProcessTermination, cancelled = false): void {
    const result = this.result.groups[group];
    if (!result) throw new Error("Unknown report group");
    result.status = cancelled ? CheckState.Cancelled : error === undefined ? CheckState.Passed : CheckState.Failed;
    result.finished = this.wallTime();
    if (termination) result.termination = termination;
    if (error !== undefined) {
      result.error = diagnosticError(error);
      for (const check of this.groups[group] ?? []) {
        if (check.status === CheckState.Failed || check.status === CheckState.Running) {
          check.error = result.error;
          this.terminate(
            check,
            cancelled && check.status === CheckState.Running ? CheckState.Cancelled : CheckState.Failed,
          );
        }
        if (check.status === CheckState.Pending) {
          check.status = cancelled ? CheckState.Cancelled : CheckState.Blocked;
          check.blockedReason = describeError(error);
        }
      }
    }
  }
  private terminate(check: CheckResult, status: CheckState): void {
    check.status = status;
    check.finished ??= this.wallTime();
    if (check.started !== undefined)
      check.durationMs ??= Math.max(0, this.now() - (this.started.get(check) ?? this.now()));
  }
  failureLog(group: number): string | undefined {
    return this.groups[group]?.find((check) => check.status === CheckState.Failed)?.log;
  }
  retainedLogs(group: number, directory: string, files: string[]): void {
    for (const file of files) {
      const step = /^step-(\d+)\./.exec(file)?.[1];
      const check = step ? this.groups[group]?.[Number(step) - 1] : undefined;
      if (check) check.log = join(directory, file);
    }
  }
  logIssue(error: unknown): void {
    if (this.result.logIssues.length < 32) this.result.logIssues.push(diagnosticError(error));
    else {
      const last = this.result.logIssues[31];
      this.result.logIssues[31] = {
        name: "Omitted",
        message: "Additional log-retention failures omitted",
        omittedCauses: (last?.name === "Omitted" ? (last.omittedCauses ?? 0) : 1) + 1,
      };
    }
  }
  detail(group: number, line: string): { check: CheckResult; detail: CheckDetail } | undefined {
    // Failed steps replay their captured diagnostics after the authenticated failure event.
    const check = this.active.get(group);
    if (!check) return;
    if (check.details.length >= 32 || Buffer.byteLength(line) > 16384) {
      check.omittedDetails++;
      return;
    }
    const detail = readCheckDetail(JSON.parse(line.slice(checkDetailPrefix.length)));
    if (JSON.stringify(check.details.at(-1)) === JSON.stringify(detail)) return;
    check.details.push(detail);
    return { check, detail };
  }
  finish(success: boolean, cancelled: boolean): void {
    this.result.status = cancelled ? CheckState.Cancelled : success ? CheckState.Passed : CheckState.Failed;
    this.result.finished = this.wallTime();
    for (const check of this.result.checks)
      if (check.status === CheckState.Running) {
        this.terminate(check, cancelled ? CheckState.Cancelled : CheckState.Failed);
      }
    for (const check of this.result.checks)
      if (check.status === CheckState.Pending) {
        check.status = cancelled ? CheckState.Cancelled : CheckState.Blocked;
        check.blockedReason = cancelled
          ? "Run cancelled before admission"
          : "Earlier group failure or unsatisfied dependency prevented admission";
      }
    for (const group of this.result.groups)
      if (group.status === CheckState.Pending || group.status === CheckState.Running) {
        group.status = cancelled
          ? CheckState.Cancelled
          : group.status === CheckState.Running
            ? CheckState.Failed
            : CheckState.Blocked;
        group.finished = this.result.finished;
      }
  }
}

export function checkReportDestination(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })) throw new Error(`${path}: report destination already exists`);
}

/** Publish a complete report atomically without replacing caller-owned data. */
export function writeCheckReport(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
