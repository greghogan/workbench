import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { relative } from "node:path";
import { readConfig } from "../projects/project-configuration.js";
import { taskDecisionPath, readTaskDecisions, type TaskDecision } from "./task-decisions.js";
import {
  retainPlanApproval,
  readPlanApproval,
  taskPlanSnapshotLimit,
  type TaskPlanApproval,
} from "./task-approval-store.js";
import type { TaskRecord } from "./task-model.js";
import { taskPlanDigest, taskPlanApprovalDigest } from "./task-plan.js";
import { supportingFiles } from "../records/record-service.js";
import { readBoundedFile } from "../runtime/file-reads.js";
import { ownedPath } from "../runtime/paths.js";
import { InvalidInput } from "../runtime/input-errors.js";
import { gitBytes } from "../git/git-snapshot.js";
import { taskRepositoryDirectory } from "./task-project-state.js";
import { transferredFileModes } from "./planning/plan-operation-store.js";

import { acceptedTaskVersion, taskOutcomeDigest } from "./task-snapshot.js";

function canonicalFileModes(root: string): Map<string, string> | undefined {
  if (!taskRepositoryDirectory(root)) return;
  const mode = spawnSync("git", ["-C", root, "config", "--bool", "--get", "core.filemode"], { encoding: "utf8" });
  if (mode.error || (mode.status !== 0 && mode.status !== 1))
    throw new InvalidInput("Cannot inspect Git file mode policy", { cause: mode.error ?? new Error(mode.stderr) });
  if (mode.status === 1 || mode.stdout.trim() === "true") return;
  const modes = transferredFileModes(root);
  for (const row of gitBytes(root, ["ls-files", "--stage", "-z"]).toString().split("\0").filter(Boolean)) {
    const separator = row.indexOf("\t"),
      fields = row.slice(0, separator).split(" ");
    if (separator < 0 || fields.length !== 3) throw new InvalidInput("Cannot inspect Git file modes");
    if (fields[2] === "0" && fields[0]) modes.set(row.slice(separator + 1), fields[0]);
  }
  return modes;
}
export function taskPlanFiles(root: string, task: Pick<TaskRecord, "path">): TaskPlanApproval["files"] {
  const path = relative(root, task.path).replaceAll("\\", "/"),
    base = path.slice(0, -3) + "/";
  const files = supportingFiles({ type: "TSK", path, directory: root });
  if (!files.length) return [];
  const modes = canonicalFileModes(root);
  let bytes = 0;
  return files
    .map((file) => {
      bytes += file.size;
      if (bytes > taskPlanSnapshotLimit / 2)
        throw new InvalidInput("Task supporting files exceed the approval snapshot limit");
      const location = ownedPath(root, file.path),
        contents = readBoundedFile(location, file.size, "task supporting file");
      return {
        name: file.path.slice(base.length),
        contents: contents.toString("base64"),
        executable: modes ? modes.get(file.path) === "100755" : (lstatSync(location).mode & 0o111) !== 0,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
export function taskReviewVersion(root: string, task: Pick<TaskRecord, "path" | "contents">): string {
  return taskOutcomeDigest(task.contents, taskPlanFiles(root, task));
}
export const retainTaskPlanApproval = (root: string, snapshot: TaskPlanApproval): string =>
  retainPlanApproval(taskDecisionPath(root), snapshot);
export const readTaskPlanApproval = (root: string, decision: TaskDecision): TaskPlanApproval | undefined =>
  readPlanApproval(taskDecisionPath(root), decision);

export interface TaskApprovalView {
  at: string;
  contents: string;
  current: boolean;
  source?: TaskDecision["source"];
  files: { name: string; change: "added" | "changed" | "removed" }[];
}
export function attachTaskDecisions(root: string, tasks: TaskRecord[]): void {
  const approvals = new Map<string, TaskDecision>();
  const accepted = new Map<string, TaskDecision[]>();
  const enforce = readConfig(root).review?.task_approvals === true;
  for (const decision of readTaskDecisions(root)) {
    if (decision.status === "Approved") approvals.set(decision.reference, decision);
    else if (enforce) {
      const outcomes = accepted.get(decision.reference) ?? [];
      outcomes.push(decision);
      accepted.set(decision.reference, outcomes);
    }
  }
  for (const task of tasks) {
    if (task.archived) continue;
    const files = taskPlanFiles(root, task),
      decision = approvals.get(task.reference),
      snapshot = decision ? readTaskPlanApproval(root, decision) : undefined;
    task.reviewDigest = taskOutcomeDigest(task.contents, files);
    task.planDigest = taskPlanDigest(task.contents, files);
    // Only a task with a local acceptance decision can enter this renewal workflow.
    if (
      task.metadata.status === "Accepted" &&
      accepted
        .get(task.reference)
        ?.some(
          (outcome) => outcome.digest === task.digest && acceptedTaskVersion(root, outcome) === task.reviewDigest,
        ) === false
    )
      task.acceptanceNeedsReview = true;
    if (!snapshot) continue;
    const previous = new Map(snapshot.files.map((file) => [file.name, file])),
      current = new Map(files.map((file) => [file.name, file]));
    const changes = [...new Set([...previous.keys(), ...current.keys()])]
      .sort()
      .flatMap((name): TaskApprovalView["files"] => {
        const before = previous.get(name),
          after = current.get(name);
        if (!before) return [{ name, change: "added" }];
        if (!after) return [{ name, change: "removed" }];
        return before.contents !== after.contents || before.executable !== after.executable
          ? [{ name, change: "changed" }]
          : [];
      });
    task.approval = {
      at: snapshot.at,
      contents: snapshot.contents,
      ...(decision?.source ? { source: decision.source } : {}),
      current:
        taskPlanApprovalDigest(snapshot.contents, snapshot.files) === taskPlanApprovalDigest(task.contents, files) &&
        changes.length === 0,
      files: changes,
    };
  }
}
