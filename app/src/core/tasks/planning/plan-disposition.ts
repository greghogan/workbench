import { createHash, randomUUID } from "node:crypto";
import { replaceRecordStatus } from "../../records/record-document.js";
import { gitBytes } from "../../git/git-snapshot.js";
import { withRepositoryOperation } from "../../git/repository-state.js";
import { withCacheLocksSync } from "../../storage/cache-lock.js";
import { InvalidInput, StateConflict } from "../../runtime/input-errors.js";
import { planningCheckouts } from "./planning-retention.js";
import { readWorkGraph } from "./work-plans.js";
import { changeTaskQueue, readTaskQueue, taskQueuePath } from "../task-queue.js";
import { preparePlanDraftUpdates, savePlanDraft } from "./planning-operations.js";
import { readPlan } from "./planning-store.js";
import { planClaim } from "./plan-operation-store.js";
import type { PlanIdentity } from "./plan-model.js";

export function canceledContents(contents: string, reason: string): string {
  if (reason.length > 16384) throw new InvalidInput("Cancellation reason exceeds 16,384 characters");
  const canceled = replaceRecordStatus(contents, "Canceled").trimEnd();
  return reason.trim() ? canceled + `\n\n## Cancellation\n\n${reason.trim()}\n` : canceled + "\n";
}
export function cancelPlan(root: string, identity: PlanIdentity, expected: string, reason: string) {
  const view = readPlan(root, identity);
  if (view.digest !== expected) throw new StateConflict("Plan changed; inspect it before canceling");
  const checkouts = planningCheckouts(root);
  for (const checkout of checkouts)
    if (
      readTaskQueue(checkout).entries.some(
        (entry) => entry.reference === identity.reference && entry.state === "Active",
      )
    )
      throw new StateConflict("Release active work before canceling its plan");
  const result =
    view.document?.metadata.status === "Canceled"
      ? view
      : savePlanDraft(root, identity, canceledContents(view.contents, reason), { expected });
  withRepositoryOperation(
    root,
    () => {
      if (readPlan(root, identity).digest !== result.digest)
        throw new StateConflict("The plan changed after cancellation; preserving its current queue selections");
      for (const checkout of checkouts)
        if (readTaskQueue(checkout).entries.some((entry) => entry.reference === identity.reference))
          changeTaskQueue(checkout, { action: "remove", reference: identity.reference });
    },
    "planning",
  );
  return result;
}
export function planDeletion(root: string, identity: PlanIdentity) {
  const view = readPlan(root, identity),
    graph = readWorkGraph(root),
    checkouts = planningCheckouts(root),
    incoming = graph.tasks
      .filter((task) => task.parent === identity.reference || task.dependencies.includes(identity.reference))
      .map((task) => task.reference),
    queued = checkouts.filter((checkout) =>
      readTaskQueue(checkout).entries.some((entry) => entry.reference === identity.reference),
    ),
    problems = [
      ...(view.conflict ? ["Resolve concurrent edits before deleting the plan"] : []),
      ...(planClaim(root, identity.reference)
        ? ["The implementation task is authoritative; finish its transfer first"]
        : []),
      ...(incoming.length ? [`Preserve incoming relationships first: ${incoming.join(", ")}`] : []),
      ...(queued.length ? [`Remove the plan from its execution queues first: ${queued.join(", ")}`] : []),
    ],
    digest = createHash("sha256")
      .update(JSON.stringify([view.reference, view.digest, incoming, queued, problems]))
      .digest("hex");
  return {
    reference: identity.reference,
    title: view.document?.title ?? view.name,
    digest,
    problems,
    files: [...view.entries.keys()],
    version: view.digest,
  };
}
export function deletePlan(root: string, identity: PlanIdentity, expected: string): string {
  return withRepositoryOperation(
    root,
    () =>
      withCacheLocksSync(planningCheckouts(root).map(taskQueuePath), () => {
        const plan = planDeletion(root, identity);
        if (plan.digest !== expected) throw new StateConflict("Plan deletion changed; inspect it again");
        if (plan.problems.length) throw new StateConflict(plan.problems.join("\n"));
        const view = readPlan(root, identity),
          recovery = `refs/workbench/recovery/plan-deletion/${randomUUID()}/${identity.scope}/${identity.name}`,
          commands = preparePlanDraftUpdates(root, [{ identity, expected: view.digest }]);
        gitBytes(
          root,
          ["update-ref", "--create-reflog", "--stdin"],
          `start\ncreate ${recovery} ${view.tree}\n${commands.join("\n")}\nprepare\ncommit\n`,
        );
        return recovery;
      }),
    "planning",
  );
}
