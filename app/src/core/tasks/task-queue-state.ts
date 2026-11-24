import { record, string, strings } from "../runtime/values.mjs";
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
  started?: true;
  startedFrom?: string;
  reason?: string;
  evidence?: string;
  planDigest?: string;
  verification?: { tree: string; paths: string[] };
}
export interface TaskQueue {
  version: 1;
  revision: number;
  entries: TaskQueueEntry[];
}
export function decodeTaskVerification(value: unknown): NonNullable<TaskQueueEntry["verification"]> {
  const proof = record(value, "Invalid task verification");
  const tree = string(proof.tree, "Missing verification tree");
  const paths = strings(proof.paths, "Invalid verification paths");
  if (
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(tree) ||
    paths.some(
      (path) =>
        !path ||
        path.startsWith("/") ||
        path.includes("\0") ||
        path.split("/").some((part) => part === ".." || part === "." || part === ".git"),
    )
  )
    throw new InvalidInput("Invalid task verification");
  return { tree, paths };
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
        (key) =>
          ![
            "reference",
            "state",
            "updated",
            "started",
            "startedFrom",
            "reason",
            "evidence",
            "planDigest",
            "verification",
          ].includes(key),
      )
    )
      throw new InvalidInput("Unknown task queue entry field");
    const reference = string(entry.reference, "Missing queue task reference");
    if (
      !/^[a-z][a-z0-9_-]*:(?:TSK-[0-9A-Z]+|plan\/[a-z][a-z0-9_-]{0,119})$/.test(reference) ||
      references.has(reference) ||
      !Object.values(TaskExecution).includes(entry.state as TaskExecution) ||
      typeof entry.updated !== "string" ||
      !Number.isFinite(Date.parse(entry.updated)) ||
      (entry.started !== undefined && entry.started !== true) ||
      (entry.startedFrom !== undefined &&
        (typeof entry.startedFrom !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(entry.startedFrom)))
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
    const verification = entry.verification === undefined ? undefined : decodeTaskVerification(entry.verification);
    return {
      reference,
      state: entry.state as TaskExecution,
      updated: entry.updated,
      ...(entry.started === true ? { started: true as const } : {}),
      ...(entry.startedFrom === undefined ? {} : { startedFrom: entry.startedFrom }),
      ...(entry.reason === undefined ? {} : { reason: string(entry.reason, "Invalid queue reason") }),
      ...(entry.evidence === undefined ? {} : { evidence: string(entry.evidence, "Invalid queue evidence") }),
      ...(entry.planDigest === undefined ? {} : { planDigest: string(entry.planDigest, "Invalid queue planDigest") }),
      ...(verification ? { verification } : {}),
    };
  });
  return {
    version: 1,
    revision: Number(data.revision),
    entries,
  };
}
