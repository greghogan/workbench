import { ProjectHierarchy } from "../projects/project-hierarchy.js";
import { readConfig, readProjects } from "../projects/project-configuration.js";
import { syncAgents } from "./agents.js";
import { detail, kinds } from "./record-identity.js";
import { syncCollectionMap, syncProjectMap } from "./maps.js";

/** Rerunning preparation repairs these same outputs even if the source was already formatted. */
export function syncRecordOutputs(root: string, paths: readonly string[]): void {
  const projects = readProjects(root);
  const hierarchy = new ProjectHierarchy(projects);
  const collections = readConfig(root).collections?.sources ?? [];
  const maps = new Set<string>();
  const collectionMaps = new Set<string>();
  let context = false;
  for (const path of paths) {
    const collection = collections.find(
      (collection) =>
        path.startsWith(`workbench/collections/${collection.id}/decisions/`) ||
        path === `workbench/collections/${collection.id}/CHARTER.md`,
    );
    if (collection) {
      if (!path.endsWith("/CHARTER.md")) collectionMaps.add(collection.id);
      context = true;
      continue;
    }
    const project = hierarchy.recordOwner(path);
    if (project) {
      const prefix = `${project.path === "." ? "" : project.path + "/"}workbench/`;
      const name = path.slice(prefix.length);
      const kind = kinds.find((kind) => name.startsWith(detail(kind).directory + "/"));
      if (kind) maps.add(project.id + ":" + kind);
      if (name === "CHARTER.md" || kind === "ADR") context = true;
    }
  }
  for (const project of projects)
    for (const kind of kinds) if (maps.has(project.id + ":" + kind)) syncProjectMap(root, project, kind);
  for (const id of collectionMaps) syncCollectionMap(root, id);
  if (context) syncAgents(root);
}
