import { record, string } from "../scripts/values.mjs";
import { readBoundedFile } from "./file-reads.js";
import { validateCollectionPins, type CollectionPin } from "./collection-schema.js";
const json = (path: string, limit: number): unknown =>
  JSON.parse(readBoundedFile(path, limit, "policy state").toString("utf8")) as unknown;
function pin(value: unknown): CollectionPin {
  const pins: unknown = [value];
  validateCollectionPins(pins, "policy provenance");
  const selected = pins[0];
  if (!selected) throw new Error("missing policy provenance");
  return selected;
}
export function readDraftProvenance(path: string, id: string): { source: string; pin: CollectionPin } {
  const data = record(json(path, 64 * 1024), "local collection draft provenance"),
    selected = pin(data.pin);
  if (selected.id !== id) throw new Error("invalid local collection draft provenance");
  return { source: string(data.source, "local collection source"), pin: selected };
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function readLocalReconciliation(path: string): { before: string | null; after: string; local: string } {
  const data = record(json(path, 1024 * 1024), "reconciliation report");
  if ((data.before !== null && !hash(data.before)) || !hash(data.after) || !hash(data.local))
    throw new Error("invalid reconciliation report");
  return { before: data.before, after: data.after, local: data.local };
}
export function readProjectReconciliation(path: string): {
  before?: CollectionPin;
  after: CollectionPin;
  project_sha256: string;
} {
  const data = record(json(path, 1024 * 1024), "reconciliation report");
  if (!hash(data.project_sha256)) throw new Error("invalid reconciliation report");
  return {
    ...(data.before === undefined ? {} : { before: pin(data.before) }),
    after: pin(data.after),
    project_sha256: data.project_sha256,
  };
}
