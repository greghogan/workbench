import { resolve } from "node:path";
import { expect, test } from "vitest";
import { InventoryIndex, projectCacheViews } from "../src/web/cache-view-model.js";
import { emptyInventory } from "../src/web/cache-inventory.js";
import type { InventoryView } from "../src/web/inventory-service.js";
import type { ToolCacheEntry } from "../src/tool-cache.js";
import type { RegisteredProject } from "../src/project-registry.js";

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
});
