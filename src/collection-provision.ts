import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "smol-toml";
import { resolveCollections } from "./collections.js";
import { ownedPath } from "./paths.js";

/** Freeze verified local policies; shared contents already travel in the repository snapshot. */
export function provisionCollectionSnapshot(source: string, snapshot: string): void {
  const collections = resolveCollections(source).filter((entry) => entry.local);
  for (const collection of collections) {
    const destination = ownedPath(snapshot, `workbench/.collections/${collection.pin.id}/${collection.pin.revision}`);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of collection.files) {
      const output = ownedPath(destination, name);
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
    }
  }
  const registry = ownedPath(snapshot, "workbench/.collections/index.toml");
  mkdirSync(dirname(registry), { recursive: true, mode: 0o700 });
  writeFileSync(registry, stringify({ schema_version: 1, sources: collections.map((entry) => entry.pin) }), {
    flag: "wx",
    mode: 0o600,
  });
}
