import type { QueueChange } from "../task-queue.js";
import { recordTypes } from "../record-metadata.js";
import type { BrowserRecord } from "../record-service.js";
import { taskStatuses, type TaskStatus, type ExperimentStatus } from "../record-document.js";
import type { DocumentView, DifferenceLayout, ViewState, ReviewView } from "./navigation-state.js";
import { InvalidInput } from "../input-errors.js";
import { ActionEffect, WebAction } from "../diagnostics.js";
export const Route = {
  Projects: "/projects",
  Caches: "/caches",
  Inventory: "/inventory",
  ProjectAdd: "/projects/add",
  ProjectRemove: "/projects/remove",
  CachePrepare: "/caches/prepare",
  CacheKeep: "/caches/keep",
  CacheUnused: "/caches/unused",
  CleanupApply: "/cleanup/apply",
  Cleanup: "/cleanup",
  Demonstration: "/demonstration",
  Overview: "/",
  NewCharter: "/charter/new",
  CreateCharter: "/actions/charter-create",
  WorkspaceRetry: "/actions/workspace-retry",
  Record: "/records/:id",
  Records: "/records",
  TaskQueue: "/queue",
  TaskState: "/actions/task-state",
  FormatReview: "/actions/review-format",
  QueueChange: "/actions/task-queue",
  Review: "/review",
  ReviewStatus: "/review-status",
  PolicyResolution: "/actions/policy-resolution",
  ReviewFile: "/review-file",
  Collections: "/collections",
  Proposal: "/collection-proposal",
  CitationDocument: "/records/:id/document",
  CitationOriginal: "/records/:id/original",
  CitationOriginalContent: "/records/:id/original/content",
  File: "/records/:id/files",
  Metrics: "/metrics",
  Events: "/events",
  Style: "/assets/style.css",
  Client: "/assets/client.js",
  Favicon: "/favicon.ico",
  Save: "/actions/save",
  Approve: "/actions/approve",
  Apply: "/actions/collection-apply",
  Preview: "/actions/collection-preview",
} as const;
export type Route = (typeof Route)[keyof typeof Route];

const recordTemplates = {
  [Route.Record]: Route.Record,
  [Route.Review]: Route.Record + Route.Review,
  [Route.File]: Route.File,
  [Route.CitationDocument]: Route.CitationDocument,
  [Route.CitationOriginal]: Route.CitationOriginal,
  [Route.CitationOriginalContent]: Route.CitationOriginalContent,
} as const;
function recordMatch(path: string): { route: Route; encoded: string } | undefined {
  const encoded = path.split("/")[2];
  if (!encoded) return;
  for (const [route, template] of Object.entries(recordTemplates))
    if (template.replace(":id", encoded) === path) return { route: route as Route, encoded };
  return;
}
/** Identity belongs in the resource path; query parameters retain explicit view choices. */
export function routePath(route: Route, parameters: URLSearchParams): string {
  if (!Object.hasOwn(recordTemplates, route)) return route;
  const template = recordTemplates[route as keyof typeof recordTemplates];
  const id = parameters.get("id");
  if (!id) {
    if (route === Route.Review) return route;
    throw new InvalidInput("Select a record identity");
  }
  parameters.delete("id");
  return template.replace(":id", encodeURIComponent(id).replace(/%3A/gi, ":"));
}
/** Resolve resource identity and validate query fields at the request boundary, once. */
export function decodeRequest(path: string, parameters: URLSearchParams): DecodedRoute | undefined {
  const match = recordMatch(path),
    route = match?.route ?? knownRoute(path);
  if (route === "unknown") return;
  if (!match) {
    if (route === Route.Review && parameters.has("id"))
      throw new InvalidInput("Record identity belongs in the resource path");
    return decodeRoute(route, parameters);
  }
  if (parameters.has("id")) throw new InvalidInput("Repeated record identity");
  const values = new URLSearchParams(parameters);
  try {
    values.set("id", decodeURIComponent(match.encoded));
  } catch {
    throw new InvalidInput("Invalid encoded record identity");
  }
  return decodeRoute(route, values);
}

export interface SourceQuery {
  collection?: string;
  scope?: string;
  all?: "1";
}
export interface RouteQueries {
  [Route.Style]: { v?: string };
  [Route.Client]: { v?: string };
  [Route.Events]: Record<string, never>;
  [Route.TaskQueue]: Record<string, never>;
  [Route.Overview]: SourceQuery;
  [Route.Projects]: { refresh?: "1"; "refresh-sizes"?: "1" };
  [Route.Inventory]: { view?: "projects" | "caches"; project?: string; owner?: string };
  [Route.Record]: SourceQuery & Omit<ViewState, "view"> & { id: string; saved?: "1"; view?: DocumentView };
  [Route.Records]: SourceQuery & {
    type?: BrowserRecord["type"] | "";
    status?: TaskStatus;
    q?: string;
    after?: string;
    through?: string;
    before?: string;
    cursor_revision?: string;
    parent?: string;
    task_windows?: string;
    attention?: "1";
  };
  [Route.ReviewStatus]: { id?: string; path?: string; compatibility?: "1" };
  [Route.Review]: {
    compatibility?: "1";
    id?: string;
    path?: string;
    view?: ReviewView;
    layout?: DifferenceLayout;
    collection_applied?: string;
  };
  [Route.NewCharter]: { project: string };
  [Route.Collections]: SourceQuery;
  [Route.Proposal]: SourceQuery & { token: string };
  [Route.Cleanup]: { token: string };
  [Route.CitationDocument]: { id: string; source: string; download?: "1" | "0" };
  [Route.CitationOriginal]: { id: string; source: string; download?: "1" | "0"; images?: "1" | "0" };
  [Route.CitationOriginalContent]: { id: string; source: string; images?: "1" | "0" };
  [Route.File]: { id: string; path: string; download?: "1" | "0" };
  [Route.ReviewFile]: { path: string; digest: string; side?: "before" | "after" };
  [Route.Caches]: { project?: string; owner?: string; refresh?: "1"; "refresh-sizes"?: "1" };
}
export const queueOperations = [
  "add",
  "remove",
  "start",
  "implemented",
  "block",
  "release",
  "move-before",
  "move-after",
] as const satisfies readonly QueueOperation[];
export type QueueOperation = Exclude<QueueChange["action"], "move"> | "move-before" | "move-after";
type EmptyFields = Record<string, never>;
type CacheTarget = { project: string; unlisted?: never } | { unlisted: string; project?: never };
export interface MutationFields {
  [Route.FormatReview]: { expected: string; path: string };
  [Route.PolicyResolution]: {
    policy_digest: string;
    finding: string;
    decision: "approve" | "dismiss";
    reviewed: "yes";
  };
  [Route.TaskState]: { reference: string; expected: string; state: TaskStatus | ExperimentStatus };
  [Route.QueueChange]: { operation: QueueOperation; reference: string; target: string; expected: string };
  [Route.WorkspaceRetry]: EmptyFields;
  [Route.Save]: { id: string; expected: string };
  [Route.CreateCharter]: { project: string };
  [Route.Approve]: {
    path: string;
    digest: string;
    review_layout: DifferenceLayout;
    reviewed: "yes";
    human_written: "yes" | "no";
  };
  [Route.Preview]: EmptyFields;
  [Route.Apply]: { token: string; reviewed: "yes"; accept_all?: "yes" | "no" };
  [Route.ProjectAdd]: EmptyFields;
  [Route.ProjectRemove]: { project: string };
  [Route.CachePrepare]: CacheTarget & { root?: string };
  [Route.CacheKeep]: { identity: string; keep: "yes" | "no" };
  [Route.CacheUnused]: EmptyFields;
  [Route.CleanupApply]: { token: string };
  [Route.Demonstration]: EmptyFields;
}

type QueryDecoder = (value: string) => string;
const bounded =
  (maximum: number): QueryDecoder =>
  (value) => {
    if (value.length > maximum || value.includes("\0")) throw new InvalidInput("Invalid route parameter");
    return value;
  };
const oneOf =
  (choices: readonly string[]): QueryDecoder =>
  (value) => {
    if (!choices.includes(value)) throw new InvalidInput("Unknown route parameter value");
    return value;
  };
interface RouteContract {
  scope: "global" | "project";
  methods: readonly string[];
  query: Record<string, QueryDecoder>;
  action?: { operation: WebAction; effect: ActionEffect };
  operation?: string;
}
type RouteContracts = {
  [R in Route]: Omit<RouteContract, "query"> & {
    query: R extends keyof RouteQueries
      ? { [K in keyof RouteQueries[R]]-?: QueryDecoder }
      : Record<string, QueryDecoder>;
  };
};
export const routeContracts: RouteContracts = {
  [Route.FormatReview]: {
    scope: "project",
    methods: ["POST"],
    query: {},
    action: { operation: WebAction.Review, effect: ActionEffect.Applied },
  },
  [Route.PolicyResolution]: {
    scope: "project",
    methods: ["POST"],
    query: {},
    action: { operation: WebAction.PolicyResolution, effect: ActionEffect.Applied },
  },
  [Route.TaskQueue]: { scope: "project", methods: ["GET"], query: {} },
  [Route.TaskState]: {
    scope: "project",
    methods: ["POST"],
    query: {},
    action: { operation: WebAction.Task, effect: ActionEffect.Applied },
  },
  [Route.QueueChange]: {
    scope: "project",
    methods: ["POST"],
    query: {},
    action: { operation: WebAction.Queue, effect: ActionEffect.Applied },
  },
  [Route.Projects]: {
    scope: "global",
    methods: ["GET"],
    query: { refresh: oneOf(["1"]), "refresh-sizes": oneOf(["1"]) },
  },
  [Route.Caches]: {
    scope: "global",
    methods: ["GET"],
    query: { project: bounded(1024), owner: bounded(1024), refresh: oneOf(["1"]), "refresh-sizes": oneOf(["1"]) },
  },
  [Route.Inventory]: {
    scope: "global",
    methods: ["GET"],
    query: { view: oneOf(["projects", "caches"]), project: bounded(1024), owner: bounded(1024) },
  },
  [Route.ProjectAdd]: { operation: "project.add", scope: "global", methods: ["POST"], query: {} },
  [Route.ProjectRemove]: { operation: "project.remove.preview", scope: "global", methods: ["POST"], query: {} },
  [Route.CachePrepare]: { operation: "cache.clear.preview", scope: "global", methods: ["POST"], query: {} },
  [Route.CacheKeep]: { operation: "cache.keep", scope: "global", methods: ["POST"], query: {} },
  [Route.CacheUnused]: { operation: "cache.unused.preview", scope: "global", methods: ["POST"], query: {} },
  [Route.CleanupApply]: { operation: "cache.cleanup.apply", scope: "global", methods: ["POST"], query: {} },
  [Route.Cleanup]: { scope: "global", methods: ["GET"], query: { token: bounded(1024) } },
  [Route.Demonstration]: { operation: "demonstration.open", scope: "global", methods: ["POST"], query: {} },
  [Route.Overview]: {
    scope: "project",
    methods: ["GET"],
    query: { collection: bounded(1024), scope: bounded(1024), all: oneOf(["1"]) },
  },
  [Route.NewCharter]: { scope: "project", methods: ["GET"], query: { project: bounded(1024) } },
  [Route.CreateCharter]: {
    scope: "project",
    methods: ["POST"],
    query: {},
    action: { operation: WebAction.CreateCharter, effect: ActionEffect.Applied },
  },
  [Route.WorkspaceRetry]: { operation: "workspace.retry", scope: "project", methods: ["POST"], query: {} },
  [Route.Record]: {
    scope: "project",
    methods: ["GET"],
    query: {
      collection: bounded(1024),
      scope: bounded(1024),
      all: oneOf(["1"]),
      id: bounded(1024),
      saved: oneOf(["1"]),
      view: oneOf(["read", "changes", "edit"]),
      baseline: oneOf(["reviewed", "upstream"]),
      layout: oneOf(["unified", "split"]),
    },
  },
  [Route.Records]: {
    scope: "project",
    methods: ["GET"],
    query: {
      collection: bounded(1024),
      scope: bounded(1024),
      all: oneOf(["1"]),
      type: oneOf(["", ...recordTypes]),
      status: oneOf(taskStatuses),
      q: bounded(512),
      after: bounded(8192),
      through: bounded(8192),
      before: bounded(8192),
      cursor_revision: bounded(1024),
      parent: bounded(1024),
      task_windows: bounded(32768),
      attention: oneOf(["1"]),
    },
  },
  [Route.ReviewStatus]: {
    scope: "project",
    methods: ["GET"],
    query: {
      compatibility: oneOf(["1"]),
      id: bounded(1024),
      path: bounded(4096),
    },
  },
  [Route.Review]: {
    scope: "project",
    methods: ["GET"],
    query: {
      compatibility: oneOf(["1"]),
      id: bounded(1024),
      path: bounded(4096),
      view: oneOf(["diff", "previous", "current"]),
      collection_applied: bounded(1024),
      layout: oneOf(["unified", "split"]),
    },
  },
  [Route.ReviewFile]: {
    scope: "project",
    methods: ["GET"],
    query: {
      path: bounded(4096),
      digest: bounded(1024),
      side: oneOf(["before", "after"]),
    },
  },
  [Route.Collections]: {
    scope: "project",
    methods: ["GET"],
    query: { collection: bounded(1024), scope: bounded(1024), all: oneOf(["1"]) },
  },
  [Route.Proposal]: {
    scope: "project",
    methods: ["GET"],
    query: { token: bounded(1024), collection: bounded(1024), scope: bounded(1024), all: oneOf(["1"]) },
  },
  [Route.CitationOriginal]: {
    scope: "project",
    methods: ["GET", "HEAD"],
    query: { id: bounded(1024), source: bounded(4096), download: oneOf(["1", "0"]), images: oneOf(["1", "0"]) },
  },
  [Route.CitationOriginalContent]: {
    scope: "project",
    methods: ["GET", "HEAD"],
    query: { id: bounded(1024), source: bounded(4096), images: oneOf(["1", "0"]) },
  },
  [Route.CitationDocument]: {
    scope: "project",
    methods: ["GET", "HEAD"],
    query: { id: bounded(1024), source: bounded(4096), download: oneOf(["1", "0"]) },
  },
  [Route.File]: {
    scope: "project",
    methods: ["GET"],
    query: { id: bounded(1024), path: bounded(4096), download: oneOf(["1", "0"]) },
  },
  [Route.Metrics]: { scope: "project", methods: ["GET"], query: {} },
  [Route.Events]: { scope: "project", methods: ["GET"], query: {} },
  [Route.Style]: { scope: "global", methods: ["GET", "HEAD"], query: { v: bounded(64) } },
  [Route.Client]: { scope: "global", methods: ["GET", "HEAD"], query: { v: bounded(64) } },
  [Route.Favicon]: { scope: "global", methods: ["GET"], query: {} },
  [Route.Save]: {
    scope: "project",
    methods: ["POST"],
    query: {},
    action: { operation: WebAction.Save, effect: ActionEffect.Applied },
  },
  [Route.Approve]: {
    scope: "project",
    methods: ["POST"],
    query: {},
    action: { operation: WebAction.Review, effect: ActionEffect.Applied },
  },
  [Route.Apply]: {
    scope: "project",
    methods: ["POST"],
    query: {},
    action: { operation: WebAction.Apply, effect: ActionEffect.Applied },
  },
  [Route.Preview]: {
    scope: "project",
    methods: ["POST"],
    query: {},
    action: { operation: WebAction.Preview, effect: ActionEffect.Prepared },
  },
};
export function knownRoute(path: string): Route | "unknown" {
  const resource = recordMatch(path);
  if (resource) return resource.route;
  return Object.values(Route).find((route) => route === path && !route.includes(":id")) ?? "unknown";
}

export function routeScope(path: string): "global" | "project" {
  const route = knownRoute(path.split(/[?#]/, 1)[0] ?? path);
  return route === "unknown" ? (path.startsWith("/assets/") ? "global" : "project") : routeContracts[route].scope;
}
export function actionDefinition(path: string) {
  const route = knownRoute(path);
  return route === "unknown" ? undefined : routeContracts[route].action;
}
export type RouteQuery<R extends Route> = R extends keyof RouteQueries
  ? Partial<RouteQueries[R]>
  : Record<string, never>;
export type DecodedRoute = { [R in Route]: { route: R; query: RouteQuery<R> } }[Route];
export function decodeRoute(route: Route, parameters: URLSearchParams): DecodedRoute {
  // The contract validates each field; this assertion connects that runtime boundary to its mapped route type.
  return { route, query: decodeRouteQuery(route, parameters) } as DecodedRoute;
}
export function sourceSelection(query: DecodedRoute["query"]): {
  id?: string;
  path?: string;
  collection?: string;
  scope?: string;
  all?: string;
} {
  return Object.fromEntries(
    Object.entries(query).filter(([key]) => ["id", "path", "collection", "scope", "all"].includes(key)),
  );
}
export function decodeRouteQuery<R extends keyof RouteQueries>(
  route: R,
  parameters: URLSearchParams,
): Partial<RouteQueries[R]>;
export function decodeRouteQuery(route: Route, parameters: URLSearchParams): Record<string, string>;
export function decodeRouteQuery(route: Route, parameters: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  const fields = routeContracts[route].query;
  for (const name of parameters.keys())
    if (!Object.hasOwn(fields, name)) throw new InvalidInput(`Unknown route parameter: ${name}`);
  for (const [name, decode] of Object.entries(routeContracts[route].query)) {
    const values = parameters.getAll(name);
    if (values.length > 1) throw new InvalidInput(`Repeated route parameter: ${name}`);
    const value = values[0];
    if (value !== undefined) result[name] = decode(value);
  }
  return result;
}
export interface ActionResult {
  redirect: string;
  operation: WebAction;
  effect: ActionEffect;
}

export function routeOperation(path: string): string {
  const route = knownRoute(path);
  if (route === "unknown") return WebAction.Unknown;
  const contract = routeContracts[route];
  return contract.operation ?? contract.action?.operation ?? WebAction.Unknown;
}
