import { InvalidInput } from "./input-errors.js";
import { isAbsolute } from "node:path";

export interface CollectionIdentity {
  id: string;
  revision: string;
  sha256: string;
  visibility: "public" | "private";
}
export interface CollectionPin extends CollectionIdentity {
  scopes: string[];
}
export interface CollectionNamespace {
  id: string;
  path: string;
  decisions: string[];
}
export interface CollectionManifest {
  schema_version: number;
  id: string;
  revision: string;
  visibility: "public" | "private";
  content_sha256: string;
  namespace: CollectionNamespace[];
  dependency: CollectionIdentity[];
  files: Record<string, string>;
}
export const collectionName = /^[a-z][a-z0-9_-]*$/;
export const collectionRevision = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const collectionHash = /^(?!0{64}$)[0-9a-f]{64}$/;

export function collectionTable(value: unknown, keys: string[], context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date)
    throw new InvalidInput(`${context}: expected a table`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new InvalidInput(`${context}: unknown field '${key}'`);
  return value as Record<string, unknown>;
}

export function validateCollectionIdentity(value: unknown, context: string, pin = false): void {
  const entry = collectionTable(value, ["id", "revision", "sha256", "visibility", ...(pin ? ["scopes"] : [])], context);
  for (const [key, pattern] of [
    ["id", collectionName],
    ["revision", collectionRevision],
    ["sha256", collectionHash],
  ] as const)
    if (typeof entry[key] !== "string" || !pattern.test(entry[key]))
      throw new InvalidInput(`${context}: invalid collection ${key}`);
  if (!["public", "private"].includes(String(entry.visibility)))
    throw new InvalidInput(`${context}: visibility must be public or private`);
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
