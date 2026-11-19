import { routeURL } from "../routes/locations.js";
import { projectMount, demonstrationBase } from "./project-mounts.js";
import {
  localEndpoint,
  createLocalServer,
  listenPrivate,
  listenUnix,
  closeLocalServer,
} from "../http/http-listener.js";
import { WorkerGeneration } from "../workspace/worker-generation.js";
import { knownRoute, routeContracts, decodeRoute, routeOperation, Route } from "../routes/routes.js";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Server as HttpServer, ServerResponse } from "node:http";
import type { Server as NetServer } from "node:net";
import {
  diagnostic,
  DiagnosticOperation,
  DiagnosticOutcome,
  LogLevel,
  settleCleanup,
} from "../../core/diagnostics/diagnostics.mjs";
import { userConfigValues } from "../../core/configuration/user-config.js";
import { registeredProjects, projectRegistrySnapshot } from "../../core/projects/project-registry.js";
import { serveAsset } from "../http/asset-response.js";
import type { CacheProgress } from "../cache/cache-inventory.js";
import { CacheTasks, type CacheTask } from "../cache/cache-worker.js";
import { startDemonstrationService } from "./demo-service.js";
import { errorResponse, isCanceledRead } from "../http/error-response.js";
import { WebError } from "../http/errors.js";
import { readForm, requestOrigin, secureResponse, send } from "../http/http.js";
import { HubLifecycle, ProjectViews } from "./hub-lifecycle.js";
import { ProjectReviews } from "./project-reviews.js";
import { ProjectDirectory, availableProjects, type ProjectDirectoryView } from "./project-directory.js";
import { cacheMeasurement, ProjectCacheSizes } from "../cache/cache-view-model.js";
import {
  cleanupPage,
  hubErrorPage,
  inventoryContent,
  inventoryPresentation,
  inventoryPatch,
  hubLayout as layout,
  projectDashboard,
} from "../views/hub-pages.js";
import { InventoryService, type InventoryView } from "../cache/inventory-service.js";
import { WebMetrics } from "../http/observability.js";
import { authorizationCheck, createPrivateBrowserAuthentication } from "../http/browser-auth.js";

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
  options: {
    host?: "127.0.0.1" | "::1";
    port?: number;
    demo?: boolean;
    worker?: { socket: string; token: string; transport?: (server: HttpServer) => NetServer };
  } = {},
) {
  const preferences = userConfigValues();
  const { host, port } = localEndpoint({
    ...options,
    port: options.port ?? Number(preferences["daemon.private_port"]),
  });
  const authentication = createPrivateBrowserAuthentication();
  const authorized = options.worker ? authorizationCheck(`Bearer ${options.worker.token}`) : authentication.accepts;
  const csrf = randomBytes(32).toString("hex");
  const metrics = new WebMetrics();
  const generation = new WorkerGeneration(distribution);
  const tasks = new CacheTasks(distribution, undefined, generation.path);
  const views = new ProjectViews(
      16,
      generation.path,
      (project, index) => {
        reviews.observe(project, index);
      },
      Number(preferences["server.project_idle_seconds"]) * 1000,
    ),
    lifecycle = new HubLifecycle();
  const demoCancellation = new AbortController();
  const pending = new Map<string, Pending>();
  const inventories = new InventoryService(() => tasks, metrics);
  const inventory = (fresh = false) => inventories.read(fresh);
  const directory = new ProjectDirectory(generation.path);
  const currentProjects = async (data: InventoryView): Promise<ProjectDirectoryView> => {
    const started = performance.now();
    try {
      return await directory.read();
    } catch (error) {
      data.issues = [
        ...data.issues,
        {
          component: "registry",
          phase: "discovery",
          message: error instanceof Error ? error.message : String(error),
        },
      ];
      return {
        projects: data.projects,
        groups: data.projects.map((project) => ({ project, worktrees: [] })),
        available: [],
      };
    } finally {
      metrics.phase("projectDirectory", performance.now() - started);
    }
  };
  const invalidate = () => {
    inventories.invalidate();
  };
  let demo: Awaited<ReturnType<typeof startDemonstrationService>> | undefined;
  let demoStarting: Promise<Awaited<ReturnType<typeof startDemonstrationService>>> | undefined;
  const clients = new Set<ServerResponse>();
  let revision = 0;
  const emit = (message: string) => {
    revision++;
    for (const response of clients) {
      if (response.writableLength > 65536) {
        response.destroy();
        clients.delete(response);
        metrics.count("slowClientDisconnects");
      } else {
        try {
          response.write(message);
        } catch {
          response.destroy();
          clients.delete(response);
          metrics.count("streamFailures");
        }
      }
    }
  };
  let projectSizes: ProjectCacheSizes | undefined;
  const broadcast = (event?: CacheProgress) => {
    if (event?.kind !== "size") {
      projectSizes = undefined;
      emit(`event: inventory\ndata: ${String(revision)}\n\n`);
      return;
    }
    if (!clients.size) return;
    emit(`event: size\ndata: ${JSON.stringify(cacheMeasurement(event.size))}\n\n`);
    projectSizes ??= new ProjectCacheSizes(inventories.view());
    for (const update of projectSizes.update(event.size))
      emit(`event: project-size\ndata: ${JSON.stringify({ ...update, revision: revision + 1 })}\n\n`);
  };
  const unsubscribe = inventories.onChange(broadcast);
  const reviews = new ProjectReviews(
    generation.path,
    (id, value) => {
      emit(
        `event: reviews\ndata: ${JSON.stringify({ id, count: value.count, problem: value.problem, revision: value.revision ?? 0 })}\n\n`,
      );
    },
    undefined,
    metrics,
  );
  const heartbeat = setInterval(() => {
    for (const response of clients) {
      if (response.writableLength > 65536) {
        response.destroy();
        clients.delete(response);
        metrics.count("slowClientDisconnects");
      } else response.write(": heartbeat\n\n");
    }
    if (clients.size && !lifecycle.closing) {
      void inventory().catch(() => undefined);
      void directory
        .read()
        .then((metadata) => {
          reviews.read(availableProjects(metadata));
        })
        .catch((error: unknown) => {
          diagnostic(
            LogLevel.Warn,
            DiagnosticOperation.WorkspaceRefresh,
            DiagnosticOutcome.Failed,
            { operation: "project review summaries" },
            error,
          );
        });
    }
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
    if (demo) {
      if (!demo.available) await demo.restart();
      return demo;
    }
    demoStarting ??= startDemonstrationService(distribution, demoCancellation.signal, generation.path);
    try {
      demo = await demoStarting;
      return demo;
    } finally {
      demoStarting = undefined;
    }
  };
  const redirect = (response: ServerResponse, path: string) => {
    response.writeHead(303, { location: path });
    response.end();
  };
  const handler = async (request: import("node:http").IncomingMessage, response: ServerResponse) => {
    secureResponse(response);
    const requestId = metrics.request(
      request,
      response,
      projectMount(new URL(request.url ?? "/", "http://workbench.invalid").pathname)?.path ?? request.url ?? "",
    );
    let mutation = false;
    let admission: ReturnType<HubLifecycle["admit"]> | undefined;
    let releaseMutation: (() => void) | undefined;
    let operation = "unknown";
    try {
      admission = lifecycle.admit();
      const origin = requestOrigin(request);
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin) throw new WebError(400, "Request URL is outside this service");
      if (!authorized(request.headers.authorization)) {
        if (options.worker) throw new WebError(403, "Worker connection is unauthorized");
        response.setHeader("www-authenticate", 'Basic realm="Workbench", charset="UTF-8"');
        send(response, 401, "text/plain", "Enter the sign-in credential printed by workbench serve.\n");
        return;
      }
      Reflect.deleteProperty(request.headers, "authorization");
      if (url.pathname === demonstrationBase && request.method === "GET") {
        redirect(response, demonstrationBase + "/");
        return;
      }
      if (url.pathname.startsWith(demonstrationBase + "/")) {
        const application = await startDemo();
        const original = request.url;
        request.url = url.pathname.slice(demonstrationBase.length) + url.search;
        try {
          await application.handle(request, response);
        } finally {
          request.url = original;
        }
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
      if (decoded?.route === Route.Style || decoded?.route === Route.Client || decoded?.route === Route.Diagrams) {
        await serveAsset(
          request,
          response,
          route === Route.Style ? "style" : route === Route.Client ? "client" : "diagrams",
          decoded.query.v,
        );
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
              watchers: (await views.watchers()) + inventories.watcherCount,
              collectionsActive: await views.activeCollections(),
            }),
          ),
        );
        return;
      }
      const selected = projectMount(url.pathname);
      if (selected) {
        const metadata = await directory.read();
        const project = metadata.projects.find((entry) => entry.id === selected.id);
        if (!project || !metadata.available.includes(project.path)) {
          send(response, 404, "text/plain", "Registered project is unavailable");
          return;
        }
        const application = await views.use(project, response);
        const original = request.url;
        request.url = selected.path + url.search;
        try {
          await application.handle(request, response);
        } finally {
          request.url = original;
          if (request.method === "POST") reviews.invalidate(project.id);
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
        const observedRevision = revision;
        const metadata = await currentProjects(data),
          projects = metadata.projects;
        const view = query.view === "caches" ? "caches" : "projects";
        const owner = projects.find((entry) => entry.id === query.project)?.path ?? query.owner;
        const body = JSON.stringify({
          ...inventoryPatch(
            inventoryPresentation(
              data,
              projects,
              csrf,
              view,
              owner,
              reviews.read(availableProjects(metadata)),
              metadata,
              {
                ...(query.section ? { section: query.section } : {}),
                ...(query.offset === undefined ? {} : { offset: query.offset }),
              },
            ),
          ),
          revision: observedRevision,
        });
        if (Buffer.byteLength(body) > 16 * 1024 * 1024)
          throw new WebError(413, "Inventory response is too large; use the cache CLI");
        send(response, 200, "application/json", body);
        return;
      }
      if (request.method === "POST") {
        const form = await readForm(request);
        if (form.get("csrf") !== csrf) {
          send(response, 403, "text/plain", "Invalid browser session; refresh this page");
          return;
        }
        const proposed = pending.get(form.get("token") ?? "")?.task;
        const resource =
          url.pathname === Route.Demonstration
            ? "demonstration"
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
          await startDemo();
          redirect(response, demonstrationBase + "/");
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
        if (url.pathname === Route.CacheRecover) {
          const { entry } = await tasks.run({ kind: "recover", directory: form.get("directory") ?? "" });
          if (entry.state === "active") throw new WebError(409, "Cache operation is active");
          const token = prepare({
            task: { kind: "recover", directory: entry.directory, digest: entry.digest },
            title: entry.state === "uncertain" ? "Delete uncertain cache files" : "Finish interrupted cache cleanup",
            bytes: entry.bytes,
            items: [
              entry.directory,
              ...(entry.target ? [`Destination: ${entry.target}`] : []),
              ...(entry.problem ? [entry.problem] : []),
            ],
          });
          redirect(response, `/cleanup?token=${token}`);
          return;
        }
        if (url.pathname === Route.CleanupApply) {
          const token = form.get("token") ?? "",
            proposal = pending.get(token);
          if (!proposal || proposal.expires < Date.now())
            throw new WebError(409, "Cleanup plan expired; prepare a new preview", {
              recovery: { href: routeURL(Route.Caches, {}), label: "Return to caches" },
            });
          if (form.get("reviewed") !== "yes") throw new WebError(400, "Confirm the reviewed cleanup plan");
          pending.delete(token);
          let releaseView: (() => void) | undefined;
          if (proposal.task.kind === "apply" && proposal.task.remove) {
            const selectedProject = projectRegistrySnapshot().atPath(proposal.task.plan.project);
            if (selectedProject) releaseView = await views.remove(selectedProject.id);
          }
          try {
            await tasks.run(proposal.task);
          } finally {
            releaseView?.();
            invalidate();
            const priority = proposal.task.kind === "apply" ? proposal.task.plan.project : undefined;
            void inventories.read(true, false, priority).catch(() => undefined);
          }
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
          throw new WebError(409, "Cleanup plan expired; prepare a new preview", {
            recovery: { href: routeURL(Route.Caches, {}), label: "Return to caches" },
          });
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
      const metadata = await currentProjects(data),
        projects = metadata.projects;
      if (url.pathname === Route.Charters || url.pathname === Route.Projects) {
        send(
          response,
          200,
          "text/html",
          projectDashboard(data, projects, csrf, reviews.read(availableProjects(metadata)), metadata, !!options.worker),
        );
        return;
      }
      if (decoded?.route === Route.Caches) {
        const query = decoded.query;
        const owner = projects.find((entry) => entry.id === query.project)?.path ?? query.owner;
        send(
          response,
          200,
          "text/html",
          layout(
            "Caches",
            inventoryContent(
              inventoryPresentation(data, projects, csrf, "caches", owner, undefined, metadata, {
                ...(query.section ? { section: query.section } : {}),
                ...(query.offset === undefined ? {} : { offset: query.offset }),
              }),
            ),
            {
              active: "caches",
            },
          ),
        );
        return;
      }
      send(response, 404, "text/plain", "Page not found");
    } catch (error) {
      if (isCanceledRead(error, request, response)) return;
      if (mutation) metrics.count("actionFailures");
      if (mutation)
        diagnostic(
          LogLevel.Warn,
          DiagnosticOperation.WebAction,
          DiagnosticOutcome.Unconfirmed,
          { requestId, operation },
          error,
        );
      const { status, message: publicMessage, recovery } = errorResponse(error, requestId);
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
        send(
          response,
          status,
          "application/json",
          JSON.stringify({ error: publicMessage, requestId, ...(recovery ? { recovery } : {}) }),
        );
        return;
      }
      send(response, status, "text/html", hubErrorPage(publicMessage, recovery));
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
    if (options.demo) await startDemo();
  } catch (error) {
    lifecycle.stop();
    clearInterval(heartbeat);
    unsubscribe();
    inventories.close();
    await settleCleanup(
      [
        () => tasks.close(),
        () => reviews.close(),
        () => directory.close(),
        () => views.close(),
        () => demo?.close(),
        () => {
          generation.close();
        },
      ],
      error,
    );
    throw error;
  }
  const server = createLocalServer(handler, metrics);
  const transport = options.worker?.transport?.(server) ?? server;
  try {
    if (options.worker) await listenUnix(transport, options.worker.socket);
    else await listenPrivate(server, host, port);
  } catch (error) {
    lifecycle.stop();
    clearInterval(heartbeat);
    unsubscribe();
    inventories.close();
    await settleCleanup(
      [
        () => tasks.close(),
        () => reviews.close(),
        () => directory.close(),
        () => views.close(),
        () => demo?.close(),
        () => {
          generation.close();
        },
      ],
      error,
    );
    throw error;
  }
  const address = transport.address();
  if (!address) throw new Error("Listener did not publish its address");
  let closed: Promise<void> | undefined;
  const close = () => {
    closed ??= (async () => {
      lifecycle.stop();
      demoCancellation.abort();
      clearInterval(heartbeat);
      unsubscribe();
      inventories.close();
      const phases = [
        [
          "cache admission",
          () => {
            tasks.cancelPending();
          },
        ],
        ["review summaries", () => reviews.close()],
        ["project directory", () => directory.close()],
        ["project views", () => views.close()],
        ["demonstration", () => demo?.close()],
        [
          "event streams",
          () => {
            for (const response of clients) response.end();
            clients.clear();
          },
        ],
        ["admitted requests", () => lifecycle.drain()],
        ["cache workers", () => tasks.close()],
        [
          "browser transport",
          async () => {
            if (transport === server) await closeLocalServer(server);
            else {
              server.closeAllConnections();
              await new Promise<void>((resolve, reject) => {
                transport.close((error) => {
                  if (error) reject(error);
                  else resolve();
                });
              });
            }
          },
        ],
        [
          "worker generation",
          () => {
            generation.close();
          },
        ],
      ] as const;
      await settleCleanup(
        phases.map(([component, close]) => async () => {
          await close();
          if (options.worker)
            diagnostic(LogLevel.Info, DiagnosticOperation.WebService, DiagnosticOutcome.Stopped, { component });
        }),
      );
    })();
    return closed;
  };
  return {
    server: transport,
    close,
    signIn: { username: authentication.username, password: authentication.password },
    demonstration: () => (demo ? { root: demo.root, source: demo.source } : undefined),
    url:
      typeof address === "string"
        ? address
        : new URL(
            options.demo ? demonstrationBase : "/",
            `http://${host === "::1" ? "[::1]" : host}:${String(address.port)}`,
          ).href.replace(/\/$/, ""),
  };
}
