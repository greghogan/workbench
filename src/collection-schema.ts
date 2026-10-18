import { InvalidInput } from "./input-errors.js";
import { isAbsolute } from "node:path";
import { relativePath } from "./paths.js";

export interface CollectionIdentity {
  id: string;
  revision: string;
  sha256: string;
  visibility: "public" | "private";
}
export interface CollectionPin extends CollectionIdentity {
  scopes: string[];
  source?: string;
  commit?: string;
  collection?: string;
}
export interface CollectionManifest {
  schema_version: number;
  id: string;
  revision: string;
  visibility: "public" | "private";
  content_sha256: string;
  decisions: string[];
  files: Record<string, string>;
}
export const collectionName = /^[a-z][a-z0-9_-]*$/;
export const collectionRevision = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const collectionHash = /^(?!0{64}$)[0-9a-f]{64}$/;

/** No remote helpers or plaintext protocols; local sources must be explicit absolute paths. */
export function validateCollectionSource(source: string): void {
  if (
    !source ||
    /[\r\n\0]/.test(source) ||
    !(isAbsolute(source) || /^https:\/\/[^\s]+$/.test(source) || /^ssh:\/\/[^\s]+$/.test(source))
  )
    throw new InvalidInput("collection source must be an HTTPS/SSH Git URL or an absolute local repository path");
  if (!isAbsolute(source)) {
    const url = new URL(source);
    if (url.password || (url.protocol === "https:" && url.username))
      throw new InvalidInput("collection URLs must use runtime credentials, never embedded credentials");
  }
}

export function collectionTable(value: unknown, keys: string[], context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date)
    throw new InvalidInput(`${context}: expected a table`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new InvalidInput(`${context}: unknown field '${key}'`);
  return value as Record<string, unknown>;
}

export function validateCollectionIdentity(value: unknown, context: string, pin = false): void {
  const entry = collectionTable(
    value,
    ["id", "revision", "sha256", "visibility", ...(pin ? ["scopes", "source", "commit", "collection"] : [])],
    context,
  );
  for (const [key, pattern] of [
    ["id", collectionName],
    ["revision", collectionRevision],
    ["sha256", collectionHash],
  ] as const)
    if (typeof entry[key] !== "string" || !pattern.test(entry[key]))
      throw new InvalidInput(`${context}: invalid collection ${key}`);
  if (!["public", "private"].includes(String(entry.visibility)))
    throw new InvalidInput(`${context}: visibility must be public or private`);
  if (entry.source !== undefined && (typeof entry.source !== "string" || !entry.source.trim()))
    throw new InvalidInput(`${context}: source must be a nonempty acquisition location`);
  if (
    entry.commit !== undefined &&
    (typeof entry.commit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(entry.commit))
  )
    throw new InvalidInput(`${context}: commit must be a full immutable Git commit`);
  if (entry.collection !== undefined && typeof entry.collection !== "string")
    throw new InvalidInput(`${context}: collection must be a repository-relative path`);
  if (
    pin &&
    (!Array.isArray(entry.scopes) ||
      !entry.scopes.length ||
      entry.scopes.some((scope: unknown) => typeof scope !== "string"))
  )
    throw new InvalidInput(`${context}: scopes must be a nonempty array of registered project paths`);
}

export function validateCollectionPins(value: unknown, context: string): void {
  if (!Array.isArray(value)) throw new InvalidInput(`${context}: expected an array of collection pins`);
  const ids = new Set<string>();
  for (const pin of value) {
    validateCollectionIdentity(pin, context, true);
    const id = (pin as CollectionPin).id;
    if (ids.has(id)) throw new InvalidInput(`${context}: duplicate collection '${id}'`);
    ids.add(id);
  }
}

export function validateCollectionDirectories(value: unknown, context: string): void {
  if (!Array.isArray(value) || value.some((path: unknown) => typeof path !== "string" || !isAbsolute(path)))
    throw new InvalidInput(`${context}: expected an array of absolute collection directories`);
}

export function validateProjectCollections(value: unknown, context: string): void {
  validateCollectionPins(value, context);
  for (const pin of value as CollectionPin[]) {
    if (!pin.source || !pin.commit || pin.collection === undefined)
      throw new InvalidInput(`${context}: project collection requires source, commit, and collection`);
    relativePath(pin.collection, context, true);
    validateCollectionSource(pin.source);
  }
}
