import { recordTypes } from "../record-metadata.js";
import type { BrowserRecord } from "../record-service.js";
import { WebError } from "./errors.js";
import { recordBatchSize, recordWindowLimit } from "./record-window.js";
function recordKey(id: string) {
  const match = /^([a-z][a-z0-9_-]*):(CHARTER|ADR|TSK|EXP|ENV|CIT|REL)(?:-([0-9A-Z]+))?$/.exec(id);
  if (!match) throw new WebError(400, "invalid record cursor");
  return { scope: match[1] ?? "", type: recordTypes.findIndex((type) => type === match[2]), number: match[3] ?? "" };
}
function compare(left: ReturnType<typeof recordKey>, right: ReturnType<typeof recordKey>): number {
  return (
    left.scope.localeCompare(right.scope) ||
    left.type - right.type ||
    left.number.length - right.number.length ||
    left.number.localeCompare(right.number)
  );
}
/** Parse each identity once per query, including removed cursor identities. */
export function recordBatch(
  records: BrowserRecord[],
  after: string | null,
  through: string | null,
  before: string | null = null,
): { visible: BrowserRecord[]; more: boolean; previous: boolean; startAfter: string } {
  if (before && (after || through)) throw new WebError(400, "select either a previous or a forward record window");
  const sorted = records.map((record) => ({ record, key: recordKey(record.id) })).sort((a, b) => compare(a.key, b.key));
  const start = after ? recordKey(after) : undefined,
    end = through ? recordKey(through) : undefined,
    previous = before ? recordKey(before) : undefined;
  const remaining = sorted.filter(
    (entry) => (!start || compare(entry.key, start) > 0) && (!previous || compare(entry.key, previous) < 0),
  );
  const count = end
    ? Math.min(
        recordWindowLimit,
        Math.max(recordBatchSize, remaining.filter((entry) => compare(entry.key, end) <= 0).length),
      )
    : recordBatchSize;
  const visible = (previous ? remaining.slice(-recordBatchSize) : remaining.slice(0, count)).map(
    (entry) => entry.record,
  );
  const first = visible[0]?.id,
    last = visible.at(-1)?.id;
  return {
    visible,
    more: !!last && last !== sorted.at(-1)?.record.id,
    previous: !!first && first !== sorted[0]?.record.id,
    startAfter: sorted[sorted.findIndex((entry) => entry.record.id === first) - 1]?.record.id ?? "",
  };
}
