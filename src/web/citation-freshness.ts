import { dirname, join, sep } from "node:path";
import type { WorkspaceIndex } from "../workspace-service.js";
import { inputStamp } from "../workspace-inputs.js";

/** A known citation depends on its own metadata and files, not an unrelated document refresh. */
export function citationInputsCurrent(index: WorkspaceIndex | undefined, id: string): boolean {
  const record = index?.byId.get(id),
    snapshot = index?.snapshot;
  const citation = snapshot?.documents.get(id)?.citation;
  if (!snapshot || record?.type !== "CIT" || !citation) return false;
  const path = join(record.directory, record.path),
    support = path.replace(/\.[^.]+$/, "");
  const paths = [
    path,
    join(support, "acquisition.yaml"),
    join(snapshot.root, "workbench/config.toml"),
    join(snapshot.root, "workbench/projects.toml"),
    ...citation.sources.flatMap((source) => [source.path, source.originalPath]),
  ];
  // Supporting metadata and scope configuration may live above the record.
  for (
    let directory = dirname(path);
    directory === record.directory || directory.startsWith(record.directory + sep);
    directory = dirname(directory)
  ) {
    const config = join(directory, "config.toml");
    if (snapshot.inputs.has(config)) paths.push(config);
    if (directory === record.directory) break;
  }
  if (record.collection) paths.push(...[...snapshot.inputs.keys()].filter((path) => path.endsWith("index.toml")));
  return paths.every((path) => snapshot.inputs.get(path) === inputStamp(path));
}
