import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { TaskDecision } from "./task-decisions.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { record, records, string } from "../runtime/values.mjs";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { BoundedState } from "../storage/bounded-state.js";

export interface TaskPlanApproval {
  reference: string;
  at: string;
  contents: string;
  files: { name: string; contents: string; executable: boolean }[];
}
const digest = (contents: string) => createHash("sha256").update(contents).digest("hex");
export const taskPlanSnapshotLimit = 16 * 1024 * 1024;
function approval(input: unknown): TaskPlanApproval {
  const value = record(input, "Invalid approved task snapshot");
  if (Object.keys(value).some((key) => !["reference", "at", "contents", "files"].includes(key)))
    throw new InvalidInput("Unknown approved task snapshot field");
  const reference = string(value.reference, "Missing approved task reference"),
    at = string(value.at, "Missing approval time"),
    contents = string(value.contents, "Missing approved task contents");
  if (!/^[a-z][a-z0-9_-]*:TSK-[0-9A-Z]+$/.test(reference) || !Number.isFinite(Date.parse(at)))
    throw new InvalidInput("Invalid approved task identity or time");
  const names = new Set<string>();
  const files = records(value.files, "Invalid approved supporting files").map((file) => {
    const name = string(file.name, "Missing supporting file name"),
      contents = string(file.contents, "Missing supporting file contents");
    if (
      !name ||
      /[\\:\0\r\n]/.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
      names.has(name) ||
      typeof file.executable !== "boolean" ||
      Buffer.from(contents, "base64").toString("base64") !== contents ||
      Object.keys(file).some((key) => !["name", "contents", "executable"].includes(key))
    )
      throw new InvalidInput("Invalid approved supporting file");
    names.add(name);
    return { name, contents, executable: file.executable };
  });
  if (files.length > 1000) throw new InvalidInput("Too many approved supporting files");
  return { reference, at, contents, files };
}
function snapshotStore(decisionsPath: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new InvalidInput("Invalid task approval snapshot identity");
  return new BoundedState<TaskPlanApproval>(
    () => decisionsPath + ".snapshots/" + id + ".json",
    taskPlanSnapshotLimit,
    approval,
    () => {
      throw new InvalidInput("Approved task snapshot is unavailable");
    },
  );
}
export function retainPlanApproval(decisionsPath: string, snapshot: TaskPlanApproval): string {
  const checked = approval(snapshot),
    bytes = JSON.stringify(checked),
    id = digest(bytes);
  if (Buffer.byteLength(bytes) > taskPlanSnapshotLimit) throw new InvalidInput("Task approval snapshot is too large");
  snapshotStore(decisionsPath, id).write(checked);
  return id;
}
export function readPlanApproval(decisionsPath: string, decision: TaskDecision): TaskPlanApproval | undefined {
  if (!decision.snapshot) return undefined;
  const saved = snapshotStore(decisionsPath, decision.snapshot).read();
  if (
    digest(JSON.stringify(saved)) !== decision.snapshot ||
    saved.reference !== decision.reference ||
    saved.at !== decision.updated ||
    digest(saved.contents) !== decision.digest
  )
    throw new StateConflict("The retained task plan differs from its approval receipt");
  return saved;
}

/** Snapshot pointers move with their decisions; verify retained bytes before activating the relocated store. */
export function copyTaskPlanApprovals(source: string, destination: string, decisions: TaskDecision[]): void {
  for (const id of new Set(decisions.flatMap((decision) => (decision.snapshot ? [decision.snapshot] : [])))) {
    const path = `${source}.snapshots/${id}.json`,
      target = `${destination}.snapshots/${id}.json`,
      contents = readBoundedFile(path, taskPlanSnapshotLimit, "approved task snapshot"),
      decoded = approval(JSON.parse(contents.toString()) as unknown);
    if (digest(JSON.stringify(decoded)) !== id)
      throw new StateConflict("The relocated task approval snapshot has changed");
    if (existsSync(target)) {
      const current = approval(
        JSON.parse(readBoundedFile(target, taskPlanSnapshotLimit, "approved task snapshot").toString()) as unknown,
      );
      if (digest(JSON.stringify(current)) !== id)
        throw new StateConflict("A conflicting task approval snapshot exists at the destination");
    } else writeAtomic(target, contents, 0o600);
  }
}
