import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../diagnostics.js";
import { knownRoute, Route } from "./routes.js";

export const timingPhases = ["collect", "formatting", "workspace", "render", "verification", "original"] as const;
export type TimingPhase = (typeof timingPhases)[number];

/** Fixed phase names keep metrics and Server-Timing bounded and independent of record identifiers. */
export class RequestTimings {
  constructor(
    private readonly response: ServerResponse,
    private readonly metrics: WebMetrics,
  ) {}
  record(phase: TimingPhase, ms: number): void {
    this.metrics.phase(phase, ms);
    if (!this.response.headersSent)
      this.response.appendHeader("server-timing", `${phase};dur=${Math.max(0, ms).toFixed(2)}`);
  }
  async measure<T>(phase: TimingPhase, action: () => T | Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await action();
    } finally {
      this.record(phase, performance.now() - started);
    }
  }
}
const counters = [
  "requests",
  "requestFailures",
  "requestAborts",
  "requestDurationSamples",
  "liveConnectionsClosed",
  "liveConnectionDurationMsTotal",
  "liveConnectionDurationMsMax",
  "requestDurationMsTotal",
  "requestDurationMsMax",
  "refreshes",
  "workspaceCaptures",
  "workspaceReuses",
  "publicationReuses",
  "refreshFailures",
  "refreshDurationMsTotal",
  "refreshDurationMsMax",
  "watchFailures",
  "watchRecoveries",
  "streamFailures",
  "slowClientDisconnects",
  "rejectedConnections",
  "mutationsApplied",
  "previewsPrepared",
  "actionFailures",
  "refreshAfterMutationFailures",
] as const;
type Counter = (typeof counters)[number];
const observations = new WeakMap<ServerResponse, { id: string; owner: WebMetrics; observers: WeakSet<WebMetrics> }>();
/** Fixed metric names and cumulative totals bound instrumentation cardinality and storage. */
export class WebMetrics {
  private readonly phases = Object.fromEntries(
    timingPhases.map((name) => [name, { samples: 0, totalMs: 0, maxMs: 0 }]),
  ) as Record<TimingPhase, { samples: number; totalMs: number; maxMs: number }>;
  phase(name: TimingPhase, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const value = this.phases[name];
    value.samples = Math.min(Number.MAX_SAFE_INTEGER, value.samples + 1);
    value.totalMs = Math.min(Number.MAX_SAFE_INTEGER, value.totalMs + ms);
    value.maxMs = Math.max(value.maxMs, ms);
  }
  private readonly started = performance.now();
  private readonly values = Object.fromEntries(counters.map((name) => [name, 0])) as Record<Counter, number>;
  count(name: Counter, amount = 1): void {
    this.values[name] = Math.min(Number.MAX_SAFE_INTEGER, this.values[name] + amount);
  }
  duration(kind: "request" | "refresh", milliseconds: number): void {
    const total = kind === "request" ? "requestDurationMsTotal" : "refreshDurationMsTotal";
    const maximum = kind === "request" ? "requestDurationMsMax" : "refreshDurationMsMax";
    this.count(total, milliseconds);
    this.values[maximum] = Math.max(this.values[maximum], milliseconds);
  }
  snapshot(gauges: {
    collectedAt: string | undefined;
    refreshing: boolean;
    watchers: number;
    collectionsActive: number;
  }) {
    const age = gauges.collectedAt ? Date.now() - Date.parse(gauges.collectedAt) : NaN;
    return {
      version: 1,
      kind: "workbench-web-metrics",
      observedAt: new Date().toISOString(),
      uptimeMs: performance.now() - this.started,
      counters: { ...this.values },
      phases: Object.fromEntries(Object.entries(this.phases).map(([name, value]) => [name, { ...value }])),
      gauges: {
        snapshotAgeMs: Number.isFinite(age) ? Math.max(0, age) : null,
        refreshActive: gauges.refreshing,
        watchers: gauges.watchers,
        collectionOperationsActive: gauges.collectionsActive,
      },
    };
  }
  request(request: IncomingMessage, response: ServerResponse, source = request.url ?? ""): string {
    const route = source.split("?")[0] ?? "unknown";
    const operation = knownRoute(route);
    let observation = observations.get(response);
    if (observation?.observers.has(this)) return observation.id;
    if (!observation) {
      const previous = response.getHeader("x-workbench-request-id");
      observation = {
        id: typeof previous === "string" ? previous : randomUUID(),
        owner: this,
        observers: new WeakSet(),
      };
      observations.set(response, observation);
    }
    observation.observers.add(this);
    const { id, owner } = observation,
      started = performance.now();
    let completed = false;
    response.setHeader("x-workbench-request-id", id);
    const finish = () => {
      if (completed) return;
      completed = true;
      const durationMs = performance.now() - started,
        aborted = !response.writableFinished;
      this.count("requests");
      if (operation === Route.Events) {
        this.count("liveConnectionsClosed");
        this.count("liveConnectionDurationMsTotal", durationMs);
        this.values.liveConnectionDurationMsMax = Math.max(this.values.liveConnectionDurationMsMax, durationMs);
      } else {
        this.duration("request", durationMs);
        this.count("requestDurationSamples");
        if (aborted) this.count("requestAborts");
      }
      if (response.statusCode >= 400) this.count("requestFailures");
      if (owner === this)
        diagnostic(
          operation !== Route.Events && aborted && !["GET", "HEAD"].includes(request.method ?? "")
            ? LogLevel.Info
            : LogLevel.Debug,
          DiagnosticOperation.WebRequest,
          aborted ? DiagnosticOutcome.Cancelled : DiagnosticOutcome.Completed,
          {
            requestId: id,
            route: operation,
            method: request.method ?? "unknown",
            status: response.headersSent ? response.statusCode : null,
            durationMs: Math.round(durationMs * 1000) / 1000,
          },
        );
    };
    response.once("finish", finish);
    response.once("close", finish);
    response.once("workbench-stream-failure", () => {
      this.count("streamFailures");
    });
    if (response.destroyed || response.writableFinished) finish();
    return id;
  }
}
export function streamFailure(response: ServerResponse, operation: DiagnosticOperation, error: unknown): void {
  diagnostic(
    LogLevel.Error,
    operation,
    DiagnosticOutcome.Failed,
    {
      requestId: String(response.getHeader("x-workbench-request-id") ?? "unavailable"),
      responseStarted: response.headersSent,
    },
    error,
    "stream failed",
  );
  response.emit("workbench-stream-failure");
  response.destroy();
}
