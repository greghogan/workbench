import { expect, test } from "vitest";
import { recordURL, routeURL, withView } from "../src/web/locations.js";
import { DifferenceLayout } from "../src/web/navigation-state.js";
import { withProjectPaths } from "../src/web/project-paths.js";
import { Route } from "../src/web/routes.js";

test("view transitions preserve decoded record identity, source, comparison, fragment, and project prefix", () => {
  const url = withProjectPaths("/projects/fixture", () => {
    const start = recordURL("scope:ADR-0", { collection: "patterns", view: "changes", baseline: "upstream" });
    return new URL(withView(start + "#purpose", { layout: DifferenceLayout.Split }), "http://localhost");
  });
  expect(url.pathname).toBe("/projects/fixture/records/scope:ADR-0");
  expect(Object.fromEntries(url.searchParams)).toEqual({
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
    routeURL(Route.ReviewFile, { path, digest: "exact-version", side: "before" }),
    "http://localhost",
  );
  expect(url.searchParams.get("path")).toBe(path);
  expect(url.searchParams.get("digest")).toBe("exact-version");
  expect(url.searchParams.get("side")).toBe("before");
  expect(url.hash).toBe("");
});
test("global routes retain their ownership inside a project request, including query parameters", () => {
  withProjectPaths("/projects/fixture", () => {
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
    expect(routeURL(Route.Record, { id: "fixture:ADR-0" })).toBe("/projects/fixture/records/fixture:ADR-0");
  });
});

test("route contracts share method, scope, and bounded decoded query choices", async () => {
  const { routeContracts, decodeRouteQuery } = await import("../src/web/routes.ts");
  expect(routeContracts[Route.WorkspaceRetry]).toMatchObject({ scope: "project", methods: ["POST"] });
  expect(decodeRouteQuery(Route.Review, new URLSearchParams("layout=split"))).toEqual({
    layout: "split",
  });
  expect(() => decodeRouteQuery(Route.Review, new URLSearchParams("layout=unknown"))).toThrow("Unknown route");
  expect(() => decodeRouteQuery(Route.Record, new URLSearchParams("id=first&id=second"))).toThrow("Repeated route");
  expect(() => decodeRouteQuery(Route.Records, new URLSearchParams({ q: "x".repeat(513) }))).toThrow("Invalid route");
});

test("resource identities and explicit default choices survive transitions; malformed or duplicated identities fail", async () => {
  const { knownRoute, decodeRequest } = await import("../src/web/routes.ts");
  const start = recordURL("scope:ADR-7", { layout: DifferenceLayout.Inline });
  expect(withView(start, { view: "edit" })).toBe("/records/scope:ADR-7?layout=unified&view=edit");
  expect(knownRoute("/records/scope:ADR-7/review")).toBe(Route.Review);
  expect(decodeRequest("/records/scope:ADR-7/review", new URLSearchParams("layout=unified"))?.query).toEqual({
    id: "scope:ADR-7",
    layout: "unified",
  });
  expect(() => decodeRequest("/records/scope:ADR-7", new URLSearchParams("id=other:ADR-0"))).toThrow(
    "Repeated record identity",
  );
  expect(() => decodeRequest("/records/%zz", new URLSearchParams())).toThrow("Invalid encoded record identity");
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

test.each([
  [Route.Record, "/records/scope:ADR-7"],
  [Route.Review, "/records/scope:ADR-7/review"],
  [Route.File, "/records/scope:ADR-7/files"],
  [Route.CitationDocument, "/records/scope:ADR-7/document"],
] as const)("%s resource paths share their construction and decoding contract", async (route, path) => {
  const { decodeRequest } = await import("../src/web/routes.ts");
  const fields =
    route === Route.File ? { path: "notes/a & b.md" } : route === Route.CitationDocument ? { source: "published" } : {};
  const built = new URL(routeURL(route, { id: "scope:ADR-7", ...fields }), "http://localhost");
  expect(built.pathname).toBe(path);
  expect(decodeRequest(built.pathname, built.searchParams)).toEqual({ route, query: { id: "scope:ADR-7", ...fields } });
  expect(decodeRequest(built.pathname.replace("scope:ADR-7", "scope%3AADR-7"), built.searchParams)?.query).toEqual({
    id: "scope:ADR-7",
    ...fields,
  });
});
