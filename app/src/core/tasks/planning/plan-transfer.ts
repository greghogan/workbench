import type { TaskDecisionChange } from "../task-decisions.js";
import { type TransferPlan, type TransferData } from "./plan-operation-data.js";
import { maintainPlanning } from "./planning-retention.js";
import { rewritePlanReferences } from "./plan-references.js";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { relative, join } from "node:path";
import { readConfig } from "../../projects/project-configuration.js";
import { ProjectEdits } from "../../projects/project-edits.js";
import { rootOf } from "../../projects/project-context.js";
import { parseReference } from "../../records/record-files.js";
import { relativeRecordPath } from "../../records/record-identity.js";
import { reserveRecordNumber } from "../../records/record-sequences.js";
import { editRecordMetadata } from "../../records/record-document.js";
import { formatDocument } from "../../records/formatting.js";
import { relocateMarkdownLinks, markdownHeadingId } from "../../records/markdown-links.js";
import { rewrittenPlanEntries } from "./plan-updates.js";
import { readBoundedFile } from "../../runtime/file-reads.js";
import { ownedPath } from "../../runtime/paths.js";
import { InvalidInput, StateConflict } from "../../runtime/input-errors.js";
import { gitRevision } from "../../git/refs.js";
import { readGitTree, readGitObjects, writeReviewBlobs, type GitEntry } from "../../git/git-snapshot.js";
import { withRepositoryOperation } from "../../git/repository-state.js";
import { TaskGraph, parseTask, readTaskGraph } from "../task-model.js";
import { retainTaskPlanApproval } from "../task-approvals.js";
import { prepareTaskDecisionChange, applyTaskDecisionChange } from "../task-decisions.js";
import {
  changeTaskQueue,
  type QueueChange,
  TaskExecution,
  TaskReadiness,
  readTaskQueue,
  queueDigest,
  withTaskLock,
  publishTaskTransition,
  decodeQueue,
  type TaskQueue,
} from "../task-queue.js";
import { planningPaths, parsePlanReference } from "./plan-model.js";
import { planningScopes, readPlan, type PlanView } from "./planning-store.js";
import { readWorkGraph, workReference } from "./work-plans.js";
import { planClaim, readPlanOperations, writePlanOperation, type StoredPlanOperation } from "./plan-operation-store.js";
import { taskPlanDigest } from "../task-plan.js";

export type { TransferPlan, TransferData } from "./plan-operation-data.js";
export function decodeTransfer(root: string, stored: StoredPlanOperation): TransferData {
  if (stored.operation.kind !== "transfer" || stored.operation.checkout !== realpathSync.native(root))
    throw new StateConflict(`Recover this transfer in ${stored.operation.checkout}`);
  const data = stored.operation.payload,
    retained = readGitTree(root, stored.tree);
  for (const plan of data.plans) {
    const selected = parseReference(root, plan.task);
    if (selected.kind !== "TSK" || relative(root, selected.path).replaceAll("\\", "/") !== plan.path)
      throw new InvalidInput("Invalid planning transfer identity");
  }
  for (const file of data.files) {
    if (retained.get("files/" + file.path)?.oid !== file.oid || retained.get("files/" + file.path)?.mode !== file.mode)
      throw new InvalidInput("Implementation recovery differs from its captured files");
    ownedPath(root, file.path);
  }
  return data;
}
function exclusive<T>(root: string, action: () => T): T {
  return withRepositoryOperation(root, () => withTaskLock(root, action), "plan-operation");
}
function requireNoPending(root: string): void {
  const pending = readPlanOperations(root).find((entry) => !entry.operation.completed);
  if (pending)
    throw new StateConflict(
      `Recover the planning ${pending.operation.kind} in ${pending.operation.checkout} before starting another`,
    );
}
function sourceContents(view: PlanView, number: string, mapping: ReadonlyMap<string, string>): string {
  if (!view.document) throw new InvalidInput("The captured plan is incomplete");
  const map = (reference: string): string => {
    if (!reference.includes(":plan/")) return reference;
    const target = mapping.get(reference);
    if (!target) throw new StateConflict(`Implement the prerequisite ${reference} before transferring this plan`);
    return target;
  };
  const contents = editRecordMetadata(view.contents, {
    status: view.approval?.current ? "Approved" : "Planned",
    ...(view.document.metadata.parent ? { parent: map(view.document.metadata.parent) } : {}),
    ...(view.document.metadata.depends_on ? { depends_on: view.document.metadata.depends_on.map(map) } : {}),
  });
  return rewritePlanReferences(
    contents.replace(/^# [^\r\n]+/m, `# TSK-${number}: ${view.document.title.replace(/^TSK-[0-9A-Za-z]+: /, "")}`),
    mapping,
  );
}
export async function startPlan(
  root: string,
  reference: string,
  expectedQueue?: string,
  options: { onRecorded?: () => void } = {},
): Promise<string> {
  const prepared = exclusive(root, () => {
    requireNoPending(root);
    const claim = planClaim(root, reference);
    if (claim)
      throw new StateConflict(
        `Implementation already started as ${claim.task} in ${claim.operation.operation.checkout}`,
      );
    const queue = readTaskQueue(root),
      graph = readWorkGraph(root),
      selected = graph.require(reference);
    if (expectedQueue !== undefined && expectedQueue !== queueDigest(queue))
      throw new StateConflict("Task queue changed; refresh and retry");
    if (!queue.entries.some((entry) => entry.reference === reference))
      throw new InvalidInput("Add the approved plan to the local queue before starting it");
    const blockers = new TaskReadiness(graph, queue).blockers(selected);
    if (blockers.length) throw new StateConflict(blockers.map((blocker) => blocker.message).join("; "));
    const views: PlanView[] = [],
      mapping = new Map<string, string>();
    for (const operation of readPlanOperations(root))
      if (operation.operation.kind === "transfer")
        for (const plan of operation.operation.payload.plans) {
          const name = plan.reference,
            task = plan.task;
          if (graph.byReference.has(task)) mapping.set(name, task);
        }
    let next: string | undefined = reference;
    while (next?.includes(":plan/") && !mapping.has(next)) {
      if (views.some((view) => view.reference === next) || views.length >= 128)
        throw new InvalidInput("Plan parent cycle or excessive depth");
      const view = readPlan(root, parsePlanReference(next));
      if (view.problem || view.conflict) throw new StateConflict(view.problem ?? "Resolve concurrent plan changes");
      if (view.document?.metadata.status === "Canceled")
        throw new StateConflict(`Reopen canceled parent ${view.reference} before starting its child`);
      views.unshift(view);
      next = view.document?.metadata.parent ?? undefined;
    }
    if (next && ["Accepted", "Canceled"].includes(graph.require(mapping.get(next) ?? next).metadata.status))
      throw new StateConflict("Reopen the completed parent before starting new child work");
    for (const view of views)
      for (const dependency of view.document?.metadata.depends_on ?? [])
        if (
          dependency.includes(":plan/") &&
          !mapping.has(dependency) &&
          !views.some((candidate) => candidate.reference === dependency)
        )
          throw new StateConflict(`Implement the prerequisite ${dependency} before transferring this task hierarchy`);
    const scopes = new Map(planningScopes(root).map((scope) => [scope.id, scope])),
      plans = views.map((view) => {
        const scope = scopes.get(view.scope);
        if (!scope) throw new InvalidInput(`Restore the project scope ${view.scope} before starting its plans`);
        const directory = rootOf(root, scope),
          number = reserveRecordNumber(directory, "TSK", root),
          path = (scope.path === "." ? "" : scope.path + "/") + "workbench/" + relativeRecordPath("TSK", number),
          task = `${view.scope}:TSK-${number}`;
        mapping.set(view.reference, task);
        return { view, number, path, task };
      });
    return {
      queue,
      plans,
      mapping,
      width: readConfig(root).markdown?.wrap_width ?? 120,
      sourceHead: gitRevision(root, "HEAD"),
    };
  });
  const location = (view: PlanView, path: string) =>
      join(root, ".workbench-plan-transfer", view.scope, view.name, path),
    targets = new Map<string, { path: string; beforeHeading?: string; afterHeading?: string }>();
  for (const plan of prepared.plans) {
    targets.set(location(plan.view, planningPaths.document), {
      path: ownedPath(root, plan.path),
      beforeHeading: markdownHeadingId(plan.view.document?.title ?? ""),
      afterHeading: markdownHeadingId(
        `TSK-${plan.number}: ${(plan.view.document?.title ?? "").replace(/^TSK-[0-9A-Za-z]+: /, "")}`,
      ),
    });
    for (const path of plan.view.entries.keys())
      if (path.startsWith(planningPaths.files))
        targets.set(location(plan.view, path), {
          path: ownedPath(root, plan.path.slice(0, -3) + "/" + path.slice(planningPaths.files.length)),
        });
  }
  for (const plan of prepared.plans)
    for (const path of plan.view.entries.keys())
      if (path.startsWith(planningPaths.files)) {
        const alias = location(plan.view, path.slice(planningPaths.files.length)),
          target = targets.get(location(plan.view, path));
        if (target && !targets.has(alias)) targets.set(alias, target);
      }
  const mapTarget = (path: string, suffix: string) => {
    const target = targets.get(path);
    if (!target) return undefined;
    return {
      path: target.path,
      suffix:
        target.beforeHeading && suffix === "#" + target.beforeHeading
          ? "#" + (target.afterHeading ?? target.beforeHeading)
          : suffix,
    };
  };
  const documents = await Promise.all(
    prepared.plans.map(async (plan) => {
      const formatted = await formatDocument(
          sourceContents(plan.view, plan.number, prepared.mapping),
          plan.path,
          prepared.width,
        ),
        contents = await formatDocument(
          relocateMarkdownLinks(formatted, location(plan.view, planningPaths.document), ownedPath(root, plan.path), {
            mapTarget,
          }),
          plan.path,
          prepared.width,
        ),
        supportingEntries = new Map([...plan.view.entries].filter(([path]) => path.startsWith(planningPaths.files))),
        sourceEntries =
          rewrittenPlanEntries(root, supportingEntries, prepared.mapping, (path, text) =>
            path.startsWith(planningPaths.files) && /\.(?:md|markdown)$/i.test(path)
              ? relocateMarkdownLinks(
                  text,
                  location(plan.view, path),
                  ownedPath(root, plan.path.slice(0, -3) + "/" + path.slice(planningPaths.files.length)),
                  { mapTarget },
                )
              : text,
          ) ?? supportingEntries;
      return { ...plan, contents, sourceEntries };
    }),
  );
  const stored = exclusive(root, () => {
    requireNoPending(root);
    const queue = readTaskQueue(root);
    if (queueDigest(queue) !== queueDigest(prepared.queue))
      throw new StateConflict("Task queue changed while preparing implementation; retry without overwriting it");
    for (const plan of documents) {
      if (planClaim(root, plan.view.reference) || readPlan(root, plan.view).digest !== plan.view.digest)
        throw new StateConflict("A plan changed or was claimed while preparing implementation");
    }
    const blobs = writeReviewBlobs(
        root,
        documents.map((plan) => Buffer.from(plan.contents)),
      ),
      files: TransferData["files"] = [],
      attachments = new Map<string, GitEntry>(),
      plans: TransferPlan[] = [],
      decisions: TaskDecisionChange[] = [];
    for (const [index, plan] of documents.entries()) {
      const oid = blobs[index];
      if (!oid) throw new Error("Missing implementation document");
      files.push({ path: plan.path, mode: "100644", oid });
      for (const [path, entry] of plan.view.entries) {
        attachments.set(`inputs/${plan.view.scope}/${plan.view.name}/${path}`, entry);
      }
      for (const [path, entry] of plan.sourceEntries) {
        if (path.startsWith(planningPaths.files))
          files.push({ path: plan.path.slice(0, -3) + "/" + path.slice(planningPaths.files.length), ...entry });
      }
      plans.push({
        reference: plan.view.reference,
        tree: plan.view.tree,
        task: plan.task,
        path: plan.path,
        planDigest: taskPlanDigest(plan.contents),
      });
      const approvedAt = plan.view.approval?.current ? plan.view.approval.at : undefined;
      if (approvedAt) {
        const supporting = files.filter((file) => file.path.startsWith(plan.path.slice(0, -3) + "/")),
          objects = readGitObjects(
            root,
            supporting.map((file) => file.oid),
            8 * 1024 * 1024,
            { retainedBytes: 8 * 1024 * 1024 },
          ),
          snapshot = retainTaskPlanApproval(root, {
            reference: plan.task,
            at: approvedAt,
            contents: plan.contents,
            files: supporting.map((file) => {
              const contents = objects.get(file.oid);
              if (!contents) throw new InvalidInput("Supporting content is unavailable");
              return {
                name: file.path.slice(plan.path.slice(0, -3).length + 1),
                contents: contents.toString("base64"),
                executable: file.mode === "100755",
              };
            }),
          });
        decisions.push(
          prepareTaskDecisionChange(root, plan.task, (before) => [
            ...before,
            {
              reference: plan.task,
              status: "Approved",
              digest: parseTask(root, plan.task, ownedPath(root, plan.path), plan.contents).digest,
              updated: approvedAt,
              snapshot,
            },
          ]),
        );
      }
    }
    new TaskGraph([
      ...readTaskGraph(root).tasks,
      ...documents.map((plan) => parseTask(root, plan.task, ownedPath(root, plan.path), plan.contents)),
    ]).validate();
    for (const file of files) {
      if (existsSync(ownedPath(root, file.path)))
        throw new StateConflict(`Preserving an existing implementation file: ${file.path}`);
      attachments.set("files/" + file.path, { mode: file.mode, oid: file.oid });
    }
    const now = new Date().toISOString(),
      after = structuredClone(queue);
    for (const entry of after.entries) {
      const original = entry.reference,
        task = prepared.mapping.get(original);
      if (!task) continue;
      entry.reference = task;
      entry.updated = now;
      if (original === reference) {
        entry.state = TaskExecution.Active;
        delete entry.reason;
        delete entry.evidence;
      }
      const document = documents.find((plan) => plan.task === task);
      if (document) entry.planDigest = taskPlanDigest(document.contents);
    }
    after.revision++;
    decodeQueue(after);
    const payload: TransferData = {
      plans,
      files,
      before: queue,
      after,
      decisions,
      ...(prepared.sourceHead ? { sourceHead: prepared.sourceHead } : {}),
    };
    return writePlanOperation(
      root,
      {
        version: 1,
        id: randomUUID(),
        kind: "transfer",
        checkout: realpathSync.native(root),
        completed: false,
        payload: { ...payload },
      },
      attachments,
    );
  });
  options.onRecorded?.();
  return resumePlanTransfer(root, stored.operation.id);
}
export function resumePlanTransfer(root: string, id: string): string {
  return exclusive(root, () => {
    const stored = readPlanOperations(root).find((entry) => entry.operation.id === id);
    if (!stored) throw new InvalidInput("Planning transfer not found");
    const data = decodeTransfer(root, stored),
      task = data.after.entries.find(
        (entry) => entry.state === TaskExecution.Active && data.plans.some((plan) => plan.task === entry.reference),
      )?.reference;
    if (!task) throw new InvalidInput("The transferred task is not active in its recorded queue");
    if (stored.operation.completed) return task;
    for (const plan of data.plans)
      if (readPlan(root, parsePlanReference(plan.reference)).tree !== plan.tree)
        throw new StateConflict(
          `Preserve both versions of ${plan.reference}; the original plan changed during transfer`,
        );
    const queue = readTaskQueue(root);
    if (![queueDigest(data.before), queueDigest(data.after)].includes(queueDigest(queue)))
      throw new StateConflict("The local queue changed during transfer; preserve its newer progress");
    const objects = readGitObjects(
        root,
        data.files.map((file) => file.oid),
        8 * 1024 * 1024,
        { retainedBytes: 16 * 1024 * 1024 },
      ),
      edits = new ProjectEdits(root);
    for (const file of data.files) {
      const bytes = objects.get(file.oid),
        path = ownedPath(root, file.path);
      if (!bytes) throw new InvalidInput("Captured implementation content is unavailable");
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || !readBoundedFile(path, bytes.length, "implementation file").equals(bytes))
          throw new StateConflict(`Preserving changed implementation file: ${file.path}`);
      } else edits.create(file.path, bytes, file.mode === "100755" ? 0o755 : 0o644);
    }
    publishTaskTransition(root, edits, queue, data.after);
    for (const decision of data.decisions) applyTaskDecisionChange(root, decision);
    writePlanOperation(root, { ...stored.operation, completed: true }, new Map(), stored.tree);
    return task;
  });
}

export async function changeWorkQueue(root: string, change: QueueChange, expected?: string): Promise<TaskQueue> {
  if (change.action === "start" && workReference(root, change.reference).includes(":plan/")) {
    await startPlan(root, workReference(root, change.reference), expected);
    return readTaskQueue(root);
  }
  const result = changeTaskQueue(root, change, expected);
  maintainPlanning(root);
  return result;
}
