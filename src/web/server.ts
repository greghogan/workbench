import { knownRoute, routeContracts, decodeRouteQuery, Route, actionDefinition } from "./routes.js";
import {
  ActionEffect,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  WebAction,
  diagnostic,
  settleCleanup,
} from "../diagnostics.js";
import { reviewSource } from "../review-service.js";
import { WorkspaceView } from "../workspace-service.js";
import { reviewLocation, reviewNavigation } from "./review-navigation.js";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename } from "node:path";
import { CacheBusy } from "../cache-lock.js";
import { InvalidInput, MissingResource, StateConflict } from "../input-errors.js";
import { ownedPath } from "../paths.js";
import { recordBytes, supportingFiles } from "../record-service.js";
import { WebActions } from "./actions.js";
import { browserScript, stylesheet } from "./assets.js";
import { CitationDocuments } from "./citation-documents.js";
import type { runCollectionWorker } from "./collection-runner.js";
import { sendDownload } from "./downloads.js";
import { WebError } from "./errors.js";
import { readForm, requestOrigin, secureResponse, send } from "./http.js";
import { WorkspaceMonitor } from "./live.js";
import {
  collectionProposalPage,
  collectionsPage,
  newCharterPage,
  overview,
  recordPage,
  supportingFilePage,
  recordsPage,
  reviewPage,
} from "./pages.js";
import { projectPath, withProjectPaths } from "./project-paths.js";
import { requestUnavailablePage } from "./page-frame.js";
import { type ViewContext } from "./view-context.js";
import { errorResponse } from "./error-response.js";
import { WebMetrics } from "./observability.js";

interface WebOptions {
  listen?: boolean;
  basePath?: string;
  projectName?: string;
  demonstration?: boolean;
  collectionDefaults?: { source: string; commit: string };
  host?: "127.0.0.1" | "::1";
  port?: number;
  pollInterval?: number;
  collectionRunner?: typeof runCollectionWorker;
}
export async function startWebServer(root: string, options: WebOptions = {}) {
  const host = options.host ?? "127.0.0.1",
    port = options.port ?? 8080;
  if (!["127.0.0.1", "::1"].includes(host) || !Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error("serve requires a loopback host and a port from 0 to 65535");
  const csrf = randomBytes(32).toString("hex");
  const metrics = new WebMetrics();
  const monitor = new WorkspaceMonitor(root, options.pollInterval, metrics);
  const clients = new Set<ServerResponse>();
  const citationDocuments = new CitationDocuments(root);
  const actions = new WebActions(root, options.collectionRunner);
  try {
    await monitor.ready();
  } catch (error) {
    await settleCleanup([() => monitor.close()], error);
    throw error;
  }
  let closing = false;
  const requireRunning = () => {
    if (closing) throw new WebError(503, "Service is stopping; no changes were applied.");
  };
  const context = (parameters = new URLSearchParams(), requestLocation?: string): ViewContext => {
    if (!monitor.index) throw new WebError(503, "Workspace snapshot is not available.");
    return Object.assign(monitor.index.select(Object.fromEntries(parameters)), {
      csrf,
      requestLocation: requestLocation ?? Route.Overview,
      refreshing: monitor.refreshing,
      problem: monitor.problem,
      basePath: options.basePath ?? "",
      projectName: options.projectName ?? "",
      demonstration: options.demonstration ?? false,
      ...(options.collectionDefaults ? { collectionDefaults: options.collectionDefaults } : {}),
    });
  };
  const handle = (request: IncomingMessage, response: ServerResponse) =>
    withProjectPaths(options.basePath ?? "", () => handleRequest(request, response));
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    secureResponse(response);
    const requestId = metrics.request(request, response);
    let form: URLSearchParams | undefined;
    let url: URL | undefined;
    try {
      if (closing) {
        send(response, 503, "text/plain; charset=utf-8", "Service is stopping.");
        return;
      }
      const origin = requestOrigin(request);
      url = new URL(request.url ?? Route.Overview, origin);
      if (url.origin !== origin) throw new WebError(400, "request URL is outside this service");
      const route = knownRoute(url.pathname);
      if (route !== "unknown") {
        const contract = routeContracts[route];
        if (!contract.methods.includes(request.method ?? "")) {
          response.setHeader("allow", contract.methods.join(", "));
          send(response, 405, "text/plain", "Method not allowed.");
          return;
        }
        decodeRouteQuery(route, url.searchParams);
      }
      if (url.pathname === Route.CitationDocument) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.setHeader("allow", "GET, HEAD");
          send(response, 405, "text/plain", "Method not allowed.");
          return;
        }
        const id = url.searchParams.get("id") ?? "";
        if (monitor.index?.byId.get(id)?.type !== "CIT") throw new WebError(404, "citation record not found");
        await citationDocuments.serve(
          request,
          response,
          id,
          url.searchParams.get("source") ?? "",
          url.searchParams.get("download") === "1",
        );
        return;
      }
      if (request.method === "GET") {
        if (url.pathname === Route.Metrics) {
          send(
            response,
            200,
            "application/json",
            JSON.stringify(
              metrics.snapshot({
                collectedAt: monitor.index?.snapshot.collectedAt,
                refreshing: monitor.refreshing,
                watchers: monitor.watcherCount,
                collectionsActive: actions.activeOperations,
              }),
            ),
          );
          return;
        }
        if (url.pathname === Route.Events) {
          if (clients.size >= 32) {
            metrics.count("rejectedConnections");
            diagnostic(
              LogLevel.Warn,
              DiagnosticOperation.WebEvents,
              DiagnosticOutcome.Rejected,
              { maximumClients: 32, requestId },
              undefined,
              "connection capacity exhausted",
            );
            send(response, 503, "text/plain", "Too many live browser connections.");
            return;
          }
          response.writeHead(200, {
            "content-type": "text/event-stream",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          response.write(`event: revision\ndata: ${monitor.revision}\n\n`);
          clients.add(response);
          response.on("close", () => {
            clients.delete(response);
          });
          return;
        }
        if (url.pathname === Route.Style) {
          send(response, 200, "text/css; charset=utf-8", stylesheet);
          return;
        }
        if (url.pathname === Route.Client) {
          send(response, 200, "text/javascript; charset=utf-8", browserScript);
          return;
        }
        if (url.pathname === Route.Favicon) {
          response.writeHead(204);
          response.end();
          return;
        }
        if (url.pathname === Route.ReviewFile) {
          await monitor.reconcile(true);
          const selected = context(url.searchParams, url.pathname + url.search);
          const change = selected.index.reviewChange(
            url.searchParams.get("path") ?? "",
            url.searchParams.has("review_source") ? reviewSource(url.searchParams.get("review_source")) : undefined,
          );
          if (!change) throw new WebError(404, "protected file version not found");
          if (change.digest !== url.searchParams.get("digest"))
            throw new WebError(409, "file version changed; refresh the review");
          const side = url.searchParams.get("side");
          if (side !== "before" && side !== "after") throw new WebError(400, "select the previous or reviewed file");
          const encoded = selected.reviewDocument(change.digest)[side];
          if (encoded === null) throw new WebError(404, "file is absent in the selected version");
          const bytes = Buffer.from(encoded, "base64");
          response.setHeader(
            "content-disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(basename(change.path))}`,
          );
          send(response, 200, "application/octet-stream", bytes);
          return;
        }
        if (url.pathname === Route.File) {
          const record = monitor.index?.byId.get(url.searchParams.get("id") ?? ""),
            path = url.searchParams.get("path") ?? "";
          if (!record) throw new WebError(404, "record not found");
          if (!supportingFiles(record).some((file) => file.path === path))
            throw new WebError(404, "supporting file not found");
          if (url.searchParams.get("download") === "1") {
            sendDownload(response, record.directory, path);
            return;
          }
          const stat = lstatSync(ownedPath(record.directory, path));
          const bytes = stat.size <= 2 * 1024 * 1024 ? recordBytes({ directory: record.directory, path }) : undefined;
          send(
            response,
            200,
            "text/html; charset=utf-8",
            supportingFilePage(
              context(url.searchParams, url.pathname + url.search),
              record,
              path,
              bytes && !bytes.includes(0) ? bytes.toString("utf8") : undefined,
            ),
          );
          return;
        }
        const scope = url.searchParams.get("scope"),
          collection = url.searchParams.get("collection"),
          id = url.searchParams.get("id");
        const missingSource =
          (url.searchParams.get("all") !== "1" &&
            !!scope &&
            !monitor.index?.snapshot.projects.some((project) => project.id === scope)) ||
          (!!collection && !monitor.index?.sources.includes(collection));
        const missingRecord = url.pathname === Route.Record && !!id && !monitor.index?.byId.has(id);
        if (
          missingSource ||
          missingRecord ||
          url.pathname === Route.NewCharter ||
          url.pathname === Route.Review ||
          (url.pathname === Route.Record && url.searchParams.get("view") === "edit")
        )
          await monitor.reconcile(true);
        const selected = context(url.searchParams, url.pathname + url.search);
        let page: string;
        switch (url.pathname) {
          case Route.NewCharter:
            page = newCharterPage(selected, url.searchParams.get("project") ?? "");
            break;
          case Route.Overview:
            page = overview(selected);
            break;
          case Route.Records:
            page = recordsPage(selected, url.searchParams);
            break;
          case Route.Record:
            page = recordPage(selected, url.searchParams);
            break;
          case Route.Review:
            page = reviewPage(selected, url.searchParams);
            break;
          case Route.Collections:
            page = collectionsPage(selected);
            break;
          case Route.Proposal: {
            const token = url.searchParams.get("token") ?? "",
              saved = actions.proposal(token);
            page = collectionProposalPage(selected, token, saved.request, saved.plan);
            break;
          }
          default:
            send(response, 404, "text/plain; charset=utf-8", "View not found.");
            return;
        }
        send(response, 200, "text/html; charset=utf-8", page);
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "GET, POST");
        send(response, 405, "text/plain", "Method not allowed.");
        return;
      }
      form = await readForm(request);
      requireRunning();
      if (form.get("csrf") !== csrf) throw new WebError(403, "invalid browser review session; reload this page");
      if (url.pathname === Route.WorkspaceRetry) {
        await monitor.retry();
        const redirect = projectPath(Route.Overview);
        if (request.headers.accept?.includes("application/json"))
          send(response, 200, "application/json", JSON.stringify({ redirect }));
        else {
          response.writeHead(303, { location: redirect });
          response.end();
        }
        return;
      }
      const operation = actionDefinition(url.pathname)?.operation ?? WebAction.Unknown;
      const reviewContext =
        operation === WebAction.Review
          ? monitor.index?.select({
              collection: form.get("record_source") ?? "",
              scope: form.get("record_scope") ?? monitor.index.snapshot.projects[0]?.id ?? "",
              all: form.get("record_all") ?? "",
            })
          : undefined;
      const selectedId = form.get("id") ?? "",
        selectedPath = form.get("path") ?? "";
      const target =
        operation === WebAction.Save && monitor.index?.byId.has(selectedId)
          ? selectedId
          : operation === WebAction.Review && monitor.index?.reviewChange(selectedPath)
            ? selectedPath
            : operation === WebAction.Preview || operation === WebAction.Apply
              ? "collection"
              : "unresolved";
      diagnostic(LogLevel.Info, DiagnosticOperation.WebAction, DiagnosticOutcome.Requested, {
        requestId,
        operation,
        target,
      });
      let result: Awaited<ReturnType<WebActions["run"]>>;
      try {
        result = await actions.run(url.pathname, form);
      } catch (error) {
        metrics.count("actionFailures");
        const rejected =
          error instanceof WebError ||
          error instanceof InvalidInput ||
          error instanceof StateConflict ||
          error instanceof MissingResource ||
          error instanceof CacheBusy;
        diagnostic(
          rejected ? LogLevel.Warn : LogLevel.Error,
          DiagnosticOperation.WebAction,
          rejected ? DiagnosticOutcome.Rejected : DiagnosticOutcome.Unconfirmed,
          {
            requestId,
            operation,
            desired: operation,
            observed: "operation did not report completion",
            outcome: rejected ? ActionEffect.Rejected : ActionEffect.Unconfirmed,
          },
          error,
          "failed; effects require inspection",
        );
        throw error;
      }
      metrics.count(result.effect === ActionEffect.Prepared ? "previewsPrepared" : "mutationsApplied");
      diagnostic(LogLevel.Info, DiagnosticOperation.WebAction, DiagnosticOutcome.Completed, {
        requestId,
        operation,
        target,
        desired: operation,
        observed: operation === WebAction.Preview ? "preview prepared" : "operation completed",
        outcome: result.effect,
      });
      await monitor.reconcile(true).catch((error: unknown) => {
        metrics.count("refreshAfterMutationFailures");
        diagnostic(
          LogLevel.Warn,
          DiagnosticOperation.WebActionRefresh,
          DiagnosticOutcome.Unavailable,
          {
            requestId,
            operation,
            outcome: result.effect,
            observed: "previous snapshot retained",
          },
          error,
          "action completed; refreshed view unavailable",
        );
      });
      if (reviewContext && monitor.index) {
        const context = new WorkspaceView(
          monitor.index,
          reviewContext.selection,
          reviewContext.scope,
          reviewContext.all,
        );
        const next = reviewNavigation(context, form.get("digest") ?? "").nextPending;
        if (next)
          result.redirect = reviewLocation(context, next, form.get("review_layout") === "split" ? "split" : "unified");
      }
      if (request.headers.accept === "application/json")
        send(
          response,
          200,
          "application/json",
          JSON.stringify({ redirect: projectPath(result.redirect, options.basePath) }),
        );
      else {
        response.writeHead(303, { location: projectPath(result.redirect, options.basePath) });
        response.end();
      }
    } catch (error) {
      const { status, message: publicMessage } = errorResponse(error, requestId);
      diagnostic(
        status >= 500 ? LogLevel.Error : LogLevel.Warn,
        DiagnosticOperation.WebRequest,
        DiagnosticOutcome.Failed,
        { requestId, status, responseStarted: response.headersSent },
        error,
      );
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (request.headers.accept === "application/json") {
        send(response, status, "application/json", JSON.stringify({ error: publicMessage, requestId }));
        return;
      }
      try {
        if (url?.pathname === Route.CreateCharter && form) {
          send(
            response,
            status,
            "text/html; charset=utf-8",
            newCharterPage(context(), form.get("project") ?? "", {
              contents: form.get("contents") ?? "",
              error: publicMessage,
            }),
          );
          return;
        }
        if (url?.pathname === Route.Save && form) {
          send(
            response,
            status,
            "text/html; charset=utf-8",
            recordPage(
              context(new URLSearchParams({ id: form.get("id") ?? "" })),
              new URLSearchParams({ id: form.get("id") ?? "", view: "edit" }),
              {
                contents: form.get("contents") ?? "",
                expected: form.get("expected") ?? "",
                error: publicMessage,
              },
            ),
          );
          return;
        }
      } catch (renderError) {
        diagnostic(
          LogLevel.Error,
          DiagnosticOperation.WebErrorPage,
          DiagnosticOutcome.Fallback,
          { requestId },
          renderError,
          "fallback response required",
        );
      }
      send(response, status, "text/html; charset=utf-8", requestUnavailablePage(publicMessage));
    }
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      diagnostic(
        LogLevel.Error,
        DiagnosticOperation.WebResponse,
        DiagnosticOutcome.Failed,
        { requestId: String(response.getHeader("x-workbench-request-id") ?? "unavailable") },
        error,
        "connection terminated after boundary failure",
      );
      response.destroy();
    });
  });
  server.maxConnections = 64;
  server.on("drop", () => {
    metrics.count("rejectedConnections");
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.WebListener,
      DiagnosticOutcome.Rejected,
      { maximumConnections: 64 },
      undefined,
      "connection capacity exhausted",
    );
  });
  server.on("clientError", (error, socket) => {
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.WebListener,
      DiagnosticOutcome.Rejected,
      {},
      error,
      "invalid or incomplete HTTP request",
    );
    socket.destroy();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 50;
  const slowClient = (response: ServerResponse): boolean => {
    if (response.writableLength <= 64 * 1024) return false;
    metrics.count("slowClientDisconnects");
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.WebEvents,
      DiagnosticOutcome.Dropped,
      {
        requestId: String(response.getHeader("x-workbench-request-id") ?? "unavailable"),
        bufferedBytes: response.writableLength,
        bufferLimitBytes: 64 * 1024,
      },
      undefined,
      "slow client disconnected; queued events unavailable",
    );
    response.destroy();
    return true;
  };
  const broadcast = (revision: string) => {
    for (const response of clients) {
      if (!slowClient(response)) response.write(`event: revision\ndata: ${revision}\n\n`);
    }
  };
  monitor.on("change", broadcast);
  const freshness = () => {
    const data = JSON.stringify({
      refreshing: monitor.refreshing,
      problem: monitor.problem,
      collectedAt: monitor.index?.snapshot.collectedAt ?? "",
    });
    for (const response of clients) if (!slowClient(response)) response.write(`event: freshness\ndata: ${data}\n\n`);
  };
  monitor.on("freshness", freshness);

  const heartbeat = setInterval(() => {
    for (const response of clients) {
      if (!slowClient(response)) response.write(": keepalive\n\n");
    }
  }, 15_000);
  heartbeat.unref();
  try {
    if (options.listen !== false)
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
  } catch (error) {
    clearInterval(heartbeat);
    await settleCleanup([() => monitor.close()], error);
    throw error;
  }
  const address = server.address();
  if (options.listen !== false && (!address || typeof address === "string"))
    throw new Error("listener did not publish a local TCP address");
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      closing = true;
      diagnostic(
        LogLevel.Info,
        DiagnosticOperation.WebService,
        DiagnosticOutcome.Stopping,
        {},
        undefined,
        "stopping; admitted actions will drain",
      );
      clearInterval(heartbeat);
      await settleCleanup([
        () => actions.close(),
        () => monitor.close(),
        () => {
          for (const response of clients) response.end();
          clients.clear();
        },
        () =>
          new Promise<void>((resolve, reject) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
            server.closeIdleConnections();
          }),
      ]);
      diagnostic(LogLevel.Info, DiagnosticOperation.WebService, DiagnosticOutcome.Stopped);
    })();
    return closed;
  };
  const publishedPort = address && typeof address !== "string" ? address.port : 0;
  if (options.listen !== false)
    diagnostic(LogLevel.Info, DiagnosticOperation.WebService, DiagnosticOutcome.Listening, {
      host,
      port: publishedPort,
    });
  return {
    server,
    monitor,
    metrics,
    activeCollections: () => actions.activeOperations,
    handle,
    url: `http://${host === "::1" ? "[::1]" : host}:${String(publishedPort)}`,
    close,
  };
}
