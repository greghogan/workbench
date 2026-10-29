import { dirname, extname, resolve } from "node:path";
import type { BrowserRecord } from "./record-service.js";

/** Immutable lookup tables share the lifetime of their published workspace snapshot. */
export class RecordLookup {
  private readonly ids = new Map<string, BrowserRecord>();
  private readonly paths = new Map<string, BrowserRecord>();
  private readonly owners = new Map<string, { record: BrowserRecord; order: number }>();
  constructor(records: Iterable<BrowserRecord>) {
    let order = 0;
    for (const record of records) {
      const id = record.id.toUpperCase(),
        path = resolve(record.directory, record.path);
      if (!this.ids.has(id)) this.ids.set(id, record);
      if (!this.paths.has(path)) this.paths.set(path, record);
      if (record.type !== "CHARTER") {
        const base = resolve(record.directory, record.path.slice(0, -extname(record.path).length));
        if (!this.owners.has(base)) this.owners.set(base, { record, order });
      }
      order++;
    }
  }
  record(id: string): BrowserRecord | undefined {
    return this.ids.get(id.toUpperCase());
  }
  path(path: string): BrowserRecord | undefined {
    return this.paths.get(resolve(path));
  }
  owner(path: string): BrowserRecord | undefined {
    let current = dirname(resolve(path));
    let selected: { record: BrowserRecord; order: number } | undefined;
    for (;;) {
      const owner = this.owners.get(current);
      if (owner && (!selected || owner.order < selected.order)) selected = owner;
      const parent = dirname(current);
      if (parent === current) return selected?.record;
      current = parent;
    }
  }
}
