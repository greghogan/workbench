import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readText, writeAtomic } from "./core.js";
import { ownedPath } from "./paths.js";
import { withCacheLock } from "./cache-lock.js";

export interface ImageObservation {
  inputs: string;
  manifest: unknown;
  image: string;
  reference: string;
  verified: string;
  published?: string;
  publishedAt?: string;
}
export interface ImageCatalog {
  version: 1;
  images: ImageObservation[];
}
const digest = /^[a-f0-9]{64}$/;

/** History is project data. Deleting a Docker image never deletes its preparation record. */
export function imageCatalog(root: string): ImageCatalog {
  const path = ownedPath(root, "workbench/image-catalog.json");
  if (!existsSync(path)) return { version: 1, images: [] };
  const value = JSON.parse(readText(path)) as { version: number; images: ImageObservation[] };
  if (value.version !== 1 || !Array.isArray(value.images)) throw new Error("Invalid image catalog");
  for (const entry of value.images) validateObservation(entry);
  return { version: 1, images: value.images };
}

function validateObservation(entry: ImageObservation): void {
  if (
    !digest.test(entry.inputs) ||
    !/^sha256:[a-f0-9]{64}$/.test(entry.image) ||
    typeof entry.reference !== "string" ||
    !entry.reference ||
    !Number.isFinite(Date.parse(entry.verified)) ||
    createHash("sha256").update(JSON.stringify(entry.manifest)).digest("hex") !== entry.inputs ||
    (entry.published !== undefined &&
      (!/@sha256:[a-f0-9]{64}$/.test(entry.published) ||
        !entry.publishedAt ||
        !Number.isFinite(Date.parse(entry.publishedAt))))
  )
    throw new Error("Invalid image catalog observation or input digest");
}

export async function recordImage(root: string, observation: ImageObservation): Promise<void> {
  validateObservation(observation);
  const path = ownedPath(root, "workbench/image-catalog.json");
  mkdirSync(dirname(path), { recursive: true });
  await withCacheLock(path, () => {
    const catalog = imageCatalog(root);
    const exists = catalog.images.some(
      (entry) =>
        entry.inputs === observation.inputs &&
        entry.image === observation.image &&
        entry.reference === observation.reference &&
        entry.published === observation.published,
    );
    if (!exists) catalog.images.push(observation);
    writeAtomic(path, `${JSON.stringify(catalog, null, 2)}\n`);
    return Promise.resolve();
  });
}
