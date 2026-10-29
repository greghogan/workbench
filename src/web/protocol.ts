import type { CollectionReviewPlan } from "../collection-reconcile.js";
import {
  collectionName,
  collectionTable,
  validateCollectionIdentity,
  validateCollectionSource,
  type CollectionPin,
} from "../collection-schema.js";
import { InvalidInput } from "../input-errors.js";
import { relativePath } from "../paths.js";
import type { CollectionApplication, CollectionRequest } from "./collection-service.js";

const hash = /^[0-9a-f]{64}$/;
function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new InvalidInput(`${label}: expected text`);
  return value;
}
export function decodeCollectionRequest(value: unknown): CollectionRequest {
  const data = collectionTable(
    value,
    ["source", "commit", "collection", "visibility", "id", "acceptAll"],
    "collection request",
  );
  if (data.acceptAll !== undefined && typeof data.acceptAll !== "boolean")
    throw new InvalidInput("invalid collection acceptance choice");
  const source = string(data.source, "collection source");
  validateCollectionSource(source);
  const commit = string(data.commit, "collection commit");
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit))
    throw new InvalidInput("supply a full immutable collection Git commit");
  const collection = string(data.collection, "collection directory");
  relativePath(collection, "collection directory", true);
  if (data.visibility !== "public" && data.visibility !== "private")
    throw new InvalidInput("select collection visibility");
  const id = data.id === undefined ? undefined : string(data.id, "collection id");
  if (id !== undefined && !collectionName.test(id)) throw new InvalidInput("invalid collection id");
  return {
    source,
    commit,
    collection,
    visibility: data.visibility,
    ...(id === undefined ? {} : { id }),
    ...(typeof data.acceptAll === "boolean" ? { acceptAll: data.acceptAll } : {}),
  };
}
export function decodeCollectionWorkerRequest(value: unknown): { request: CollectionRequest; expected?: string } {
  const data = collectionTable(value, ["request", "expected"], "collection worker request");
  const request = decodeCollectionRequest(data.request);
  if (data.expected !== undefined && (typeof data.expected !== "string" || !hash.test(data.expected)))
    throw new InvalidInput("invalid collection review digest");
  return { request, ...(typeof data.expected === "string" ? { expected: data.expected } : {}) };
}
export type CollectionPreview = CollectionReviewPlan & { differences: Record<string, string> };
export function decodeCollectionPreview(value: unknown): CollectionPreview {
  const data = collectionTable(value, ["digest", "pin", "files", "differences"], "collection preview");
  const digest = string(data.digest, "collection digest");
  if (!hash.test(digest)) throw new InvalidInput("invalid collection preview digest");
  validateCollectionIdentity(data.pin, "collection preview identity", true);
  const pin = data.pin as CollectionPin;
  if (!Array.isArray(data.files)) throw new InvalidInput("collection preview files must be a list");
  const paths = new Set<string>();
  const files = data.files.map((value: unknown) => {
    const file = collectionTable(
      value,
      ["path", "before", "after", "before_sha256", "after_sha256"],
      "collection preview file",
    );
    const path = string(file.path, "collection preview path");
    relativePath(path, "collection preview path");
    if (paths.has(path)) throw new InvalidInput("repeated collection preview path");
    paths.add(path);
    for (const key of ["before", "after"] as const)
      if (file[key] !== null && typeof file[key] !== "string")
        throw new InvalidInput(`invalid collection preview ${key} contents`);
    for (const key of ["before_sha256", "after_sha256"] as const)
      if (file[key] !== null && (typeof file[key] !== "string" || !hash.test(file[key])))
        throw new InvalidInput(`invalid collection preview ${key}`);
    return {
      path,
      before: file.before as string | null,
      after: file.after as string | null,
      before_sha256: file.before_sha256 as string | null,
      after_sha256: file.after_sha256 as string | null,
    };
  });
  const differences = collectionTable(data.differences, [...paths], "collection preview differences");
  for (const value of Object.values(differences))
    if (typeof value !== "string") throw new InvalidInput("invalid collection preview difference");
  return { digest, pin, files, differences: differences as Record<string, string> };
}

export function decodeCollectionApplication(value: unknown): CollectionApplication {
  const data = collectionTable(value, ["id", "issues", "omitted"], "collection application");
  if (
    typeof data.id !== "string" ||
    !collectionName.test(data.id) ||
    !Array.isArray(data.issues) ||
    data.issues.some((issue: unknown) => typeof issue !== "string") ||
    !Number.isSafeInteger(data.omitted) ||
    Number(data.omitted) < 0 ||
    Buffer.byteLength(JSON.stringify(data.issues)) > 512 * 1024
  )
    throw new InvalidInput("Invalid collection application result");
  return { id: data.id, issues: data.issues as string[], omitted: Number(data.omitted) };
}
