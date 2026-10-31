import { expect, test } from "vitest";
import { recordURL, routeURL, withView } from "../src/web/locations.js";
import { DifferenceLayout } from "../src/web/navigation-state.js";
import { withProjectPaths } from "../src/web/project-paths.js";
import { Route } from "../src/web/routes.js";
import { ReviewSource } from "../src/review-service.js";

test("view transitions preserve decoded record identity, source, comparison, fragment, and project prefix", () => {
  const url = withProjectPaths("/p/fixture", () => {
    const start = recordURL("scope:ADR-0", { collection: "patterns", view: "changes", baseline: "upstream" });
    return new URL(withView(start + "#purpose", { layout: DifferenceLayout.Split }), "http://localhost");
  });
  expect(url.pathname).toBe("/p/fixture/record");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    id: "scope:ADR-0",
    collection: "patterns",
    view: "changes",
    baseline: "upstream",
    layout: "split",
  });
  expect(url.hash).toBe("#purpose");
  expect(withView("/review", { layout: DifferenceLayout.Inline })).toBe("/review?layout=unified");
});
test("route parameters are encoded once without allowing file names to replace query fields", () => {
  const path = "workbench/experiments/EXP-00/a & b?#.txt";
  const url = new URL(
    routeURL(Route.ReviewFile, { path, digest: "exact-version", review_source: ReviewSource.Staged, side: "before" }),
    "http://localhost",
  );
  expect(url.searchParams.get("path")).toBe(path);
  expect(url.searchParams.get("digest")).toBe("exact-version");
  expect(url.searchParams.get("side")).toBe("before");
  expect(url.hash).toBe("");
});
test("global routes retain their ownership inside a project request, including query parameters", () => {
  withProjectPaths("/p/fixture", () => {
    const caches = new URL(routeURL(Route.Caches, { project: "other" }), "http://localhost");
    expect(caches.pathname).toBe("/caches");
    expect(caches.searchParams.get("project")).toBe("other");
    for (const route of [
      Route.Projects,
      Route.ProjectAdd,
      Route.ProjectRemove,
      Route.CachePrepare,
      Route.Style,
      Route.Favicon,
    ])
      expect(withView(route, {})).toBe(route);
    expect(routeURL(Route.Record, { id: "fixture:ADR-0" })).toBe("/p/fixture/record?id=fixture%3AADR-0");
  });
});

test("route contracts share method, scope, and bounded decoded query choices", async () => {
  const { routeContracts, decodeRouteQuery } = await import("../src/web/routes.ts");
  expect(routeContracts[Route.WorkspaceRetry]).toMatchObject({ scope: "project", methods: ["POST"] });
  expect(decodeRouteQuery(Route.Review, new URLSearchParams("layout=split&review_source=working"))).toEqual({
    layout: "split",
    review_source: "working",
  });
  expect(() => decodeRouteQuery(Route.Review, new URLSearchParams("layout=unknown"))).toThrow("Unknown route");
  expect(() => decodeRouteQuery(Route.Record, new URLSearchParams("id=first&id=second"))).toThrow("Repeated route");
  expect(() => decodeRouteQuery(Route.Records, new URLSearchParams({ q: "x".repeat(513) }))).toThrow("Invalid route");
});

test("route decoding rejects undeclared fields and retains declared inventory selectors", async () => {
  const { decodeRoute } = await import("../src/web/routes.ts");
  expect(decodeRoute(Route.Inventory, new URLSearchParams("view=caches&project=abc&owner=%2Ftmp%2Fa"))).toEqual({
    route: Route.Inventory,
    query: { view: "caches", project: "abc", owner: "/tmp/a" },
  });
  expect(() => decodeRoute(Route.Record, new URLSearchParams("id=demo:ADR-0&unexpected=1"))).toThrow(
    "Unknown route parameter: unexpected",
  );
  expect(() => decodeRoute(Route.Inventory, new URLSearchParams("view=caches&view=projects"))).toThrow(
    "Repeated route parameter: view",
  );
});
