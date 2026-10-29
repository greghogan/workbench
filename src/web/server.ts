import { performance } from "node:perf_hooks";
import { FormattingProblem } from "../review-formatting.js";
import { recordURL } from "./locations.js";
import { workspaceFormattingProposal } from "./workspace-formatting.js";
import { reviewFormattingPage } from "./review-formatting-page.js";
import { localEndpoint, createLocalServer, listenLocal, closeLocalServer } from "./http-listener.js";
import { compatibilityReviewPage } from "./compatibility-review.js";
import { WorkerGeneration } from "./worker-generation.js";
import { prepareReviewPage } from "./review-page.js";
import { taskQueuePage } from "./task-pages.js";
import {
  routeContracts,
  decodeRequest,
  sourceSelection,
  type DecodedRoute,
  Route,
  actionDefinition,
} from "./routes.js";
import {
  ActionEffect,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  WebAction,
  diagnostic,
  settleCleanup,
} from "../diagnostics.js";
import { WorkspaceView } from "../workspace-service.js";
import { reviewLocation, reviewNavigation } from "./review-navigation.js";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname } from "node:path";
import { CacheBusy } from "../cache-lock.js";
import { InvalidInput, MissingResource, StateConflict } from "../input-errors.js";
import { ownedPath } from "../paths.js";
import { recordBytes, supportingFiles } from "../record-service.js";
import { WebActions } from "./actions.js";
import { serveAsset } from "./asset-response.js";
import { citationInputsCurrent } from "./citation-freshness.js";
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
  supportingDirectoryPage,
  recordsPage,
  reviewPage,
} from "./pages.js";
import { projectPath, withProjectPaths } from "./project-paths.js";
import { requestUnavailablePage } from "./page-frame.js";
import { type ViewContext } from "./view-context.js";
import { decodeWorkerFailure, errorResponse } from "./error-response.js";
import { RequestTimings, WebMetrics } from "./observability.js";

interface WebOptions {
  workerBundle?: string;
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
  const { host, port } = localEndpoint(options);
  const csrf = randomBytes(32).toString("hex");
  const metrics = new WebMetrics();
  const generation = options.workerBundle ? undefined : new WorkerGeneration(root);
  const bundle = options.workerBundle ?? generation?.path;
  const monitor = new WorkspaceMonitor(root, options.pollInterval, metrics, undefined, bundle);
  const clients = new Set<ServerResponse>();
  const citationDocuments = new CitationDocuments((id) => {
    const citation = monitor.index?.snapshot.documents.get(id)?.citation;
    if (citation?.error)
      throw citation.failure
        ? decodeWorkerFailure(citation.failure)
        : new WebError(503, "Citation metadata is unavailable; refresh after correcting the record");
    return citation?.sources ?? [];
  });
  const actions = new WebActions(root, options.collectionRunner, undefined, bundle);
  try {
    await monitor.ready();
  } catch (error) {
    await settleCleanup([() => monitor.close(), () => generation?.close()], error);
    throw error;
  }
  let closing = false;
  const requireRunning = () => {
    if (closing) throw new WebError(503, "Service is stopping; no changes were applied.");
  };
  const context = (
    parameters: DecodedRoute["query"] = {},
    requestLocation?: string,
    reviewParameters = parameters,
  ): ViewContext => {
    if (!monitor.index) throw new WebError(503, "Workspace snapshot is not available.");
    return Object.assign(monitor.index.select(sourceSelection(parameters)), {
      csrf,
      requestLocation: requestLocation ?? Route.Overview,
      reviewTarget: {
        ...("id" in reviewParameters && reviewParameters.id ? { id: reviewParameters.id } : {}),
        ...("path" in reviewParameters && reviewParameters.path ? { path: reviewParameters.path } : {}),
      },
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
    const timings = new RequestTimings(response, metrics);
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
      const decoded = decodeRequest(url.pathname, url.searchParams);
      if (!decoded) {
        send(response, 404, "text/plain", "View not found.");
        return;
      }
      {
        const contract = routeContracts[decoded.route];
        if (!contract.methods.includes(request.method ?? "")) {
          response.setHeader("allow", contract.methods.join(", "));
          send(response, 405, "text/plain", "Method not allowed.");
          return;
        }
      }
      const { route, query } = decoded;
      if (route === Route.Style || route === Route.Client) {
        await serveAsset(request, response, route === Route.Style ? "style" : "client", query.v);
        return;
      }
      if (
        route === Route.CitationDocument ||
        route === Route.CitationOriginal ||
        route === Route.CitationOriginalContent
      ) {
        const id = query.id ?? "";
        if (!citationInputsCurrent(monitor.index, id))
          await timings.measure("workspace", () => monitor.reconcile(true));
        if (response.destroyed) return;
        if (monitor.index?.byId.get(id)?.type !== "CIT") throw new WebError(404, "citation record not found");
        await citationDocuments.serve(
          request,
          response,
          id,
          query.source ?? "",
          {
            view:
              route === Route.CitationOriginal
                ? "original"
                : route === Route.CitationOriginalContent
                  ? "original-content"
                  : "reader",
            download: "download" in query && query.download === "1",
            images: "images" in query && query.images === "1",
          },
          timings,
        );
        return;
      }
      if (request.method === "GET") {
        if (route === Route.Metrics) {
          send(
            response,
            200,
            "application/json",
            JSON.stringify(
              metrics.snapshot({
                collectedAt: monitor.index?.snapshot.collectedAt,
                refreshing: monitor.refreshing,
                watchers: monitor.watcherCount,
                collectionsActive: actions.activeCollections,
              }),
            ),
          );
          return;
        }
        if (route === Route.Events) {
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
        if (route === Route.Favicon) {
          response.writeHead(204);
          response.end();
          return;
        }
        if (route === Route.ReviewFile) {
          const retained = actions.reviews.get(query.path ?? "", query.digest ?? "");
          const side = query.side;
          if (side !== "before" && side !== "after") throw new WebError(400, "select the previous or reviewed file");
          const encoded = side === "before" ? retained.before : retained.version.contents;
          if (encoded === null) throw new WebError(404, "file is absent in the selected version");
          const bytes = Buffer.from(encoded, "base64");
          response.setHeader(
            "content-disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(basename(retained.version.change.path))}`,
          );
          send(response, 200, "application/octet-stream", bytes);
          return;
        }
        if (route === Route.File) {
          const record = monitor.index?.byId.get(query.id ?? ""),
            path = query.path ?? "";
          if (!record) throw new WebError(404, "record not found");
          const files = supportingFiles(record);
          const base = record.path.slice(0, -extname(record.path).length);
          const directory =
            !files.some((file) => file.path === path) &&
            record.type !== "CHARTER" &&
            (path === base || (path.startsWith(base + "/") && files.some((file) => file.path.startsWith(path + "/"))));
          if (directory) {
            if (query.download === "1") throw new WebError(400, "Select a file to download");
            send(
              response,
              200,
              "text/html; charset=utf-8",
              supportingDirectoryPage(context(query, url.pathname + url.search), record, path, files),
            );
            return;
          }
          if (!files.some((file) => file.path === path)) throw new WebError(404, "supporting file not found");
          if (query.download === "1") {
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
              context(query, url.pathname + url.search),
              record,
              path,
              bytes && !bytes.includes(0) ? bytes.toString("utf8") : undefined,
            ),
          );
          return;
        }
        const { scope, collection, id, all } = sourceSelection(query);
        const missingSource =
          (all !== "1" && !!scope && !monitor.index?.snapshot.projects.some((project) => project.id === scope)) ||
          (!!collection && !monitor.index?.sources.includes(collection));
        const missingRecord = route === Route.Record && !!id && !monitor.index?.byId.has(id);
        if (
          missingSource ||
          missingRecord ||
          route === Route.NewCharter ||
          route === Route.Review ||
          (route === Route.Record && query.view === "edit")
        )
          await timings.measure("workspace", () => monitor.reconcile());
        if (response.destroyed) return;
        const selected = context(
          route === Route.Review || route === Route.ReviewStatus ? {} : query,
          url.pathname + url.search,
          query,
        );
        const renderStarted = performance.now();
        let page: string;
        switch (route) {
          case Route.NewCharter:
            page = newCharterPage(selected, query.project ?? "");
            break;
          case Route.Overview:
            page = overview(selected);
            break;
          case Route.TaskQueue:
            page = taskQueuePage(selected);
            break;
          case Route.Records:
            page = recordsPage(selected, query);
            break;
          case Route.Record:
            page = recordPage(selected, query);
            break;
          case Route.ReviewStatus: {
            if (query.compatibility) {
              if (query.id || query.path) throw new WebError(400, "Select compatibility or a document review");
              const assessment = selected.compatibility.report?.assessment;
              send(
                response,
                200,
                "application/json",
                JSON.stringify({
                  policy_digest: assessment?.policy_digest ?? null,
                  findings: selected.pendingCompatibilityFindings.map((finding) => finding.id),
                }),
              );
              return;
            }
            if (query.id && query.path) throw new WebError(400, "select a record or a file, not both");
            const path = query.id ? selected.index.reviewGroupById.get(query.id)?.path : query.path;
            const owner = path ? selected.index.reviewOwnerPath(path) : undefined;
            const group = selected.reviewGroups.find((group) => group.path === owner);
            send(
              response,
              200,
              "application/json",
              JSON.stringify({ versions: (group?.changes ?? []).map(({ path, digest }) => ({ path, digest })) }),
            );
            return;
          }
          case Route.Review: {
            if (query.compatibility) {
              if (query.id || query.path) throw new WebError(400, "Select compatibility or a document review");
              page = compatibilityReviewPage(selected);
              break;
            }
            const application = query.collection_applied ? actions.application(query.collection_applied) : undefined;
            if (application) selected.collectionApplication = application;
            const prepared = prepareReviewPage(selected, query);
            let formatting;
            try {
              formatting = workspaceFormattingProposal(selected.index.snapshot, prepared?.owner);
            } catch (error) {
              if (!(error instanceof FormattingProblem)) throw error;
              const record = selected.records.find((record) => record.path === error.path && record.editable);
              throw new WebError(409, error.message, {
                cause: error,
                recovery: {
                  href: record ? recordURL(record.id, { view: "edit" }) : url.pathname + url.search,
                  label: record ? "Edit record" : "Refresh review",
                },
              });
            }
            page = formatting.files.length
              ? reviewFormattingPage(selected, formatting, prepared?.owner ?? "")
              : reviewPage(selected, query, prepared);
            actions.reviews.retainBatch(
              formatting.files.length ? [] : (prepared?.presentations ?? []),
              selected.index.snapshot.review.head,
            );
            break;
          }
          case Route.Collections:
            page = collectionsPage(selected);
            break;
          case Route.Proposal: {
            const token = query.token ?? "",
              saved = actions.proposal(token);
            page = collectionProposalPage(selected, token, saved.request, saved.plan);
            break;
          }
          case Route.TaskState:
          case Route.FormatReview:
          case Route.QueueChange:
          case Route.Approve:
          case Route.PolicyResolution:
          case Route.CreateCharter:
          case Route.Apply:
          case Route.Preview:
          case Route.Save:
          case Route.WorkspaceRetry:
          case Route.Caches:
          case Route.CacheKeep:
          case Route.CachePrepare:
          case Route.CacheUnused:
          case Route.Cleanup:
          case Route.CleanupApply:
          case Route.Demonstration:
          case Route.Inventory:
          case Route.Projects:
          case Route.ProjectAdd:
          case Route.ProjectRemove:
            send(response, 404, "text/plain; charset=utf-8", "View not found.");
            return;
        }
        timings.record("render", performance.now() - renderStarted);
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
      if (form.get("csrf") !== csrf) throw new WebError(403, "invalid browser review session; refresh this page");
      if (route === Route.WorkspaceRetry) {
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
      const reviewContext = route === Route.Approve ? monitor.index?.select({}) : undefined;
      const selectedId = form.get("id") ?? form.get("reference") ?? "",
        selectedPath = form.get("path") ?? "";
      const target =
        (operation === WebAction.Save || operation === WebAction.Task) && monitor.index?.byId.has(selectedId)
          ? selectedId
          : operation === WebAction.Review && monitor.index?.reviewByPath.has(selectedPath)
            ? selectedPath
            : operation === WebAction.Preview || operation === WebAction.Apply
              ? "collection"
              : operation === WebAction.PolicyResolution
                ? "policy-compatibility"
                : operation === WebAction.Queue
                  ? "task-queue"
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
        const remaining = context.reviewGroups.find((group) =>
          group.changes.some((change) => change.path === selectedPath && !change.approved),
        );
        const next = remaining ?? reviewNavigation(context, form.get("digest") ?? "").nextPending;
        if (next)
          result.redirect = reviewLocation(context, next, form.get("review_layout") === "split" ? "split" : "unified");
      }
      if (operation === WebAction.PolicyResolution && monitor.index) {
        const current = monitor.index.select({});
        if (!current.pendingCompatibilityFindings.length)
          result.redirect = current.reviewQueue[0] ? reviewLocation(current, current.reviewQueue[0]) : Route.Review;
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
      const { status, message: publicMessage, recovery } = errorResponse(error, requestId);
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
        send(
          response,
          status,
          "application/json",
          JSON.stringify({ error: publicMessage, requestId, ...(recovery ? { recovery } : {}) }),
        );
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
              context({ id: form.get("id") ?? "" }),
              { id: form.get("id") ?? "", view: "edit" },
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
      send(response, status, "text/html; charset=utf-8", requestUnavailablePage(publicMessage, recovery));
    }
  };
  const server = createLocalServer(handle, metrics);
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
    if (options.listen !== false) await listenLocal(server, host, port);
  } catch (error) {
    clearInterval(heartbeat);
    await settleCleanup([() => monitor.close(), () => generation?.close()], error);
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
        () => closeLocalServer(server),
        () => {
          generation?.close();
        },
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
    activeCollections: () => actions.activeCollections,
    handle,
    url: `http://${host === "::1" ? "[::1]" : host}:${String(publishedPort)}`,
    close,
  };
}
