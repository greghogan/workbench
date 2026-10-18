import { policyCompatibility, projectPolicyFingerprint } from "./policy-compatibility.js";
import { installedContext } from "./local-context.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "smol-toml";
import { resolveLocalCollections } from "./collections.js";
import { ownedPath } from "./paths.js";

/** Freeze verified local policies; shared contents already travel in the repository snapshot. */
export function provisionCollectionSnapshot(source: string, snapshot: string): void {
  const review = policyCompatibility(source);
  const collections = resolveLocalCollections(source).filter(
    (entry, index, all) => all.findIndex((candidate) => candidate.pin.id === entry.pin.id) === index,
  );
  if (collections.length && (review.status !== "current" || projectPolicyFingerprint(snapshot) !== review.project))
    throw new Error("snapshot policies differ from the reviewed context; review the intended tree before execution");
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
  writeFileSync(
    ownedPath(snapshot, "workbench/.collections/AGENTS.md"),
    installedContext(join(snapshot, "workbench/.collections")).contents,
    { flag: "wx", mode: 0o600 },
  );
  if (collections.length)
    writeFileSync(
      ownedPath(snapshot, "workbench/.collections/compatibility.json"),
      JSON.stringify({
        digest: review.digest,
        project: review.project,
        local: review.local,
        reviewed: true,
        inherited_from: review.receipt,
      }),
      { flag: "wx", mode: 0o600 },
    );
}
