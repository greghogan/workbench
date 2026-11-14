import { proseRecordErrors } from "./record-content.js";
import { recordDocument } from "./record-document.js";
import type { ArchivedKind } from "./archive-index.js";

export interface ArchiveCandidate {
  path: string;
  scopePath: string;
  kind: ArchivedKind;
  number: string;
  contents: string;
  reviewed: boolean;
}
export interface ArchiveGroup {
  scopePath: string;
  kind: ArchivedKind;
  first: string;
  last: string;
  complete: boolean;
  eligible: boolean;
  blockers: string[];
  paths: string[];
}
export function recordOrdinal(number: string): bigint {
  let result = 0n;
  for (const digit of number) {
    const value = parseInt(digit, 36);
    if (!Number.isInteger(value) || value < 0 || value >= 36) throw new Error("Invalid record number");
    result = result * 36n + BigInt(value);
  }
  return result;
}
export function archiveGroups(candidates: readonly ArchiveCandidate[], groupSize = 1296): ArchiveGroup[] {
  if (!Number.isSafeInteger(groupSize) || groupSize <= 0)
    throw new Error("Archive group size must be a positive integer");
  const groups = new Map<string, ArchiveGroup>();
  const highest = new Map<string, bigint>();
  const size = BigInt(groupSize);
  for (const item of candidates) {
    const prefix = `${item.scopePath}:${item.kind}`;
    const ordinal = recordOrdinal(item.number);
    highest.set(prefix, ordinal > (highest.get(prefix) ?? -1n) ? ordinal : (highest.get(prefix) ?? -1n));
    const first = (ordinal / size) * size,
      last = first + size - 1n;
    const key = `${prefix}:${first.toString()}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        scopePath: item.scopePath,
        kind: item.kind,
        first: first.toString(36).toUpperCase(),
        last: last.toString(36).toUpperCase(),
        complete: false,
        eligible: true,
        blockers: [],
        paths: [],
      };
      groups.set(key, group);
    }
    group.paths.push(item.path);
    try {
      const status = recordDocument(item.kind, item.contents, item.path).metadata.status;
      group.blockers.push(...proseRecordErrors(item.kind, item.number, item.path, item.contents));
      if (!(item.kind === "TSK" ? ["Accepted", "Canceled"] : ["Accepted", "Rejected", "Inconclusive"]).includes(status))
        group.blockers.push(`${item.path}: ${status}`);
      else if (!item.reviewed)
        group.blockers.push(`${item.path}: completion is not human-reviewed in committed history`);
    } catch (failure) {
      group.blockers.push(`${item.path}: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    group.eligible = group.blockers.length === 0;
  }
  for (const group of groups.values())
    group.complete = (highest.get(`${group.scopePath}:${group.kind}`) ?? -1n) >= recordOrdinal(group.last);
  return [...groups.values()].sort(
    (a, b) =>
      a.scopePath.localeCompare(b.scopePath) ||
      a.kind.localeCompare(b.kind) ||
      (recordOrdinal(a.first) < recordOrdinal(b.first) ? -1 : 1),
  );
}
