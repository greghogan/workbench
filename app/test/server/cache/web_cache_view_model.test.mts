import { resolve } from "node:path";
import { expect, test } from "vitest";
import { InventoryIndex, projectCacheViews } from "../../../src/server/cache/cache-view-model.js";
import { emptyInventory } from "../../../src/server/cache/cache-inventory.js";
import type { InventoryView } from "../../../src/server/cache/inventory-service.js";
import type { ToolCacheEntry } from "../../../src/core/toolchains/tool-cache.js";
import type { RegisteredProject } from "../../../src/core/projects/project-registry.js";
import { inventoryPresentation, inventoryPatch } from "../../../src/server/views/hub-pages.tsx";
import { decodeInventoryPatch } from "../../../src/server/cache/inventory-protocol.js";
import { cacheQuantity } from "../../../src/server/cache/cache-quantity.js";
import { parseDOM } from "../../fixtures/dom.mjs";

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
          { key: "owned", checkout: first, builder: "nix", volumes: [], bytes: 1 },
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
    measured = new Map(patch.sizes.map((size) => [size.id, size])),
    document = parseDOM(`<table>${patch.sections.projects ?? ""}</table>`).window.document;
  // Public measurement identifiers preserve live totals without repeating private cache paths in every quantity.
  for (const entry of [...data.inventory.entries, ...entries])
    expect(JSON.stringify(patch)).not.toContain(entry.directory);
  for (const cell of document.querySelectorAll<HTMLElement>("[data-cache-members]")) {
    const members = JSON.parse(cell.dataset.cacheMembers ?? "[]") as string[];
    for (const id of members) expect(measured.has(id)).toBe(true);
    expect(cell.textContent).toBe(
      cacheQuantity(true, measured, members, Number(cell.dataset.cacheExtraBytes ?? 0)).text,
    );
  }
  expect(patch.sizes).toHaveLength(4); // Two owned roots, and two referenced tools; unrelated caches stay off this page.
});
