import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync, linkSync, rmSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CheckDetail } from "../scripts/check-detail-data.mjs";
import { checkDetailPrefix, readCheckDetail } from "../scripts/check-detail-data.mjs";
import type { planChecks } from "./check-plan.js";

export interface CheckResult {
  name: string;
  role: string;
  root: string;
  environment: string;
  status: "pending" | "running" | "passed" | "failed" | "cancelled";
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
  status: "running" | "passed" | "failed" | "cancelled";
  logs?: string;
  error?: string;
  checks: CheckResult[];
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
  ) {
    this.groups = plan.sessions.map((session) =>
      session.checks.map((check): CheckResult => ({
        name: check.name,
        role: check.role,
        root: session.directory,
        environment: session.environment,
        status: "pending",
        details: [],
        omittedDetails: 0,
      })),
    );
    this.result = {
      version: 1,
      kind: "workbench-check-run",
      id,
      started: new Date().toISOString(),
      status: "running",
      checks: this.groups.flat(),
    };
  }
  event(group: number, step: number, event: "start" | "pass" | "fail"): void {
    const check = this.groups[group]?.[step - 1];
    if (!check) throw new Error("Unknown report check");
    if (event === "start") {
      check.status = "running";
      this.started.set(check, this.now());
      this.active.set(group, check);
    } else {
      check.status = event === "pass" ? "passed" : "failed";
      check.durationMs = Math.max(0, this.now() - (this.started.get(check) ?? this.now()));
    }
  }
  detail(group: number, line: string): void {
    // Failed steps replay their captured diagnostics after the authenticated failure event.
    const check = this.active.get(group);
    if (!check) return;
    if (check.details.length >= 32 || Buffer.byteLength(line) > 16384) {
      check.omittedDetails++;
      return;
    }
    const detail = readCheckDetail(JSON.parse(line.slice(checkDetailPrefix.length)));
    if (JSON.stringify(check.details.at(-1)) !== JSON.stringify(detail)) check.details.push(detail);
  }
  finish(success: boolean, cancelled: boolean): void {
    this.result.status = cancelled ? "cancelled" : success ? "passed" : "failed";
    this.result.finished = new Date().toISOString();
    for (const check of this.result.checks)
      if (check.status === "running") {
        check.status = cancelled ? "cancelled" : "failed";
        check.durationMs = Math.max(0, this.now() - (this.started.get(check) ?? this.now()));
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
