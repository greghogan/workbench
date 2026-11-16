import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { relative } from "node:path";
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

const digest = (contents: string) => createHash("sha256").update(contents).digest("hex");
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
  const files = taskPlanFiles(root, task);
  return files.length ? digest(JSON.stringify([task.contents, files])) : digest(task.contents);
}
export const retainTaskPlanApproval = (root: string, snapshot: TaskPlanApproval): string =>
  retainPlanApproval(taskDecisionPath(root), snapshot);
export const readTaskPlanApproval = (root: string, decision: TaskDecision): TaskPlanApproval | undefined =>
  readPlanApproval(taskDecisionPath(root), decision);

export interface TaskApprovalView {
  at: string;
  contents: string;
  current: boolean;
  files: { name: string; change: "added" | "changed" | "removed" }[];
}
export function attachTaskPlanApprovals(root: string, tasks: TaskRecord[]): void {
  const decisions = new Map(
    readTaskDecisions(root)
      .filter((decision) => decision.status === "Approved")
      .map((decision) => [decision.reference, decision]),
  );
  for (const task of tasks) {
    if (task.archived) continue;
    const files = taskPlanFiles(root, task),
      decision = decisions.get(task.reference),
      snapshot = decision ? readTaskPlanApproval(root, decision) : undefined;
    task.reviewDigest = files.length ? digest(JSON.stringify([task.contents, files])) : task.digest;
    task.planDigest = taskPlanDigest(task.contents, files);
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
      current:
        taskPlanApprovalDigest(snapshot.contents, snapshot.files) === taskPlanApprovalDigest(task.contents, files) &&
        changes.length === 0,
      files: changes,
    };
  }
}
