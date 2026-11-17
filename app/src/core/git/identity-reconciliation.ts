import { pendingCommitReviews } from "../review/review-units.js";
import { normalizedNumber } from "../records/record-identity.js";
import { preserveTranslatedReviews } from "../review/review-service.js";
import { readGitObjects, readGitTree, gitBytes } from "./git-snapshot.js";
import { logicalRecordEntries } from "../records/archive-store.js";
import { remapAgentTasks } from "../review/agent-review.js";
import { treeTasks } from "../tasks/task-snapshot.js";
import { StateConflict } from "../runtime/input-errors.js";
import { taskPlanDigest } from "../tasks/task-plan.js";
import { taskDigest } from "../tasks/task-model.js";
import { readTaskDecisions, prepareTaskDecisionChange, applyTaskDecisionChange } from "../tasks/task-decisions.js";
import { readTaskPlanApproval, retainTaskPlanApproval } from "../tasks/task-approvals.js";
import { withTaskLock, readTaskQueue, writeTaskQueue, TaskExecution } from "../tasks/task-queue.js";
import { readPlans } from "../tasks/planning/planning-store.js";
import { rewrittenPlanEntries } from "../tasks/planning/plan-updates.js";
import { preparePlanDraftUpdates } from "../tasks/planning/planning-operations.js";
import { rewritePlanReferences } from "../tasks/planning/plan-references.js";

/** A candidate match is only a proposal; the complete transformed document must also match exactly. */
const shape = (text: string) => text.replace(/TSK-[0-9A-Z]+/g, "TSK-@");
export function reconcileTaskIdentities(
  root: string,
  before: string,
  after: string,
  options: { allowMissing?: boolean } = {},
): void {
  const old = treeTasks(root, before),
    current = treeTasks(root, after),
    oldEntries = logicalRecordEntries(root, readGitTree(root, before)),
    newEntries = logicalRecordEntries(root, readGitTree(root, after)),
    objects = readGitObjects(
      root,
      [
        ...new Set(
          [...old.values()]
            .map((task) => oldEntries.get(task.path)?.oid ?? "")
            .concat([...current.values()].map((task) => newEntries.get(task.path)?.oid ?? "")),
        ),
      ],
      2 * 1024 * 1024,
      { retainedBytes: 32 * 1024 * 1024 },
    ),
    body = (path: string, entries: typeof oldEntries) => objects.get(entries.get(path)?.oid ?? "")?.toString() ?? "",
    mapping = new Map<string, string>();
  for (const [reference, task] of old) {
    const contents = body(task.path, oldEntries),
      unchanged = current.get(reference);
    if (unchanged && body(unchanged.path, newEntries) === contents) continue;
    const candidates = [...current].filter(
      ([candidate, item]) => candidate !== reference && shape(body(item.path, newEntries)) === shape(contents),
    );
    if (candidates.length > 1)
      throw new StateConflict(
        `Ambiguous task identity after integration: ${reference}. Resolve the records and their references before continuing.`,
      );
    const selected = candidates[0];
    if (selected) mapping.set(reference, selected[0]);
    else if (!unchanged && !options.allowMissing)
      throw new StateConflict(`Integration lost ${reference}; preserve or reconcile its record before continuing`);
  }
  if (!mapping.size) return;
  if (new Set(mapping.values()).size !== mapping.size)
    throw new StateConflict("Task renumbering is ambiguous; preserve both identities before continuing");
  const transform = (contents: string, scope: string) => {
    let result = rewritePlanReferences(contents, mapping);
    const local = new Map(
      [...mapping]
        .filter(([reference]) => reference.startsWith(scope + ":"))
        .map(([reference, target]) => [reference.split(":")[1] ?? "", target.split(":")[1] ?? ""]),
    );
    result = result.replace(/(?<![\p{L}\p{N}_:-])TSK-([0-9A-Z]+)(?![\p{L}\p{N}_-])/gu, (reference, digits: string) => {
      const key = `TSK-${normalizedNumber(digits)}`,
        target = local.get(key);
      if (!target) return reference;
      return digits.startsWith("0") && digits.length > 1
        ? `TSK-${target.slice(4).padStart(digits.length, "0")}`
        : target;
    });
    return result;
  };
  for (const [reference, target] of mapping) {
    const previous = old.get(reference),
      next = current.get(target);
    if (
      !previous ||
      !next ||
      transform(body(previous.path, oldEntries), reference.split(":")[0] ?? "") !== body(next.path, newEntries)
    )
      throw new StateConflict(
        `Task meaning changed while renumbering ${reference}; review the resulting plan before continuing`,
      );
    const priorFiles = [...oldEntries].filter(([path]) => path.startsWith(previous.path.slice(0, -3) + "/"));
    const nextFiles = [...newEntries].filter(([path]) => path.startsWith(next.path.slice(0, -3) + "/"));
    if (priorFiles.length !== nextFiles.length)
      throw new StateConflict(`Supporting files changed while renumbering ${reference}`);
    for (const [path, entry] of priorFiles) {
      const destination = next.path.slice(0, -3) + path.slice(previous.path.length - 3);
      if (newEntries.get(destination)?.oid !== entry.oid || newEntries.get(destination)?.mode !== entry.mode)
        throw new StateConflict(`Supporting file changed while renumbering ${reference}: ${path}`);
    }
  }
  withTaskLock(root, () => {
    for (const [reference, target] of mapping) {
      const next = current.get(target);
      if (!next) throw new StateConflict("Task identity disappeared");
      for (const decision of readTaskDecisions(root).filter(
        (decision) => decision.reference === reference && decision.status === "Approved",
      )) {
        const approved = readTaskPlanApproval(root, decision);
        if (!approved) continue;
        const contents = transform(approved.contents, reference.split(":")[0] ?? "");
        const files = [...newEntries].filter(([path]) => path.startsWith(next.path.slice(0, -3) + "/")),
          bytes = readGitObjects(
            root,
            files.map(([, entry]) => entry.oid),
            8 * 1024 * 1024,
            { retainedBytes: 16 * 1024 * 1024 },
          ),
          actual = files.map(([path, entry]) => ({
            name: path.slice(next.path.length - 2),
            contents: bytes.get(entry.oid)?.toString("base64") ?? "",
            executable: entry.mode === "100755",
          }));
        if (taskPlanDigest(contents, approved.files) !== taskPlanDigest(body(next.path, newEntries), actual)) continue;
        if (
          readTaskDecisions(root).some((candidate) => {
            if (candidate.reference !== target || candidate.status !== "Approved") return false;
            const existing = readTaskPlanApproval(root, candidate);
            return (
              !!existing &&
              taskPlanDigest(existing.contents, existing.files) === taskPlanDigest(contents, approved.files)
            );
          })
        )
          continue;
        const snapshot = retainTaskPlanApproval(root, { ...approved, reference: target, contents });
        const change = prepareTaskDecisionChange(root, target, (decisions) => [
          ...decisions,
          { ...decision, reference: target, digest: taskDigest(contents), snapshot },
        ]);
        applyTaskDecisionChange(root, change);
      }
    }
    const queue = readTaskQueue(root);
    let changed = false;
    const destinations = queue.entries.map((entry) => mapping.get(entry.reference) ?? entry.reference);
    if (new Set(destinations).size !== destinations.length)
      throw new StateConflict("Resolve duplicate queue entries before completing integration");
    for (const entry of queue.entries) {
      const target = mapping.get(entry.reference);
      if (!target) continue;
      entry.reference = target;
      entry.updated = new Date().toISOString();
      if (entry.state === TaskExecution.Implemented) {
        entry.state = TaskExecution.Blocked;
        entry.reason = "Reverify implementation after integration";
        delete entry.evidence;
        delete entry.planDigest;
      }
      changed = true;
    }
    if (changed) {
      queue.revision++;
      writeTaskQueue(root, queue);
    }
  });
  remapAgentTasks(root, mapping, after);
  const changes = readPlans(root).flatMap((plan) => {
    const entries = rewrittenPlanEntries(root, plan.entries, mapping);
    return entries ? [{ identity: plan, expected: plan.digest, entries }] : [];
  });
  const commands = changes.length ? preparePlanDraftUpdates(root, changes) : [];
  preserveTranslatedReviews(
    root,
    pendingCommitReviews(root, before),
    pendingCommitReviews(root, after),
    (contents, path) => {
      const scope =
        [...old.keys()]
          .find((reference) => {
            const item = old.get(reference);
            return (
              item &&
              (path.startsWith((item.path.split("/workbench/")[0] ?? "") + "/workbench/") ||
                (!item.path.includes("/workbench/") && path.startsWith("workbench/")))
            );
          })
          ?.split(":")[0] ?? "";
      return transform(contents, scope);
    },
  );
  if (commands.length) gitBytes(root, ["update-ref", "--stdin"], `start\n${commands.join("\n")}\nprepare\ncommit\n`);
}
