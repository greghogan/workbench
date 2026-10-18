import { filterPreparedImages } from "./image-contract.js";
import type { CacheReport, CacheProject, CacheEntry } from "./build-cache.js";
import { prunableTools, toolCacheGroup } from "./tool-cache.js";
import { formatBytes } from "./byte-size.js";

/** Image tags select deletion work, not an additive estimate of reclaimable disk space. */
export function cachePruneSummary(report: CacheReport): { description: string; details: string[] } {
  const filesystem = [...report.entries, ...(report.tools?.entries ?? [])];
  const builders = report.builders?.entries ?? [];
  const images = report.images?.entries ?? [];
  const count = filesystem.length + builders.length + images.length;
  if (report.images?.location === "registry")
    return {
      description: `${String(images.length)} GHCR image ${images.length === 1 ? "version" : "versions"}`,
      details: [],
    };
  if (!count && report.checkout === "images") return { description: "0 local image tags", details: [] };
  if (!count && report.checkout === "builders") return { description: "0 builder stores", details: [] };
  if (!images.length && !builders.length)
    return {
      description: `${String(count)} cache ${count === 1 ? "directory" : "directories"} (${formatBytes(filesystem.reduce((sum, entry) => sum + entry.bytes, 0))})`,
      details: [],
    };
  const details = [
    ...(filesystem.length
      ? [`${formatBytes(filesystem.reduce((sum, entry) => sum + entry.bytes, 0))} filesystem estimate`]
      : []),
    ...(builders.length
      ? [`${formatBytes(builders.reduce((sum, entry) => sum + entry.bytes, 0))} builder volume estimate`]
      : []),
    ...(images.length
      ? [`${String(images.length)} image ${images.length === 1 ? "tag" : "tags"} (reclaimed space unknown)`]
      : []),
  ];
  return { description: `${String(count)} cache ${count === 1 ? "item" : "items"}`, details };
}

/** Pure selection: the menu and confirmation describe exactly the same deletion set. */
export function cachePruneSelection(report: CacheReport, candidates: CacheReport, projects: CacheProject[]) {
  const rootKey = (checkout: string, root: string, target: string) =>
    `root:${JSON.stringify([checkout, root, target])}`;
  const entryKey = (entry: CacheEntry) =>
    rootKey(entry.identity.checkout, entry.identity.root, entry.identity.localCI?.target ?? "—");
  const toolKey = (group: string) => `tool:${group}`;
  const selectedResults = (names: ReadonlySet<string>) =>
    candidates.entries.filter((entry) => names.has(entryKey(entry)));
  const availableTools = (names: ReadonlySet<string>, group?: string) =>
    report.tools
      ? prunableTools(
          report.tools,
          selectedResults(names).map((entry) => entry.directory),
        ).filter((entry) => group === undefined || toolCacheGroup(entry.tool) === group)
      : [];
  const selection = (names: ReadonlySet<string>): CacheReport => ({
    ...candidates,
    entries: selectedResults(names),
    ...(candidates.images
      ? {
          images: filterPreparedImages(candidates.images, (entry) => names.has(`image:${entry.key}`)),
        }
      : {}),
    ...(candidates.builders
      ? {
          builders: {
            ...candidates.builders,
            entries: candidates.builders.entries.filter((entry) => names.has(`builder:${entry.key}`)),
          },
        }
      : {}),
    ...(report.tools
      ? {
          tools: {
            ...report.tools,
            entries: availableTools(names).filter((entry) => names.has(toolKey(toolCacheGroup(entry.tool)))),
          },
        }
      : {}),
  });
  const sizes = (entries: { bytes: number }[]) => entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const toolReason = (names: ReadonlySet<string>, group?: string) => {
    const available = availableTools(names, group),
      all = (report.tools?.entries ?? []).filter(
        (entry) => group === undefined || toolCacheGroup(entry.tool) === group,
      );
    return `${formatBytes(sizes(available))} removable (${String(available.length)}/${String(all.length)}); ${formatBytes(sizes(all) - sizes(available))} pinned`;
  };
  const items = projects.map((project) => {
    if (project.checkout === "Images")
      return {
        name: "Images",
        section: report.images?.location === "registry" ? "GHCR images" : "Local Docker image tags",
        reason:
          report.images?.location === "registry"
            ? `${String(candidates.images?.entries.length ?? 0)} removable versions`
            : `${formatBytes(sizes(candidates.images?.entries ?? []))} image sizes; ${String(candidates.images?.entries.length ?? 0)}/${String(report.images?.entries.length ?? 0)} removable tags`,
        disabled: () => !candidates.images?.entries.length,
        children: (report.images?.entries ?? []).map((entry) => ({
          name: `image:${entry.key}`,
          label: `${entry.profile} (${entry.reference.slice(entry.reference.lastIndexOf(":") + 1)})`,
          reason: entry.blockedBy ?? ("created" in entry ? entry.created : formatBytes(entry.bytes)),
          disabled: () => Boolean(entry.blockedBy),
        })),
      };
    if (project.checkout === "Builders")
      return {
        name: "Builders",
        section: "Container builders",
        reason: `${formatBytes(sizes(candidates.builders?.entries ?? []))} removable; ${String((report.builders?.entries.length ?? 0) - (candidates.builders?.entries.length ?? 0))} retained`,
        disabled: () => !candidates.builders?.entries.length,
        children: (report.builders?.entries ?? []).map((entry) => ({
          name: `builder:${entry.key}`,
          label: entry.key,
          reason: entry.blockedBy ?? formatBytes(entry.bytes),
          disabled: () => Boolean(entry.blockedBy),
        })),
      };
    if (project.checkout === "Tools")
      return {
        name: "Tools",
        section: "Shared tools",
        reason: (names: ReadonlySet<string>) => toolReason(names),
        disabled: (names: ReadonlySet<string>) => !availableTools(names).length,
        children: project.rows.map((row) => ({
          name: toolKey(row.root),
          label: row.root,
          reason: (names: ReadonlySet<string>) => toolReason(names, row.root),
          disabled: (names: ReadonlySet<string>) => !availableTools(names, row.root).length,
        })),
      };
    const available = candidates.entries.filter((entry) => entry.identity.checkout === project.checkout);
    return {
      name: project.checkout,
      section: "Projects",
      disabled: () => !available.length,
      reason: (names: ReadonlySet<string>) => {
        const selected = available.filter((entry) => names.has(entryKey(entry)));
        return !available.length
          ? "busy or dependencies preserved"
          : selected.length > 0 && selected.length < available.length
            ? `${formatBytes(sizes(selected))} selected / ${formatBytes(sizes(available))} available`
            : formatBytes(sizes(available));
      },
      children: project.rows.map((row) => {
        const key = rootKey(project.checkout, row.root, row.target),
          entries = available.filter((entry) => entryKey(entry) === key);
        return {
          name: key,
          label: row.target === "—" ? row.root : `${row.root} (${row.target})`,
          reason: entries.length ? formatBytes(sizes(entries)) : "busy or dependencies preserved",
          disabled: () => !entries.length,
        };
      }),
    };
  });
  const selectedReport = (names: string[]) => selection(new Set(names));
  return {
    items,
    initial: projects
      .filter(
        (project) =>
          (project.checkout !== "Tools" || report.checkout === "tools") &&
          (project.checkout !== "Builders" || report.checkout === "builders") &&
          (project.checkout !== "Images" || (report.checkout === "images" && report.images?.location !== "registry")),
      )
      .map((project) => project.checkout),
    report: selectedReport,
    confirmation: (names: string[]) => {
      const chosen = selectedReport(names);
      const { description, details } = cachePruneSummary(chosen);
      return chosen.images?.location === "registry"
        ? `Delete ${description} from the registry? Other developers may still need these images.`
        : [`Delete ${description}?`, ...details].join("\n");
    },
  };
}
