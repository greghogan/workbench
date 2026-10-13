import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolveCollections } from "./collections.js";
import { ownedPath } from "./paths.js";

export const collectionLink = (root: string, id: string, revision: string) =>
  join(root, "workbench/.collections", id, revision);

export function collectionContextDirectory(
  root: string,
  id: string,
  revision: string,
  namespacePath: string,
  directory: string,
): string {
  const inside = relative(root, directory);
  if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return directory;
  const dependency = join(root, ".workbench/collections", id, revision, namespacePath);
  if (existsSync(dependency) && realpathSync(dependency) === realpathSync(directory)) return dependency;
  return join(collectionLink(root, id, revision), namespacePath);
}

/** Stable project links keep generated context independent of each machine's installed location. */
export function syncCollectionLinks(root: string, checkOnly = false): string[] {
  const changed: string[] = [];
  for (const collection of resolveCollections(root, false)) {
    const path = collectionLink(root, collection.pin.id, collection.pin.revision);
    if (
      collectionContextDirectory(root, collection.pin.id, collection.pin.revision, ".", collection.directory) !== path
    )
      continue;
    ownedPath(root, `workbench/.collections/${collection.pin.id}`);
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (info) {
      if (!info.isSymbolicLink() || !existsSync(path) || realpathSync(path) !== realpathSync(collection.directory))
        throw new Error(`${path}: preserve existing data; collection link conflicts with the selected installation`);
      continue;
    }
    if (checkOnly) throw new Error(`${path}: collection link is missing; run 'workbench sync'`);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(collection.directory, path, process.platform === "win32" ? "junction" : "dir");
    changed.push(path);
  }
  return changed;
}
