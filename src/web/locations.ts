import type { ViewState } from "./navigation-state.js";
import { projectPath } from "./project-paths.js";
import { Route, decodeRouteQuery, routePath, type RouteQueries } from "./routes.js";

/** Construct known routes from decoded values; escaping and project scoping happen once. */
export function routeURL<R extends keyof RouteQueries>(route: R, values: RouteQueries[R]): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) if (typeof value === "string") parameters.set(name, value);
  decodeRouteQuery(route, parameters);
  const path = routePath(route, parameters);
  return projectPath(path + (parameters.size ? "?" + parameters.toString() : ""));
}
export const recordURL = (id: string, state: Omit<RouteQueries[typeof Route.Record], "id"> = {}): string =>
  routeURL(Route.Record, { id, ...state });

export function withView(location: string, state: ViewState): string {
  const url = new URL(location, "http://workbench.invalid");
  for (const [key, value] of Object.entries(state)) if (typeof value === "string") url.searchParams.set(key, value);
  return projectPath(url.pathname + url.search + url.hash);
}
