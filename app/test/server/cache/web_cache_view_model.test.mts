import { resolve } from "node:path";
import { expect, test } from "vitest";
import { InventoryIndex, projectCacheViews, projectQuantities } from "../../../src/server/cache/cache-view-model.js";
import { emptyInventory } from "../../../src/server/cache/cache-inventory.js";
import type { InventoryView } from "../../../src/server/cache/inventory-service.js";
import type { ToolCacheEntry } from "../../../src/core/toolchains/tool-cache.js";
import type { RegisteredProject } from "../../../src/core/projects/project-registry.js";
import { inventoryPresentation, inventoryPatch } from "../../../src/server/views/hub-pages.tsx";
import { decodeInventoryPatch } from "../../../src/server/cache/inventory-protocol.js";
import { parseDOM } from "../../fixtures/dom.mjs";
import { formatBytes } from "../../../src/core/runtime/byte-size.js";

test.each(["projects", "caches"] as const)(
  "%s orders display names without regard to case, with paths breaking ties and registry order preserved",
  (page) => {
    const projects: RegisteredProject[] = [
      { name: "Workbench", path: "first" },
      { name: "catalog", path: "second" },
      { name: "Alpha", path: "third" },
      { name: "alpha", path: "fourth" },
    ].map((project, i) => ({
      ...project,
      path: resolve("fixture", project.path),
      id: String(i),
      state: "registered",
      updated: "2026-01-01T00:00:00Z",
    }));
    const data: InventoryView = {
      ...emptyInventory(),
      projects,
      complete: true,
      refreshing: false,
      problem: "",
    };
    const original = structuredClone(projects);
    const rows = projectCacheViews(new InventoryIndex(data), projects, page);
    expect(rows.map((row) => row.project)).toEqual([projects[3], projects[2], projects[1], projects[0]]);
    expect(projects).toEqual(original);
  },
);

test("indexed ownership and version families agree with independent catalog scans", () => {
  const first = resolve("fixture/first"),
    second = resolve("fixture/second"),
    unlisted = resolve("fixture/unlisted");
  const projects: RegisteredProject[] = [first, second].map((path, i) => ({
    id: String(i),
    path,
    name: path,
    state: "registered",
    updated: "2026-01-01T00:00:00Z",
  }));
  const tool = (id: string, version: string, platform = "fixture"): ToolCacheEntry => ({
    id,
    version,
    platform,
    provider: "workbench",
    tool: "compiler",
    directory: resolve("fixture/tools", id),
    identity: id,
    bytes: 1,
    protected: [],
    pinnedBy: [],
    protections: [],
  });
  const entries = [tool("old", "2.0"), tool("new", "10.0"), tool("other-platform", "1.0", "different")];
  const data: InventoryView = {
    ...emptyInventory(),
    projects,
    complete: true,
    refreshing: false,
    problem: "",
    inventory: {
      storageRoot: resolve("fixture"),
      checkout: null,
      entries: [second, first, unlisted].map((checkout, i) => ({
        kind: "builds",
        directory: resolve("fixture/builds", String(i)),
        bytes: 1,
        identity: { checkout, root: ".", environment: "native", fingerprint: "fixture" },
      })),
      tools: { entries, issues: [], references: { results: [], issues: [] } },
      builders: {
        entries: [
          { key: "owned", checkout: first, builder: "buildkit", volumes: [], bytes: 1 },
          { key: "unknown", builder: "nix", volumes: [], bytes: 2 },
        ],
        issues: [],
      },
    },
    consumers: { old: [first, first, second], new: [second], "other-platform": [] },
  };
  const index = new InventoryIndex(data);
  const rows = projectCacheViews(index, projects, "caches");
  expect(rows.map((row) => row.project.path)).toEqual([first, second, unlisted]);
  for (const row of rows) {
    expect(row.owned).toEqual(data.inventory.entries.filter((entry) => entry.identity.checkout === row.project.path));
    expect(row.builders).toEqual(
      data.inventory.builders?.entries.filter((entry) => entry.checkout === row.project.path),
    );
    expect(row.tools).toEqual(entries.filter((entry) => data.consumers[entry.id]?.includes(row.project.path)));
  }
  for (const entry of entries)
    expect(index.isOlder(entry)).toBe(
      entries.some(
        (candidate) =>
          candidate.provider === entry.provider &&
          candidate.platform === entry.platform &&
          candidate.tool === entry.tool &&
          candidate.version.localeCompare(entry.version, undefined, { numeric: true }) > 0,
      ),
    );
  expect(projectCacheViews(index, projects, "projects").map((row) => row.project.path)).toEqual([first, second]);
  expect(projectCacheViews(index, projects, "caches", second).map((row) => row.project.path)).toEqual([second]);
  data.sizes = [...data.inventory.entries, ...entries].map((entry, i) => ({
    directory: entry.directory,
    state: "ready",
    bytes: 1024 * (i + 1),
    measuredAt: "2026-11-17T00:00:00Z",
  }));
  const patch = decodeInventoryPatch(
      JSON.parse(JSON.stringify(inventoryPatch(inventoryPresentation(data, projects, "csrf", "projects")))),
    ),
    document = parseDOM(`<table>${patch.sections.projects ?? ""}</table>`).window.document;
  for (const entry of [...data.inventory.entries, ...entries])
    expect(JSON.stringify(patch)).not.toContain(entry.directory);
  expect(document.querySelector("[data-cache-members]")).toBeNull();
  expect(patch.sizes).toHaveLength(0);
  const measured = new Map(data.sizes.map((size) => [size.directory, size]));
  for (const row of rows.slice(0, 2)) {
    const displayed = document.querySelector(`[data-cache-cell="${row.id}-owned"]`);
    expect(displayed?.textContent).toBe(projectQuantities(row, measured, false).owned.text);
  }
});

test("cache pages load bounded details while totals and continuation cover the complete inventory", () => {
  const path = resolve("fixture/project"),
    projects: RegisteredProject[] = [
      { id: "fixture", path, name: "Fixture", state: "registered", updated: "2026-01-01T00:00:00Z" },
    ],
    data: InventoryView = { ...emptyInventory(), projects, complete: true, refreshing: false, problem: "" };
  data.inventory.entries = Array.from({ length: 140 }, (_, n) => ({
    kind: "builds",
    directory: resolve("fixture/builds", String(n)),
    bytes: 1,
    identity: {
      checkout: path,
      root: `root-${String(n).padStart(3, "0")}`,
      environment: "native",
      fingerprint: "fixture",
    },
  }));
  data.sizes = data.inventory.entries.map(({ directory }) => ({
    directory,
    state: "ready",
    bytes: 1000,
    measuredAt: "2026-01-01T00:00:00Z",
  }));
  const first = inventoryPresentation(data, projects, "csrf", "caches", path),
    patch = inventoryPatch(first),
    dom = parseDOM(`<table>${patch.sections.roots ?? ""}</table>`).window.document;
  expect(dom.body.textContent).toContain("root-000");
  expect(dom.body.textContent).not.toContain("root-139");
  const totals = parseDOM(`<table>${patch.sections.projects ?? ""}</table>`).window.document;
  expect(totals.querySelector('[data-cache-cell$="-owned"]')?.textContent).toBe(formatBytes(140_000));
  const next = new URL(
    dom.querySelector<HTMLAnchorElement>("nav a")?.getAttribute("href") ?? "",
    "https://example.invalid",
  );
  expect(next.searchParams.get("project")).toBe("fixture");
  let last = next;
  for (let i = 0; i < 2; i++) {
    const current = inventoryPresentation(data, projects, "csrf", "caches", path, undefined, undefined, {
      section: "roots",
      offset: last.searchParams.get("offset") ?? "0",
    });
    const recalculate = new URL(current.recalculateURL, last);
    expect(recalculate.searchParams.get("project")).toBe("fixture");
    expect(recalculate.searchParams.get("section")).toBe("roots");
    expect(recalculate.searchParams.get("offset")).toBe(last.searchParams.get("offset"));
    expect(recalculate.searchParams.get("refresh-sizes")).toBe("1");
    const detail = inventoryPatch(current),
      table = parseDOM(`<table>${detail.sections.roots ?? ""}</table>`).window.document;
    expect(detail.sizes.length).toBeLessThanOrEqual(patch.sizes.length);
    if (i === 1) expect(table.body.textContent).toContain("root-139");
    const nextPage = table.querySelector<HTMLAnchorElement>("nav a:last-child")?.getAttribute("href");
    if (nextPage) last = new URL(nextPage, last);
  }
});
