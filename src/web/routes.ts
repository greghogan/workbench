import { recordTypes } from "../record-metadata.js";
import type { ReviewSource } from "../review-service.js";
import type { BrowserRecord } from "../record-service.js";
import type { DocumentView, DifferenceLayout, ViewState } from "./navigation-state.js";
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
  Record: "/record",
  Records: "/records",
  Review: "/review",
  ReviewFile: "/review-file",
  Collections: "/collections",
  Proposal: "/collection-proposal",
  CitationDocument: "/citation-document",
  File: "/file",
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

export interface SourceQuery {
  collection?: string;
  scope?: string;
  all?: "1";
}
export interface RouteQueries {
  [Route.Overview]: SourceQuery;
  [Route.Record]: SourceQuery &
    Omit<ViewState, "view"> & { id: string; saved?: "1"; view?: Exclude<DocumentView, "raw"> };
  [Route.Records]: SourceQuery & {
    type?: BrowserRecord["type"] | "";
    q?: string;
    after?: string;
    through?: string;
    before?: string;
    cursor_revision?: string;
  };
  [Route.Review]: SourceQuery & {
    path?: string;
    review_source?: ReviewSource;
    view?: Exclude<DocumentView, "edit" | "source">;
    layout?: DifferenceLayout;
    baseline?: ViewState["baseline"];
  };
  [Route.NewCharter]: { project: string };
  [Route.Collections]: SourceQuery;
  [Route.Proposal]: SourceQuery & { token: string };
  [Route.Cleanup]: { token: string };
  [Route.CitationDocument]: { id: string; source: string; download?: "1" | "0" };
  [Route.File]: { id: string; path: string; download?: "1" | "0" };
  [Route.ReviewFile]: { path: string; digest: string; review_source: ReviewSource; side?: "before" | "after" };
  [Route.Caches]: { project?: string; owner?: string; refresh?: "1"; "refresh-sizes"?: "1" };
}
type EmptyFields = Record<string, never>;
type CacheTarget = { project: string; unlisted?: never } | { unlisted: string; project?: never };
export interface MutationFields {
  [Route.WorkspaceRetry]: EmptyFields;
  [Route.Save]: { id: string; expected: string };
  [Route.CreateCharter]: { project: string };
  [Route.Approve]: { path: string; digest: string; review_source: ReviewSource; review_layout: DifferenceLayout };
  [Route.Preview]: EmptyFields;
  [Route.Apply]: { token: string };
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
  [Route.Projects]: { scope: "global", methods: ["GET"], query: {} },
  [Route.Caches]: {
    scope: "global",
    methods: ["GET"],
    query: { project: bounded(1024), owner: bounded(1024), refresh: oneOf(["1"]), "refresh-sizes": oneOf(["1"]) },
  },
  [Route.Inventory]: { scope: "global", methods: ["GET"], query: {} },
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
      view: oneOf(["read", "source", "changes", "edit"]),
      layout: oneOf(["unified", "split"]),
      baseline: oneOf(["head", "reviewed", "upstream"]),
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
      q: bounded(512),
      after: bounded(8192),
      through: bounded(8192),
      before: bounded(8192),
      cursor_revision: bounded(1024),
    },
  },
  [Route.Review]: {
    scope: "project",
    methods: ["GET"],
    query: {
      collection: bounded(1024),
      scope: bounded(1024),
      all: oneOf(["1"]),
      path: bounded(4096),
      review_source: oneOf(["working", "staged"]),
      view: oneOf(["read", "raw", "changes"]),
      layout: oneOf(["unified", "split"]),
      baseline: oneOf(["head", "reviewed", "upstream"]),
    },
  },
  [Route.ReviewFile]: {
    scope: "project",
    methods: ["GET"],
    query: {
      path: bounded(4096),
      digest: bounded(1024),
      review_source: oneOf(["working", "staged"]),
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
  [Route.Style]: { scope: "global", methods: ["GET"], query: {} },
  [Route.Client]: { scope: "global", methods: ["GET"], query: {} },
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
  return Object.values(Route).find((route) => route === path) ?? "unknown";
}
export function routeScope(path: string): "global" | "project" {
  const route = knownRoute(path.split(/[?#]/, 1)[0] ?? path);
  return route === "unknown" ? (path.startsWith("/assets/") ? "global" : "project") : routeContracts[route].scope;
}
export function actionDefinition(path: string) {
  const route = knownRoute(path);
  return route === "unknown" ? undefined : routeContracts[route].action;
}
export function decodeRouteQuery<R extends keyof RouteQueries>(
  route: R,
  parameters: URLSearchParams,
): Partial<RouteQueries[R]>;
export function decodeRouteQuery(route: Route, parameters: URLSearchParams): Record<string, string>;
export function decodeRouteQuery(route: Route, parameters: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
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
