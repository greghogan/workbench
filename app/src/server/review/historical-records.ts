import { parse } from "smol-toml";
import { readGitTree, readGitObjects, type GitEntry } from "../../core/git/git-snapshot.js";
import { WeightedCache } from "../../core/storage/weighted-cache.js";
import { resolve } from "node:path";
import { logicalRecordEntries } from "../../core/records/archive-store.js";
import { projectsFromData } from "../../core/projects/project-configuration.js";
import { projectPaths } from "../../core/projects/project-paths.js";
import { classifyRecordPath } from "../../core/records/staged-records.js";
import { normalizedNumber } from "../../core/records/record-identity.js";
import { RecordLookup } from "../../core/records/record-lookup.js";
import { describeRecord } from "../../core/records/record-metadata.js";
import type { BrowserRecord } from "../../core/records/record-service.js";
const inventories = new WeightedCache<{ references: RecordLookup; paths: ReadonlySet<string> }>(32 * 1024 * 1024);
export function historicalRecords(
  root: string,
  revision: string,
  suppliedEntries?: ReadonlyMap<string, GitEntry>,
): { references: RecordLookup; paths: ReadonlySet<string> } {
  const key = `${resolve(root)}:${revision}`;
  const cached = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision) ? inventories.get(key) : undefined;
  if (cached) return cached;
  const entries = suppliedEntries ?? logicalRecordEntries(root, readGitTree(root, revision)),
    registry = entries.get(projectPaths.projects),
    config = entries.get(projectPaths.config),
    objects = readGitObjects(
      root,
      [registry?.oid, config?.oid].filter((oid): oid is string => !!oid),
    ),
    projects = registry
      ? projectsFromData(parse(objects.get(registry.oid)?.toString() ?? ""), projectPaths.projects)
      : [],
    settings = config ? parse(objects.get(config.oid)?.toString() ?? "") : {},
    collections =
      (settings.collections as { sources?: { id: string }[] } | undefined)?.sources?.map((source) => source.id) ?? [],
    scopes = projects.map((project) => project.path),
    records: BrowserRecord[] = [];
  const ordered = [...projects].sort((a, b) => b.path.length - a.path.length);
  for (const path of entries.keys()) {
    const kind = classifyRecordPath(path, scopes, collections),
      type = kind.charter
        ? "CHARTER"
        : (kind.primary ?? (kind.policy && /\/ADR-[0-9A-Z]+\.md$/.test(path) ? "ADR" : undefined));
    if (!type) continue;
    const collection = collections.find((id) => path.startsWith(`workbench/collections/${id}/`)),
      project = ordered.find((project) =>
        path.startsWith(`${project.path === "." ? "" : project.path + "/"}workbench/`),
      ),
      scope = collection ?? project?.id,
      number = type === "CHARTER" ? "" : new RegExp(`${type}-([0-9A-Z]+)\\.[^.]+$`).exec(path)?.[1];
    if (!scope || number === undefined) continue;
    const id = `${scope}:${type}${number ? "-" + normalizedNumber(number) : ""}`;
    records.push({
      id,
      type,
      scope,
      title: id,
      summary: "",
      status: "",
      path,
      directory: root,
      editable: false,
      local: false,
      collection: !!collection,
    });
  }
  for (let offset = 0; offset < records.length; offset += 16) {
    const selected = records.slice(offset, offset + 16),
      bodies = readGitObjects(
        root,
        selected.flatMap((record) => entries.get(record.path)?.oid ?? []),
        2 * 1024 * 1024,
        { retainedBytes: 32 * 1024 * 1024 },
      );
    for (const record of selected) {
      const bytes = bodies.get(entries.get(record.path)?.oid ?? "");
      if (!bytes) continue;
      try {
        describeRecord(record, bytes.toString());
      } catch (error) {
        record.previewError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  const result = { references: new RecordLookup(records), paths: new Set(entries.keys()) };
  if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision))
    inventories.set(
      key,
      result,
      [...entries.keys()].reduce((size, path) => size + path.length * 2 + 64, 1) +
        records.reduce((size, record) => size + JSON.stringify(record).length * 2 + 256, 0),
    );
  return result;
}
