import type { ProjectDirectoryView } from "../projects/project-directory.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { RegisteredProject } from "../../core/projects/project-registry.js";
import { registeredProjectGroups } from "../../core/projects/project-registration.js";
import type { InventoryView } from "./inventory-service.js";
import type { ToolCacheEntry } from "../../core/toolchains/tool-cache.js";
import type { PreparedImageEntry } from "../../core/artifacts/image-contract.js";
import { totalBytes } from "../../core/runtime/byte-size.js";
import type { CacheSize } from "../../core/storage/cache-size.js";
import { cacheQuantity } from "./cache-quantity.js";
import type { CacheMeasurement } from "./size-protocol.js";

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
export const cacheSizeKey = (directory: string): string => cacheRowKey("size-", directory);
export function cacheMeasurement(size: CacheSize): CacheMeasurement {
  const { directory, ...value } = size;
  return { id: cacheSizeKey(directory), ...value };
}
/** Cache ownership and availability are prepared once, independently of table markup. */
export function projectCacheViews(
  index: InventoryIndex,
  projects: RegisteredProject[],
  page: "projects" | "caches",
  owner?: string | null,
  metadata?: ProjectDirectoryView,
) {
  const data = index.data,
    registered = new Set(projects.map((project) => project.path));
  const unlisted =
    page === "caches"
      ? [...index.owned.keys()].filter((path) => (!owner || path === owner) && !registered.has(path))
      : [];
  const visible: { path: string; id?: string; name: string }[] = [
    ...projects
      .filter((project) => !owner || project.path === owner)
      .sort(
        (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "accent" }) || a.path.localeCompare(b.path),
      ),
    ...unlisted.map((path) => ({ name: "Unlisted project", path })),
  ];
  const groups =
    page === "projects"
      ? (metadata?.groups ?? registeredProjectGroups(visible))
      : visible.map((project) => ({ project, worktrees: [] }));
  return groups.map(({ project, worktrees }) => {
    const owned = index.owned.get(project.path) ?? [],
      builders = index.builders.get(project.path) ?? [],
      images = index.images.get(project.path) ?? [],
      tools = index.tools.get(project.path) ?? [];
    return {
      project,
      worktrees: worktrees.map((project) => ({
        ...project,
        available: metadata ? metadata.available.includes(project.path) : existsSync(project.path),
      })),
      owned,
      builders,
      images,
      tools,
      id: cacheRowKey("project-", project.path),
      available: metadata ? metadata.available.includes(project.path) : existsSync(project.path),
      complete: data.complete && (!project.id || index.knownProjects.has(project.path)),
      buildersReady: !data.pendingComponents?.includes("builders"),
      shared: tools.filter((tool) => (data.consumers[tool.id]?.length ?? 0) > 1),
      removable: owned.filter((entry) => !entry.blockedBy),
      retained: owned.filter((entry) => entry.blockedBy),
      href: `/caches?${project.id ? `project=${project.id}` : `owner=${encodeURIComponent(project.path)}`}`,
    };
  });
}

export function projectQuantities(
  view: ReturnType<typeof projectCacheViews>[number],
  sizes: ReadonlyMap<string, CacheSize>,
  uncertain: boolean,
) {
  const { complete, owned, builders, removable, retained, tools, shared } = view;
  const ownedComplete = complete && view.buildersReady;
  return {
    owned: cacheQuantity(
      ownedComplete,
      sizes,
      owned.map((entry) => entry.directory),
      totalBytes(builders.map((entry) => entry.bytes)),
      uncertain,
    ),
    eligible: cacheQuantity(
      ownedComplete,
      sizes,
      removable.map((entry) => entry.directory),
      totalBytes(builders.filter((entry) => !entry.blockedBy).map((entry) => entry.bytes)),
      uncertain,
    ),
    retained: cacheQuantity(
      ownedComplete,
      sizes,
      retained.map((entry) => entry.directory),
      totalBytes(builders.filter((entry) => entry.blockedBy).map((entry) => entry.bytes)),
      uncertain,
    ),
    tools: cacheQuantity(
      complete,
      sizes,
      tools.map((entry) => entry.directory),
    ),
    shared: cacheQuantity(
      complete,
      sizes,
      shared.map((entry) => entry.directory),
    ),
  };
}
