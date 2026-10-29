import { startWebServer } from "../src/web/server.ts";
import { afterEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ServerResponse, IncomingMessage, ServerResponse as Response } from "node:http";
import * as fs from "node:fs";
import { webServers, readWebPage, hiddenValue, postWebForm } from "./fixtures/web.mjs";
import { configureDiagnostics, type DiagnosticEvent } from "../scripts/diagnostics.mjs";

import { Socket } from "node:net";
import { WebMetrics } from "../src/web/observability.ts";
const servers = webServers();
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, watch: vi.fn(actual.watch), createReadStream: vi.fn(actual.createReadStream) };
});
afterEach(() => {
  configureDiagnostics();
  vi.restoreAllMocks();
});
function collect(): DiagnosticEvent[] {
  const events: DiagnosticEvent[] = [];
  configureDiagnostics({
    format: "json",
    level: "debug",
    sink: (text) => {
      events.push(JSON.parse(text) as DiagnosticEvent);
    },
  });
  return events;
}
test("nested request observers share one quiet cancellation log while maintaining separate metrics", () => {
  const events = collect(),
    socket = new Socket();
  try {
    const request = new IncomingMessage(socket);
    request.url = "/review";
    request.method = "GET";
    const response = new Response(request),
      hub = new WebMetrics(),
      project = new WebMetrics();
    const id = hub.request(request, response);
    expect(project.request(request, response)).toBe(id);
    expect(hub.request(request, response)).toBe(id);
    response.emit("close");
    response.emit("finish");
    const logs = events.filter((event) => event.operation === "web.request" && event.fields.requestId === id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "debug", outcome: "cancelled", fields: { status: null } });
    const gauges = { collectedAt: undefined, refreshing: false, watchers: 0, collectionsActive: 0 };
    for (const metrics of [hub, project]) {
      expect(metrics.snapshot(gauges).counters.requests).toBe(1);
      expect(metrics.snapshot(gauges).counters.requestAborts).toBe(1);
    }
  } finally {
    socket.destroy();
  }
});
test("HTTP failures correlate private operator causes with a controlled browser response", async () => {
  const events = collect(),
    root = servers.project();
  const web = await servers.start(root, {
    collectionRunner: () =>
      Promise.reject(
        new Error("private worker failure", {
          cause: Object.assign(new Error("underlying OS failure"), { code: "EIO" }),
        }),
      ),
  });
  const page = await readWebPage(web, "/collections");
  const response = await postWebForm(web, "/actions/collection-preview", {
    csrf: hiddenValue(page.html, "csrf"),
    source: "/fixture",
    commit: "a".repeat(40),
    visibility: "public",
    collection: ".",
  });
  expect(response.status).toBe(500);
  const body = await response.text(),
    id = response.headers.get("x-workbench-request-id");
  expect(body).toContain(id);
  expect(body).not.toContain("private worker failure");
  const failure = events.find(
    (event) => event.operation === "web.request" && event.outcome === "failed" && event.fields.requestId === id,
  );
  expect(failure?.error).toMatchObject({
    message: "private worker failure",
    causes: [{ code: "EIO", message: "underlying OS failure" }],
  });
});
test("metrics distinguish request failures from valid zeros and expose cumulative duration units", async () => {
  collect();
  const web = await servers.start(servers.project());
  await fetch(web.url + "/missing");
  const response = await fetch(web.url + "/metrics");
  const metrics = (await response.json()) as {
    version: number;
    kind: string;
    counters: Record<string, number>;
    gauges: { snapshotAgeMs: number | null; watchers: number };
  };
  expect(metrics).toMatchObject({ version: 1, kind: "workbench-web-metrics" });
  expect(metrics.counters.requestFailures).toBeGreaterThanOrEqual(1);
  expect(metrics.counters.requestDurationMsTotal).toBeGreaterThan(0);
  expect(metrics.counters.requestDurationMsMax).toBeLessThanOrEqual(metrics.counters.requestDurationMsTotal ?? 0);
  expect(metrics.gauges.snapshotAgeMs).not.toBeNull();
  expect(metrics.gauges.watchers).toBeGreaterThan(0);
});
test("a completed edit remains applied when the following refresh fails", async () => {
  const events = collect(),
    root = servers.project(),
    web = await servers.start(root);
  const editor = await readWebPage(web, "/record?id=demo:ADR-0&view=edit");
  vi.spyOn(web.monitor, "reconcile").mockRejectedValueOnce(new Error("refresh unavailable"));
  const response = await postWebForm(web, "/actions/save", {
    csrf: hiddenValue(editor.html, "csrf"),
    id: "demo:ADR-0",
    expected: hiddenValue(editor.html, "expected"),
    contents: "# Human edit\n\nSaved exact text.\n",
  });
  expect(response.status).toBe(200);
  expect(readFileSync(join(root, "workbench/decisions/ADR-00.md"), "utf8")).toContain("Saved exact text.");
  expect(events.find((event) => event.operation === "web.action.refresh")?.fields).toMatchObject({
    outcome: "applied",
    observed: "previous snapshot retained",
  });
});
test("slow live clients expose dropped-delivery diagnostics and a counter", async () => {
  const events = collect(),
    web = await servers.start(servers.project());
  let live: ServerResponse | undefined;
  web.server.on("request", (request, response) => {
    if (request.url === "/events") live = response;
  });
  const response = await fetch(web.url + "/events");
  if (!live) throw new Error("Expected live response");
  Object.defineProperty(live, "writableLength", { configurable: true, value: 65537 });
  web.monitor.emit("change", "changed");
  await response.body?.cancel().catch(() => undefined);
  const snapshot = web.metrics.snapshot({
    collectedAt: web.monitor.index?.snapshot.collectedAt,
    refreshing: false,
    watchers: web.monitor.watcherCount,
    collectionsActive: 0,
  });
  expect(snapshot.counters.slowClientDisconnects).toBe(1);
  expect(
    events.some((event) => event.outcome === "dropped" && event.message?.includes("queued events unavailable")),
  ).toBe(true);
});
test("watcher failure and recovery are explicit while periodic reconciliation remains available", async () => {
  const events = collect();
  vi.mocked(fs.watch).mockImplementationOnce(() => {
    throw Object.assign(new Error("watch budget exhausted"), { code: "ENOSPC" });
  });
  const web = await servers.start(servers.project());
  expect(events.some((event) => event.operation === "workspace.watch" && event.outcome === "degraded")).toBe(true);
  await web.monitor.reconcile(true);
  expect(events.some((event) => event.operation === "workspace.watch" && event.outcome === "recovered")).toBe(true);
  const metrics = web.metrics.snapshot({
    collectedAt: web.monitor.index?.snapshot.collectedAt,
    refreshing: false,
    watchers: web.monitor.watcherCount,
    collectionsActive: 0,
  });
  expect(metrics.counters.watchFailures).toBe(1);
  expect(metrics.counters.watchRecoveries).toBe(1);
});
test("supporting-file stream failures retain their cause and correlation identity", async () => {
  const events = collect(),
    root = servers.project();
  fs.mkdirSync(join(root, "workbench/decisions/ADR-00"));
  fs.writeFileSync(join(root, "workbench/decisions/ADR-00/evidence.txt"), "retained evidence");
  const web = await servers.start(root);
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  let closed: Promise<void> = Promise.resolve();
  vi.mocked(fs.createReadStream).mockImplementationOnce((...args) => {
    const stream = actual.createReadStream(...args);
    closed = new Promise<void>((resolve) => {
      stream.once("close", resolve);
    });
    queueMicrotask(() => {
      stream.destroy(Object.assign(new Error("source read failed"), { code: "EIO" }));
    });
    return stream;
  });
  await expect(
    fetch(web.url + "/file?id=demo:ADR-0&path=workbench/decisions/ADR-00/evidence.txt&download=1"),
  ).rejects.toThrow();
  await closed;
  const failure = events.find((event) => event.operation === "web.supporting-file" && event.outcome === "failed");
  expect(failure?.error?.code).toBe("EIO");
  expect(failure?.fields.requestId).toEqual(expect.any(String));
});

test("shutdown releases the HTTP listener even when worker cleanup reports a failure", async () => {
  const root = servers.project();
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", resolve(import.meta.dirname, ".."));
  const web = await startWebServer(root, { port: 0 });
  const original = web.monitor.close.bind(web.monitor);
  vi.spyOn(web.monitor, "close").mockImplementation(async () => {
    await original();
    throw new Error("worker cleanup canary");
  });
  await expect(web.close()).rejects.toThrow("worker cleanup canary");
  expect(web.server.listening).toBe(false);
});
