import { record, string } from "../runtime/values.mjs";
import { InvalidInput } from "../runtime/input-errors.js";
export const TaskExecution = {
  Queued: "Queued",
  Active: "Active",
  Implemented: "Implemented",
  Blocked: "Blocked",
} as const;
export type TaskExecution = (typeof TaskExecution)[keyof typeof TaskExecution];
export interface TaskQueueEntry {
  reference: string;
  state: TaskExecution;
  updated: string;
  reason?: string;
  evidence?: string;
  planDigest?: string;
}
export interface TaskQueue {
  version: 1;
  revision: number;
  entries: TaskQueueEntry[];
}
export function decodeQueue(input: unknown): TaskQueue {
  const data = record(input, "Invalid task queue");
  if (Object.keys(data).some((key) => !["version", "revision", "entries"].includes(key)))
    throw new InvalidInput("Unknown task queue field");
  if (
    data.version !== 1 ||
    !Number.isSafeInteger(data.revision) ||
    Number(data.revision) < 0 ||
    !Array.isArray(data.entries) ||
    data.entries.length > 10000
  )
    throw new InvalidInput("Invalid task queue version, revision, or entries");
  const references = new Set<string>();
  const entries = data.entries.map((input: unknown): TaskQueueEntry => {
    const entry = record(input, "Invalid task queue entry");
    if (
      Object.keys(entry).some(
        (key) => !["reference", "state", "updated", "reason", "evidence", "planDigest"].includes(key),
      )
    )
      throw new InvalidInput("Unknown task queue entry field");
    const reference = string(entry.reference, "Missing queue task reference");
    if (
      !/^[a-z][a-z0-9_-]*:(?:TSK-[0-9A-Z]+|plan\/[a-z][a-z0-9_-]{0,119})$/.test(reference) ||
      references.has(reference) ||
      !Object.values(TaskExecution).includes(entry.state as TaskExecution) ||
      typeof entry.updated !== "string" ||
      !Number.isFinite(Date.parse(entry.updated))
    )
      throw new InvalidInput("Invalid or duplicate task queue entry");
    references.add(reference);
    for (const key of ["reason", "evidence", "planDigest"] as const)
      if (
        entry[key] !== undefined &&
        (typeof entry[key] !== "string" || entry[key].length > 16384 || entry[key].includes("\0"))
      )
        throw new InvalidInput(`Invalid queue ${key}`);
    if (
      entry.state === TaskExecution.Implemented &&
      (!entry.evidence || !/^[a-f0-9]{64}$/.test(String(entry.planDigest)))
    )
      throw new InvalidInput("Implemented work requires evidence and a plan digest");
    if (entry.state === TaskExecution.Blocked && !entry.reason)
      throw new InvalidInput("Blocked work requires a reason");
    return {
      reference,
      state: entry.state as TaskExecution,
      updated: entry.updated,
      ...(entry.reason === undefined ? {} : { reason: string(entry.reason, "Invalid queue reason") }),
      ...(entry.evidence === undefined ? {} : { evidence: string(entry.evidence, "Invalid queue evidence") }),
      ...(entry.planDigest === undefined ? {} : { planDigest: string(entry.planDigest, "Invalid queue planDigest") }),
    };
  });
  return {
    version: 1,
    revision: Number(data.revision),
    entries,
  };
}
