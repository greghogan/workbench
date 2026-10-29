import { collectionOriginals } from "../collection-git.js";
import type { ResolvedCollection } from "../collections.js";
import { relativeRecordPath } from "../record-identity.js";
import { recordBytes, type BrowserRecord } from "../record-service.js";
interface DecisionIdentity {
  id: string;
  path: string;
}
export type ComparedDecision = DecisionIdentity &
  (
    | { status: "unchanged" | "modified"; before: string; after: string }
    | { status: "added"; before: undefined; after: string }
    | { status: "removed"; before: string; after: undefined }
  );
export type CollectionComparison = { revision: string } & (
  | { state: "compared"; decisions: ComparedDecision[] }
  | { state: "published" | "originals-unavailable" | "read-error"; message: string }
);
/** Originals are verified once and retained only as a bounded, disposable display cache. No acquisition occurs here. */
export class CollectionComparisons {
  private readonly cache = new Map<string, { key: string; files: Map<string, Buffer> }>();
  compare(root: string, collection: ResolvedCollection, records: BrowserRecord[]): CollectionComparison {
    try {
      if (collection.local)
        return {
          state: "published",
          message: "Published local collection; no project adaptations.",
          revision: collection.pin.revision,
        };
      const key = JSON.stringify(collection.pin);
      let original = this.cache.get(collection.pin.id);
      if (original?.key !== key) {
        let acquired;
        try {
          acquired = collectionOriginals(root, collection.pin);
        } catch (error) {
          return {
            state: "originals-unavailable",
            revision: collection.pin.revision,
            message: `${String(error)}. Originals are never fetched automatically; run workbench collection fetch ${collection.pin.id} if needed, then refresh.`,
          };
        }
        const files = new Map(
          [...acquired.files].filter(([path]) =>
            /^workbench\/decisions\/(?:[0-9A-Z]{2}\/)*ADR-[0-9A-Z]+\.md$/.test(path),
          ),
        );
        original = { key, files };
        if ([...files.values()].reduce((total, bytes) => total + bytes.length, 0) <= 4 * 1024 * 1024) {
          if (this.cache.size >= 4) {
            const oldest = this.cache.keys().next().value;
            if (oldest) this.cache.delete(oldest);
          }
          this.cache.set(collection.pin.id, original);
        }
      }
      const current = records.filter(
        (record) => record.collection && record.scope === collection.pin.id && record.type === "ADR",
      );
      const entries = new Map<string, { before?: Buffer; after?: Buffer }>();
      for (const [path, bytes] of original.files) entries.set(path.slice("workbench/".length), { before: bytes });
      for (const record of current) {
        const number = record.id.split(":ADR-")[1];
        if (!number) throw new Error("invalid decision identity");
        const path = relativeRecordPath("ADR", number).replaceAll("\\", "/");
        entries.set(path, { ...entries.get(path), after: recordBytes(record) });
      }
      return {
        state: "compared",
        revision: collection.pin.commit ?? collection.pin.revision,
        decisions: [...entries].map(([path, entry]) => {
          const number = /ADR-([0-9A-Z]+)\.md$/.exec(path)?.[1]?.replace(/^0+(?=.)/, "");
          const identity = { id: `${collection.pin.id}:ADR-${number ?? ""}`, path };
          if (entry.before === undefined) {
            if (entry.after === undefined) throw new Error("comparison has no file contents");
            return { ...identity, status: "added", before: undefined, after: entry.after.toString("utf8") };
          }
          if (entry.after === undefined)
            return { ...identity, status: "removed", before: entry.before.toString("utf8"), after: undefined };
          return {
            ...identity,
            status: entry.before.equals(entry.after) ? "unchanged" : "modified",
            before: entry.before.toString("utf8"),
            after: entry.after.toString("utf8"),
          };
        }),
      };
    } catch (error) {
      return {
        state: "read-error",
        message: `Cannot read current collection decisions: ${String(error)}`,
        revision: collection.pin.revision,
      };
    }
  }
}
