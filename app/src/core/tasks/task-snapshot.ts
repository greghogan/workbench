import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readGitObjects, readGitTree, type GitEntry } from "../git/git-snapshot.js";
import { gitAncestor, gitRevision } from "../git/refs.js";
import { projectsFromData } from "../projects/project-configuration.js";
import { projectPaths } from "../projects/project-paths.js";
import { logicalRecordEntries } from "../records/archive-store.js";
import { parseProseRecord, recordDocument } from "../records/record-document.js";
import { normalizedNumber, relativeRecordPath } from "../records/record-identity.js";
import { InvalidInput } from "../runtime/input-errors.js";
import { WeightedCache } from "../storage/weighted-cache.js";
import { taskPlanSnapshotLimit, type TaskPlanApproval } from "./task-approval-store.js";
import type { TaskDecision } from "./task-decisions.js";
import { taskVerification, taskVerificationApplies } from "./task-implementations.js";
import type { TaskRecord } from "./task-model.js";
import type { TaskQueueEntry } from "./task-queue-state.js";
import { taskPlanApprovalDigest } from "./task-plan.js";

export const taskDigest = (contents: string): string => createHash("sha256").update(contents).digest("hex");

export function taskOutcomeDigest(contents: string, files: TaskPlanApproval["files"]): string {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return taskDigest(sorted.length ? JSON.stringify([contents, sorted]) : contents);
}

function snapshotSupportingFiles(root: string, prefix: string, files: [string, GitEntry][]): TaskPlanApproval["files"] {
  const limit = taskPlanSnapshotLimit / 2;
  if (files.length > 1000) throw new InvalidInput("Task has too many supporting files");
  const objects = readGitObjects(
    root,
    files.map(([, entry]) => entry.oid),
    limit,
    { retainedBytes: limit },
  );
  let remaining = limit;
  return files.map(([name, entry]) => {
    const bytes = objects.get(entry.oid);
    if (!bytes || !["100644", "100755"].includes(entry.mode))
      throw new InvalidInput(`Invalid task supporting file: ${name}`);
    remaining -= bytes.length;
    if (remaining < 0) throw new InvalidInput("Task supporting files exceed the snapshot limit");
    return { name: name.slice(prefix.length), contents: bytes.toString("base64"), executable: entry.mode === "100755" };
  });
}

interface SnapshotTask {
  path: string;
  contents: string;
  status: string;
  digest: string;
  workDigest: string;
  mode: string;
  files: () => TaskPlanApproval["files"];
  planScope: () => string;
  outcome: () => string;
}
export function treeTasks(root: string, tree: string, reference?: string): Map<string, SnapshotTask> {
  const entries = logicalRecordEntries(root, readGitTree(root, tree));
  const config = entries.get(projectPaths.projects);
  if (!config) return new Map();
  const configuration = readGitObjects(root, [config.oid]).get(config.oid);
  if (!configuration) throw new InvalidInput("Missing committed project scopes");
  const projects = projectsFromData(parseToml(configuration.toString()), projectPaths.projects);
  const [scope, number] = reference?.split(":TSK-") ?? [];
  const selected = scope ? projects.filter((project) => project.id === scope) : projects;
  const taskPath = (project: (typeof projects)[number], digits: string) =>
    `${project.path === "." ? "" : project.path + "/"}workbench/${relativeRecordPath("TSK", digits).replaceAll("\\", "/")}`;
  const taskPaths = number
    ? selected.map((project) => taskPath(project, number)).filter((path) => entries.has(path))
    : [...entries.keys()].filter((path) => /(?:^|\/)workbench\/tasks\/(?:[0-9A-Z]{2}\/)*TSK-[0-9A-Z]+\.md$/.test(path));
  const blobs = readGitObjects(
    root,
    taskPaths.map((path) => entries.get(path)?.oid ?? ""),
  );
  const result = new Map<string, SnapshotTask>();
  for (const project of selected) {
    for (const path of taskPaths) {
      const digits = /TSK-([0-9A-Z]+)\.md$/.exec(path)?.[1];
      if (!digits || taskPath(project, digits) !== path) continue;
      const id = `${project.id}:TSK-${normalizedNumber(digits)}`;
      if (reference && reference !== id) continue;
      const contents = blobs.get(entries.get(path)?.oid ?? "")?.toString();
      if (contents === undefined) throw new InvalidInput(`Missing task: ${path}`);
      const parsed = parseProseRecord(contents, path),
        prefix = path.slice(0, -3) + "/",
        files = [...entries].filter(([name]) => name.startsWith(prefix)),
        workDigest = taskDigest(
          JSON.stringify([
            Object.fromEntries(Object.entries(parsed.metadata).filter(([key]) => key !== "status")),
            parsed.body,
            files.map(([name, entry]) => [name, entry.mode, entry.oid]),
          ]),
        );
      let supporting: TaskPlanApproval["files"] | undefined;
      const supportingFiles = () => {
        supporting ??= snapshotSupportingFiles(root, prefix, files);
        return supporting;
      };
      result.set(id, {
        path,
        contents,
        status: recordDocument("TSK", contents, path).metadata.status,
        digest: taskDigest(contents),
        workDigest,
        mode: entries.get(path)?.mode ?? "",
        files: supportingFiles,
        planScope: () => taskPlanApprovalDigest(contents, supportingFiles()),
        outcome: () => taskOutcomeDigest(contents, supportingFiles()),
      });
    }
  }
  return result;
}

export function taskOutcomeVerificationApplies(
  root: string,
  task: TaskRecord,
  proof: NonNullable<TaskQueueEntry["verification"]>,
): boolean {
  const implementation = task.implementation;
  if (implementation?.tree !== proof.tree) return taskVerificationApplies(root, proof);
  try {
    const head = gitRevision(root, "HEAD");
    if (!head || (head !== implementation.baseline && !gitAncestor(root, implementation.baseline, head))) return false;
    const outcome = treeTasks(root, proof.tree, task.reference).get(task.reference)?.outcome();
    if (!outcome || outcome !== (task.reviewDigest ?? task.digest)) return false;
    // Later work may edit this delivery's source without changing the outcome being reviewed.
    return (
      head === implementation.baseline ||
      treeTasks(root, head, task.reference).get(task.reference)?.outcome() === outcome
    );
  } catch {
    return false;
  }
}

export function observeTaskVerifications(
  root: string,
  tasks: readonly TaskRecord[],
  entries: readonly TaskQueueEntry[],
  observe?: (path: string) => void,
): void {
  const queue = new Map(entries.map((entry) => [entry.reference, entry]));
  for (const task of tasks) {
    if (task.metadata.status !== "Approved" && !task.acceptanceNeedsReview) continue;
    const proof = taskVerification(task, queue.get(task.reference));
    if (!proof) continue;
    if (observe) for (const path of proof.paths) observe(join(root, path));
    if (!taskOutcomeVerificationApplies(root, task, proof)) task.verificationStale = true;
  }
}

const legacyOutcomes = new WeightedCache<string>(2 * 1024 * 1024);

/** Older receipts identify the accepted material through their immutable Git trees. */
export function acceptedTaskVersion(root: string, decision: TaskDecision): string | undefined {
  if (decision.status !== "Accepted") return;
  if (decision.outcome) return decision.outcome;
  if (!decision.tree) return;
  const key = JSON.stringify([resolve(root), decision.tree, decision.reference, decision.digest]);
  const cached = legacyOutcomes.get(key);
  if (cached) return cached;
  if (!gitRevision(root, `${decision.tree}^{tree}`)) return;
  const recorded = treeTasks(root, decision.tree, decision.reference).get(decision.reference);
  if (recorded?.status !== "Accepted" || recorded.digest !== decision.digest) return;
  const outcome = recorded.outcome();
  legacyOutcomes.set(key, outcome, key.length * 2 + 256);
  return outcome;
}
