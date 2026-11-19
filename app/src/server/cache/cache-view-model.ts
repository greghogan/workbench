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
import type { Quantity } from "./cache-quantity.js";
import type { ProjectCacheSizeUpdate } from "./inventory-protocol.js";

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
  private readonly pendingBuildkitOwners;
  readonly tools = new Map<string, ToolCacheEntry[]>();
  private readonly newest = new Map<string, string>();
  constructor(readonly data: InventoryView) {
    this.owned = groupByOwner(data.inventory.entries, (entry) => entry.identity.checkout);
    this.builders = groupByOwner(data.inventory.builders?.entries ?? [], (entry) => entry.checkout);
    this.images = groupByOwner<PreparedImageEntry>(data.inventory.images?.entries ?? [], (entry) => entry.checkout);
    this.knownProjects = new Set(data.projects.map((project) => project.path));
    this.pendingBuildkitOwners = data.pendingBuildkitOwners && new Set(data.pendingBuildkitOwners);
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
  projectStorage(path: string, registered: boolean) {
    const owned = this.owned.get(path) ?? [],
      tools = this.tools.get(path) ?? [];
    return {
      owned,
      tools,
      builders: this.builders.get(path) ?? [],
      complete: this.data.complete && (!registered || this.knownProjects.has(path)),
      buildersReady:
        !this.data.pendingComponents?.includes("builders") || this.pendingBuildkitOwners?.has(path) === false,
      shared: tools.filter((tool) => (this.data.consumers[tool.id]?.length ?? 0) > 1),
      removable: owned.filter((entry) => !entry.blockedBy),
      retained: owned.filter((entry) => entry.blockedBy),
    };
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
  const registered = new Set(projects.map((project) => project.path));
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
  const available = metadata ? new Set(metadata.available) : undefined;
  return groups.map(({ project, worktrees }) => ({
    ...index.projectStorage(project.path, Boolean(project.id)),
    project,
    worktrees: worktrees.map((project) => ({
      ...project,
      available: available?.has(project.path) ?? existsSync(project.path),
    })),
    images: index.images.get(project.path) ?? [],
    id: cacheRowKey("project-", project.path),
    available: available?.has(project.path) ?? existsSync(project.path),
    href: `/caches?${project.id ? `project=${project.id}` : `owner=${encodeURIComponent(project.path)}`}`,
  }));
}

export function projectQuantities(
  view: ReturnType<InventoryIndex["projectStorage"]>,
  sizes: ReadonlyMap<string, CacheSize>,
  uncertain: boolean,
) {
  const { complete, owned, removable, retained, tools, shared } = view;
  // Managed profiles reference shared store data. Only BuildKit volumes are project-specific.
  const builders = view.builders.filter((entry) => entry.builder === "buildkit");
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

export function ownershipAccountingUnknown(data: InventoryView): boolean {
  return data.issues.some((issue) => ["builds", "builders", "registry"].includes(issue.component));
}

/** A directory completion only revisits totals that depend on that directory. */
export class ProjectCacheSizes {
  private readonly sizes: Map<string, CacheSize>;
  private readonly groups = new Map<string, { cell: string; quantity: Quantity; pending: Set<string> }[]>();

  constructor(data: InventoryView) {
    this.sizes = new Map(data.sizes.map((size) => [size.directory, size]));
    const unknown = ownershipAccountingUnknown(data);
    const index = new InventoryIndex(data);
    for (const path of new Set([...index.knownProjects, ...index.owned.keys()])) {
      const id = cacheRowKey("project-", path);
      const quantities = projectQuantities(
        index.projectStorage(path, index.knownProjects.has(path)),
        this.sizes,
        unknown,
      );
      for (const [name, quantity] of Object.entries(quantities)) {
        if (quantity.uncertain || !quantity.directories.length) continue;
        const pending = new Set(quantity.directories.filter((path) => this.sizes.get(path)?.state !== "ready"));
        const group = { cell: `${id}-${name}`, quantity, pending };
        for (const directory of quantity.directories) {
          const members = this.groups.get(directory);
          if (members) members.push(group);
          else this.groups.set(directory, [group]);
        }
      }
    }
  }

  update(size: CacheSize): Omit<ProjectCacheSizeUpdate, "revision">[] {
    this.sizes.set(size.directory, size);
    const updates = [];
    for (const { cell, quantity, pending } of this.groups.get(size.directory) ?? []) {
      if (size.state === "ready") pending.delete(size.directory);
      else pending.add(size.directory);
      if (pending.size) continue;
      const { text, title } = cacheQuantity(true, this.sizes, quantity.directories, quantity.extra);
      updates.push({ cell, text, title });
    }
    return updates;
  }
}
