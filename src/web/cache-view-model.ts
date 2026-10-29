import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { RegisteredProject } from "../project-registry.js";
import type { InventoryView } from "./inventory-service.js";
import type { ToolCacheEntry } from "../tool-cache.js";
import type { PreparedImageEntry } from "../image-contract.js";

function groupByOwner<T>(entries: readonly T[], owner: (entry: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const path = owner(entry);
    if (path === undefined) continue;
    const group = groups.get(path);
    if (group) group.push(entry);
    else groups.set(path, [entry]);
  }
  return groups;
}
const toolFamily = (tool: ToolCacheEntry) => JSON.stringify([tool.provider, tool.platform, tool.tool]);
/** One presentation owns its indexes; no expiry or filesystem measurement policy changes. */
export class InventoryIndex {
  readonly owned;
  readonly builders;
  readonly images;
  readonly knownProjects;
  readonly tools = new Map<string, ToolCacheEntry[]>();
  private readonly newest = new Map<string, string>();
  constructor(readonly data: InventoryView) {
    this.owned = groupByOwner(data.inventory.entries, (entry) => entry.identity.checkout);
    this.builders = groupByOwner(data.inventory.builders?.entries ?? [], (entry) => entry.checkout);
    this.images = groupByOwner<PreparedImageEntry>(data.inventory.images?.entries ?? [], (entry) => entry.checkout);
    this.knownProjects = new Set(data.projects.map((project) => project.path));
    for (const tool of data.inventory.tools?.entries ?? []) {
      for (const path of new Set(data.consumers[tool.id] ?? [])) {
        const tools = this.tools.get(path);
        if (tools) tools.push(tool);
        else this.tools.set(path, [tool]);
      }
      const key = toolFamily(tool),
        version = this.newest.get(key);
      if (version === undefined || tool.version.localeCompare(version, undefined, { numeric: true }) > 0)
        this.newest.set(key, tool.version);
    }
  }
  isOlder(tool: ToolCacheEntry): boolean {
    return (
      (this.newest.get(toolFamily(tool)) ?? tool.version).localeCompare(tool.version, undefined, { numeric: true }) > 0
    );
  }
}

export function cacheRowKey(prefix: string, value: string): string {
  return prefix + createHash("sha256").update(value).digest("hex").slice(0, 24);
}
/** Cache ownership and availability are prepared once, independently of table markup. */
export function projectCacheViews(
  index: InventoryIndex,
  projects: RegisteredProject[],
  page: "projects" | "caches",
  owner?: string | null,
) {
  const data = index.data,
    registered = new Set(projects.map((project) => project.path));
  const unlisted =
    page === "caches"
      ? [...index.owned.keys()].filter((path) => (!owner || path === owner) && !registered.has(path))
      : [];
  const visible = [
    ...projects.filter((project) => !owner || project.path === owner),
    ...unlisted.map((path) => ({ name: "Unlisted project", path })),
  ];
  return visible.map((project: { path: string; id?: string; name: string }) => {
    const owned = index.owned.get(project.path) ?? [],
      builders = index.builders.get(project.path) ?? [],
      images = index.images.get(project.path) ?? [],
      tools = index.tools.get(project.path) ?? [];
    return {
      project,
      owned,
      builders,
      images,
      tools,
      id: cacheRowKey("project-", project.path),
      available: existsSync(project.path),
      complete: data.complete && (!project.id || index.knownProjects.has(project.path)),
      shared: tools.filter((tool) => (data.consumers[tool.id]?.length ?? 0) > 1),
      removable: owned.filter((entry) => !entry.blockedBy),
      retained: owned.filter((entry) => entry.blockedBy),
      href: `/caches?${project.id ? `project=${project.id}` : `owner=${encodeURIComponent(project.path)}`}`,
    };
  });
}
