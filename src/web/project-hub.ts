import { knownRoute, routeContracts, decodeRoute, routeOperation, Route } from "./routes.js";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel, settleCleanup } from "../diagnostics.js";
import { registeredProjectName } from "../project-registration.js";
import { registeredProjects, type RegisteredProject } from "../project-registry.js";
import { browserScript, stylesheet } from "./assets.js";
import type { CacheProgress } from "./cache-inventory.js";
import { CacheTasks, type CacheTask } from "./cache-worker.js";
import { startDemonstrationService } from "./demo-service.js";
import { errorResponse } from "./error-response.js";
import { WebError } from "./errors.js";
import { readForm, requestOrigin, secureResponse, send } from "./http.js";
import { HubLifecycle, ProjectViews } from "./hub-lifecycle.js";
import {
  cleanupPage,
  hubErrorPage,
  inventoryContent,
  inventoryPresentation,
  inventoryPatch,
  hubLayout as layout,
  projectDashboard,
} from "./hub-pages.js";
import { InventoryService, type InventoryView } from "./inventory-service.js";
import { WebMetrics } from "./observability.js";

interface Pending {
  expires: number;
  task: CacheTask;
  title: string;
  items: string[];
  bytes: number | undefined;
}
/** A multi-project service resolves checkout preferences for each selected project, not its launcher's build session. */
export function projectHubEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  const scopedStorage = Boolean(environment.WORKBENCH_STORAGE_PROJECT);
  for (const name of [
    "WORKBENCH_PROJECT_ROOT",
    "WORKBENCH_LOCAL_CONFIG_ROOT",
    "WORKBENCH_EPHEMERAL_CHECKOUT",
    "WORKBENCH_CONTAINER_CHECKOUT",
    "WORKBENCH_STORAGE_PROJECT",
    "WORKBENCH_BUILD_DIR",
    "WORKBENCH_DEPENDENCIES_DIR",
    "WORKBENCH_DIST_DIR",
    "WORKBENCH_TOOLCHAIN",
    "WORKBENCH_TOOLCHAIN_ROOT",
    "WORKBENCH_PROFILE_CONTEXT",
    "WORKBENCH_WORKSPACE_CONTEXT",
    "WORKBENCH_POLICY_REVIEW",
    "WORKBENCH_COLLECTIONS_MATERIALIZED",
    "WORKBENCH_CI_TARGET",
    "WORKBENCH_CI_TARGETS",
  ])
    Reflect.deleteProperty(result, name);
  if (scopedStorage)
    for (const name of ["WORKBENCH_STORAGE_ROOT", "WORKBENCH_STORAGE_EXTERNAL"]) Reflect.deleteProperty(result, name);
  return result;
}
export async function startProjectHub(
  distribution: string,
  options: { host?: "127.0.0.1" | "::1"; port?: number; demo?: boolean } = {},
) {
  const host = options.host ?? "127.0.0.1",
    port = options.port ?? 8080;
  if (!["127.0.0.1", "::1"].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Select a loopback host and a valid port");
  const csrf = randomBytes(32).toString("hex");
  const metrics = new WebMetrics();
  let tasks = new CacheTasks(distribution);
  const views = new ProjectViews(),
    lifecycle = new HubLifecycle();
  const demoCancellation = new AbortController();
  const pending = new Map<string, Pending>();
  const inventories = new InventoryService(() => tasks);
  const inventory = (fresh = false) => inventories.read(fresh);
  const currentProjects = (data: InventoryView): RegisteredProject[] => {
    try {
      return registeredProjects().map((project) => ({ ...project, name: registeredProjectName(project) }));
    } catch (error) {
      data.issues = [
        ...data.issues,
        {
          component: "registry",
          phase: "discovery",
          message: error instanceof Error ? error.message : String(error),
        },
      ];
      return data.projects;
    }
  };
  const invalidate = () => {
    inventories.invalidate();
  };
  let demo: Awaited<ReturnType<typeof startDemonstrationService>> | undefined;
  const clients = new Set<ServerResponse>();
  let revision = 0;
  const broadcast = (event?: CacheProgress) => {
    revision++;
    for (const response of clients) {
      if (response.writableLength > 65536) {
        response.destroy();
        clients.delete(response);
        metrics.count("slowClientDisconnects");
      } else {
        try {
          response.write(
            event?.kind === "size"
              ? `event: size\ndata: ${JSON.stringify(event.size)}\n\n`
              : `event: inventory\ndata: ${String(revision)}\n\n`,
          );
        } catch {
          response.destroy();
          clients.delete(response);
          metrics.count("streamFailures");
        }
      }
    }
  };
  const unsubscribe = inventories.onChange(broadcast);
  const heartbeat = setInterval(() => {
    for (const response of clients) {
      if (response.writableLength > 65536) {
        response.destroy();
        clients.delete(response);
        metrics.count("slowClientDisconnects");
      } else response.write(": heartbeat\n\n");
    }
    if (clients.size && !demo && !lifecycle.closing) void inventory().catch(() => undefined);
  }, 15000);
  heartbeat.unref();
  const prepare = (proposal: Omit<Pending, "expires">) => {
    for (const [token, value] of pending) if (value.expires < Date.now()) pending.delete(token);
    if (pending.size >= 16)
      throw new WebError(503, "Too many pending cleanup plans; finish one before preparing another");
    const token = randomBytes(24).toString("hex");
    pending.set(token, { ...proposal, expires: Date.now() + 5 * 60 * 1000 });
    return token;
  };
  const startDemo = async () => {
    try {
      await settleCleanup([() => tasks.close(), () => views.close()]);
      demo = await startDemonstrationService(distribution, demoCancellation.signal);
      inventories.close();
      for (const response of clients) response.end();
      clients.clear();
      pending.clear();
    } catch (error) {
      if (!lifecycle.closing) {
        tasks = new CacheTasks(distribution);
        views.reopen();
        invalidate();
      }
      throw error;
    }
  };
  const redirect = (response: ServerResponse, path: string) => {
    response.writeHead(303, { location: path });
    response.end();
  };
  const handler = async (request: import("node:http").IncomingMessage, response: ServerResponse) => {
    secureResponse(response);
    const requestId = metrics.request(request, response, (request.url ?? "").replace(/^\/p\/[a-f0-9]{24}(?=\/|$)/, ""));
    let mutation = false;
    let admission: ReturnType<HubLifecycle["admit"]> | undefined;
    let releaseMutation: (() => void) | undefined;
    let operation = "unknown";
    try {
      admission = lifecycle.admit();
      const origin = requestOrigin(request);
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin) throw new WebError(400, "Request URL is outside this service");
      if (demo) {
        await demo.handle(request, response);
        return;
      }
      const route = knownRoute(url.pathname);
      if (route !== "unknown") {
        const contract = routeContracts[route];
        if (!contract.methods.includes(request.method ?? "")) {
          response.setHeader("allow", contract.methods.join(", "));
          send(response, 405, "text/plain", "Method not allowed.");
          return;
        }
      }
      const decoded = route === "unknown" ? undefined : decodeRoute(route, url.searchParams);
      if (url.pathname === Route.Style) {
        send(response, 200, "text/css", stylesheet);
        return;
      }
      if (url.pathname === Route.Client) {
        send(response, 200, "text/javascript", browserScript);
        return;
      }
      if (request.method === "GET" && url.pathname === Route.Metrics) {
        send(
          response,
          200,
          "application/json",
          JSON.stringify(
            metrics.snapshot({
              collectedAt: inventories.collectedAt,
              refreshing: inventories.refreshing,
              watchers: await views.watchers(),
              collectionsActive: await views.activeCollections(),
            }),
          ),
        );
        return;
      }
      const selected = /^\/p\/([a-f0-9]{24})(\/.*)?$/.exec(url.pathname);
      if (selected) {
        const project = registeredProjects().find((entry) => entry.id === selected[1]);
        if (!project || !existsSync(project.path)) {
          send(response, 404, "text/plain", "Registered project is unavailable");
          return;
        }
        const application = await views.use(project, response);
        const original = request.url;
        request.url = (selected[2] ?? "/") + url.search;
        try {
          await application.handle(request, response);
        } finally {
          request.url = original;
        }
        return;
      }
      if (request.method === "GET" && url.pathname === Route.Events) {
        if (clients.size >= 32) throw new WebError(503, "Too many inventory event connections");
        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        clients.add(response);
        response.once("close", () => clients.delete(response));
        response.write(`event: inventory\ndata: ${String(revision)}\n\n`);
        void inventory();
        return;
      }
      if (request.method === "GET" && decoded?.route === Route.Inventory) {
        const query = decoded.query;
        const data = await inventory();
        const projects = currentProjects(data);
        const view = query.view === "caches" ? "caches" : "projects";
        const owner = projects.find((entry) => entry.id === query.project)?.path ?? query.owner;
        const body = JSON.stringify(inventoryPatch(inventoryPresentation(data, projects, csrf, view, owner)));
        if (Buffer.byteLength(body) > 16 * 1024 * 1024)
          throw new WebError(413, "Inventory response is too large; use the cache CLI");
        send(response, 200, "application/json", body);
        return;
      }
      if (request.method === "POST") {
        const form = await readForm(request);
        if (form.get("csrf") !== csrf) {
          send(response, 403, "text/plain", "Invalid browser session; reload this page");
          return;
        }
        const proposed = pending.get(form.get("token") ?? "")?.task;
        const resource =
          url.pathname === Route.Demonstration
            ? "transition"
            : proposed?.kind === "apply"
              ? `project:${proposed.plan.project}`
              : url.pathname === Route.CacheKeep
                ? `asset:${form.get("identity") ?? ""}`
                : url.pathname === Route.ProjectAdd
                  ? "registry"
                  : `action:${url.pathname}:${form.get("project") ?? form.get("unlisted") ?? ""}`;
        releaseMutation = lifecycle.claim(resource);
        mutation = true;
        operation = routeOperation(url.pathname);
        diagnostic(LogLevel.Info, DiagnosticOperation.WebAction, DiagnosticOutcome.Requested, { requestId, operation });
        if (url.pathname === Route.ProjectAdd) {
          await tasks.run({ kind: "register", path: form.get("path") ?? "" });
          invalidate();
          redirect(response, "/projects");
          return;
        }
        if (url.pathname === Route.Demonstration) {
          await lifecycle.transition(admission, startDemo);
          redirect(response, "/");
          return;
        }
        if (url.pathname === Route.CacheKeep) {
          const current = await inventory(true),
            identity = form.get("identity") ?? "";
          if (
            ![
              ...current.inventory.entries.map((entry) => entry.directory),
              ...(current.inventory.tools?.entries ?? []).map((entry) => entry.directory),
            ].includes(identity)
          )
            throw new WebError(409, "Cache asset changed; refresh the inventory");
          await tasks.run({ kind: "keep", identity, keep: form.get("keep") === "yes" });
          invalidate();
          redirect(response, "/caches");
          return;
        }
        if (url.pathname === Route.CachePrepare || url.pathname === Route.ProjectRemove) {
          const project = registeredProjects().find((entry) => entry.id === form.get("project"));
          const path = project?.path ?? form.get("unlisted") ?? "";
          if (!path) throw new WebError(400, "Choose a project");
          if (url.pathname === Route.ProjectRemove && !project) throw new WebError(404, "Registered project not found");
          if (!project && !(await inventory(true)).inventory.entries.some((entry) => entry.identity.checkout === path))
            throw new WebError(404, "Unlisted cache owner is not in the inventory");
          const plan = await tasks.run({ kind: "project", path, root: form.get("root") ?? "" });
          const remove = url.pathname === Route.ProjectRemove;
          const token = prepare({
            task: { kind: "apply", plan, remove },
            title: remove ? `Remove ${project?.name ?? path}` : "Clear project caches",
            bytes: plan.bytes,
            items: [
              ...plan.reports.flatMap((report) =>
                report.entries.map(
                  (entry) => `${entry.directory}${entry.blockedBy ? ` · protected: ${entry.blockedBy}` : ""}`,
                ),
              ),
              ...plan.reports.flatMap((report) => [
                ...(report.builders?.entries ?? []).map((entry) => `Builder ${entry.key}`),
                ...(report.images?.entries ?? []).map((entry) => `Image ${entry.reference}`),
              ]),
              ...plan.blocked.map((entry) => `Protected: ${entry}`),
            ],
          });
          redirect(response, `/cleanup?token=${token}`);
          return;
        }
        if (url.pathname === Route.CacheUnused) {
          const plan = await tasks.run({ kind: "assets" });
          const token = prepare({
            task: { kind: "assets", digest: plan.digest },
            title: "Prune unused shared assets",
            bytes: plan.bytes,
            items: plan.entries.map((entry) => `${entry.tool} ${entry.version} · ${entry.directory}`),
          });
          redirect(response, `/cleanup?token=${token}`);
          return;
        }
        if (url.pathname === Route.CleanupApply) {
          const token = form.get("token") ?? "",
            proposal = pending.get(token);
          if (!proposal || proposal.expires < Date.now())
            throw new WebError(409, "Cleanup plan expired; prepare a new preview");
          if (form.get("reviewed") !== "yes") throw new WebError(400, "Confirm the reviewed cleanup plan");
          pending.delete(token);
          let releaseView: (() => void) | undefined;
          if (proposal.task.kind === "apply" && proposal.task.remove) {
            const selectedProject = registeredProjects().find(
              (entry) => proposal.task.kind === "apply" && entry.path === proposal.task.plan.project,
            );
            if (selectedProject) releaseView = await views.remove(selectedProject.id);
          }
          try {
            await tasks.run(proposal.task);
          } finally {
            releaseView?.();
          }
          invalidate();
          redirect(response, "/projects");
          return;
        }
        send(response, 404, "text/plain", "Action not found");
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("allow", "GET, POST");
        send(response, 405, "text/plain", "Method not allowed");
        return;
      }
      if (decoded?.route === Route.Cleanup) {
        const query = decoded.query;
        const token = query.token ?? "",
          proposal = pending.get(token);
        if (!proposal || proposal.expires < Date.now())
          throw new WebError(409, "Cleanup plan expired; prepare a new preview");
        send(response, 200, "text/html", cleanupPage(proposal, csrf, token));
        return;
      }
      const query = decoded?.route === Route.Caches || decoded?.route === Route.Projects ? decoded.query : {};
      const priority =
        decoded?.route === Route.Caches
          ? (registeredProjects().find((project) => project.id === decoded.query.project)?.path ??
            decoded.query.owner ??
            undefined)
          : undefined;
      const data = await inventories.read(query.refresh !== undefined, query["refresh-sizes"] !== undefined, priority);
      const projects = currentProjects(data);
      if (url.pathname === Route.Overview || url.pathname === Route.Projects) {
        send(response, 200, "text/html", projectDashboard(data, projects, csrf));
        return;
      }
      if (decoded?.route === Route.Caches) {
        const query = decoded.query;
        const owner = projects.find((entry) => entry.id === query.project)?.path ?? query.owner;
        send(
          response,
          200,
          "text/html",
          layout("Caches", inventoryContent(inventoryPresentation(data, projects, csrf, "caches", owner))),
        );
        return;
      }
      send(response, 404, "text/plain", "Page not found");
    } catch (error) {
      if (mutation) metrics.count("actionFailures");
      if (mutation)
        diagnostic(
          LogLevel.Warn,
          DiagnosticOperation.WebAction,
          DiagnosticOutcome.Unconfirmed,
          { requestId, operation },
          error,
        );
      const { status, message: publicMessage } = errorResponse(error, requestId);
      diagnostic(
        status >= 500 ? LogLevel.Error : LogLevel.Warn,
        DiagnosticOperation.WebRequest,
        DiagnosticOutcome.Failed,
        { requestId, status },
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
      send(response, status, "text/html", hubErrorPage(publicMessage));
    } finally {
      try {
        if (mutation) {
          releaseMutation?.();
          if (response.statusCode < 400 && response.headersSent) {
            metrics.count(operation.endsWith(".preview") ? "previewsPrepared" : "mutationsApplied");
            diagnostic(LogLevel.Info, DiagnosticOperation.WebAction, DiagnosticOutcome.Completed, {
              requestId,
              operation,
            });
          }
        }
      } finally {
        admission?.release();
      }
    }
  };
  try {
    if (options.demo) await lifecycle.transition(undefined, startDemo);
  } catch (error) {
    lifecycle.stop();
    clearInterval(heartbeat);
    unsubscribe();
    inventories.close();
    await settleCleanup([() => tasks.close(), () => views.close(), () => demo?.close()], error);
    throw error;
  }
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => response.destroy());
  });
  server.maxConnections = 64;
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.maxHeadersCount = 50;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(heartbeat);
    await settleCleanup([() => tasks.close(), () => views.close(), () => demo?.close()], error);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Listener did not publish its address");
  let closed: Promise<void> | undefined;
  const close = () => {
    closed ??= (async () => {
      lifecycle.stop();
      demoCancellation.abort();
      clearInterval(heartbeat);
      unsubscribe();
      inventories.close();
      await settleCleanup([
        () => {
          tasks.cancelPending();
        },
        () => views.close(),
        () => lifecycle.finishTransition(),
        () => demo?.close(),
        () => {
          for (const response of clients) response.end();
          clients.clear();
        },
        () => lifecycle.drain(),
        () => tasks.close(),
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
            server.closeIdleConnections();
          }),
      ]);
    })();
    return closed;
  };
  return {
    server,
    close,
    demonstration: () => (demo ? { root: demo.root, source: demo.source } : undefined),
    url: `http://${host === "::1" ? "[::1]" : host}:${String(address.port)}`,
  };
}
